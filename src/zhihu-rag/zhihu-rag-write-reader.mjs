import "dotenv/config";
import { CheerioWebBaseLoader } from "@langchain/community/document_loaders/web/cheerio";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import {
  DataType,
  IndexType,
  MetricType,
  MilvusClient,
} from "@zilliz/milvus2-sdk-node";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import chalk from "chalk";
import { createHash } from "node:crypto";
/**
 * 从知乎抓取文章
 *
 * 你会看到这里“看起来像是爬虫”，但它其实是在为 RAG 做“数据接入”：
 * - Loader 负责：把网页变成你能处理的 HTML/DOM
 * - 解析负责：把 HTML/DOM 变成干净的正文文本（+ 图片链接）
 * - 后续才能：切分 -> embedding -> 写入 Milvus -> 检索 -> 生成回答
 *
 * 为什么用 CheerioWebBaseLoader：
 * - 它的核心能力是：fetch 网页 + 用 cheerio 解析成类似 jQuery 的 $（可用 CSS selector）
 * - 适合“静态 HTML / SSR 页面”的抓取（不需要执行浏览器 JS）
 * - 若目标网页强依赖 JS 渲染，Cheerio 可能拿不到正文，需要换 Puppeteer 方案（后面可扩展）
 */

/**
 * 第二步：文本清洗（Text Cleaning）
 *
 * 清洗目的（面向 RAG）：
 * - 降噪：去掉“对检索/问答没有帮助”的内容，减少 embedding 成本与误召回
 * - 统一格式：把换行/空白变得可控，避免切分器把同一段切成碎片
 * - 保留语义：尽量不改动原文含义（不要做“改写/总结”，那是 LLM 的事）
 *
 * 我们通常要清洗掉什么：
 * - 纯 UI 文案：如“点赞/收藏/分享/举报/展开全文”等
 * - 连续空白/过多换行/不可见字符（\u00a0 等）
 * - 重复的空行、重复的同一句（有些站点会重复渲染）
 * - 过短且无信息的行（例如只有一个标点或单个字）
 *
 * 我们要保留什么：
 * - 正文段落的自然顺序（重要：顺序会影响上下文连贯性）
 * - 图片的“占位信息”（用 Markdown 图片语法）：
 *   - embedding 看不懂图片内容，但它能保留“这里有图/图的 alt 文本/图的 URL”作为线索
 *   - 如果你后续做 OCR 或多模态，再把图片内容补进来
 */
function cleanContentParts(rawParts, { keepImages = true } = {}) {
  // 这个函数做的事情可以理解成：把“原始抓取片段 rawParts”变成“可用于 RAG 的干净片段 cleanedParts”。
  //
  // 为什么要在“切分/向量化”之前做清洗：
  // - embedding 很贵：把噪音也向量化，会白花钱
  // - 检索会被污染：噪音也进入向量库，TopK 更容易召回无关内容
  // - 切分会变差：杂乱空白/重复段落会让 chunk 粒度不稳定
  //
  // 这个清洗器遵循一个原则：只做“格式/噪音处理”，不做“改写/总结”。
  // - 改写/总结属于 LLM 的工作，会改变原文语义，容易把“证据”变得不可追溯
  // - RAG 更希望你存的是“原始证据”，让回答可引用、可核对

  // 1) UI 噪音模式：用于过滤网页里的“互动/按钮/元信息”等文案。
  // 这些内容会干扰语义检索（例如你问“动量”，却召回“点赞/收藏/评论”）。
  const uiNoisePatterns = [
    /^(赞同|喜欢|收藏|分享|举报|发布于|编辑于|赞|踩)\b/,
    /^(\d+)?\s*(赞同|点赞|收藏|分享|评论)\b/,
    /^(展开阅读全文|收起|查看全部|继续阅读)$/i,
  ];

  // 2) 行归一化（normalize）：统一空白形态，避免“同一句话因为空格不同而无法去重/匹配”。
  // - \u00a0 是网页里常见的“不间断空格”，看起来像空格但会影响处理
  // - \s+ 合并：把多空格/换行/tab 等压成单空格，让切分更稳定
  const normalizeLine = (s) =>
    s
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  // 3) cleaned：清洗后的片段列表（保持原始顺序）
  // 4) seen：用于“完全一致去重”
  // - 只做完全一致去重，不做语义去重：语义去重容易误删有价值的细节句
  const cleaned = [];
  const seen = new Set();

  // 5) 主循环：逐条处理 rawParts（可能包含：段落文本、图片 Markdown 占位）
  for (const part of rawParts) {
    if (!part) continue;

    // 6) 判断是否为图片占位（Markdown 形式：![alt](url)）
    // - 图片在 embedding 中不会被“看懂”，但它能作为“这里有图”的上下文线索
    // - 你可以用 keepImages 控制是否保留图片占位（默认保留）
    const isImage =
      part.startsWith("![") && part.includes("](") && part.endsWith(")");
    if (isImage && !keepImages) continue;

    // 7) 格式归一化；归一化后为空则跳过
    const line = normalizeLine(part);
    if (!line) continue;

    if (!isImage) {
      // 8) 仅对“文本行”做 UI 噪音过滤（图片占位不走这套规则）
      let isNoise = false;
      for (const p of uiNoisePatterns) {
        if (p.test(line)) {
          isNoise = true;
          break;
        }
      }
      if (isNoise) continue;

      // 太短的文本通常对语义检索没价值（比如“嗯”“好”“…”），这里直接丢弃
      // 图片占位（![alt](url)）不受此规则影响
      if (line.length < 3) continue;
    }

    // 简单去重：同一行内容重复出现时，只保留第一次
    // 注意：这里是“完全一致”去重，不会做语义去重，避免误删
    if (seen.has(line)) continue;
    seen.add(line);
    cleaned.push(line);
  }

  return cleaned;
}

/**
 * 第三步：分块（Chunking / Text Splitting）
 *
 * 目标：
 * - 把一篇长文章切成很多个“小块 chunk”，方便后续：
 *   1) 逐块做 embedding（避免超出模型输入限制，且更省钱）
 *   2) 检索粒度更细（你问一个点，只需要召回相关 chunk，而不是整篇文章）
 *
 * 关键参数：
 * - chunkSize：每块的大致长度（这里用“字符数”理解就行）
 * - chunkOverlap：块之间重叠长度（避免“关键句刚好被切断”造成语义丢失）
 *
 * 为什么用 RecursiveCharacterTextSplitter：
 * - 它会按 separators 优先级“递归拆分”，尽量在自然边界切（段落/换行/句号等）
 * - 比起硬切（每 N 字一刀）更不容易把一句话切成两半
 */
async function splitToChunks(text) {
  const chunkSize = Number(process.env.CHUNK_SIZE || "500");
  const chunkOverlap = Number(process.env.CHUNK_OVERLAP || "50");

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
    separators: ["\n\n", "\n", "。", "！", "？", "；", "，", " ", ""],
  });

  // splitText：输入一个长字符串，输出 string[]（每个元素就是一个 chunk）
  const chunks = await splitter.splitText(text);
  return { chunks, chunkSize, chunkOverlap };
}

/**
 * 第四步：写入 Milvus（Embedding + Insert + Flush）
 *
 * Milvus 在 RAG 里的定位：
 * - 你可以把它理解成“向量索引的数据库表”
 * - 每条记录里存两类信息：
 *   1) vector：文本的向量（用于相似度检索）
 *   2) scalar fields：原文与元数据（用于展示、过滤、溯源）
 *
 * 为什么“先建表/建索引/加载，再插入”：
 * - schema 决定你能存哪些字段，以及 vector 的维度 dim 必须固定
 * - index 决定检索性能与召回（IVF_FLAT 是常见入门选择）
 * - load 决定检索/插入后的可用性（更稳定）
 */
const mustEnvAny = (names, label) => {
  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }
  throw new Error(`缺少环境变量：${label}\n已尝试：${names.join(" / ")}`);
};

const optionalEnvAny = (names) => {
  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }
  return undefined;
};

function stableDocIdFromUrl(url) {
  // 用 URL 生成一个稳定的短 id，便于你反复跑脚本时定位同一篇文章
  // 这里用 sha1 的前 12 位，够用且可读
  return createHash("sha1").update(url).digest("hex").slice(0, 12);
}

function parseCliArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const [k, vRaw] = a.slice(2).split("=", 2);
    const next = argv[i + 1];
    const v =
      vRaw !== undefined ? vRaw
      : next && !next.startsWith("--") ? next
      : true;
    args[k] = v;
    if (v === next) i++;
  }
  return args;
}

function printUsageAndExit() {
  const lines = [
    "用法：",
    "  node src/zhihu-rag/zhihu-rag-write-reader.mjs --url <知乎文章URL> --question <问题> [--mode all|ingest|rag]",
    "",
    "示例：",
    '  node src/zhihu-rag/zhihu-rag-write-reader.mjs --url "https://zhuanlan.zhihu.com/p/1993469340872377578" --question "结构突破和动量的关系是什么？"',
    "",
    "模式说明：",
    "  --mode=all     抓取+清洗+分块+写入Milvus+RAG回答（默认）",
    "  --mode=ingest  只抓取+清洗+分块+写入Milvus（不问答）",
    "  --mode=rag     只做RAG回答（不重新抓取/写入；要求该URL已写入Milvus）",
    "",
    "常用可选项：",
    "  --noUrlFilter  RAG检索时不按 source_url 过滤（跨文章检索）",
    "",
    "环境变量（与项目其他脚本一致）：",
    "  MILVUS_ADDRESS / MILVUS_COLLECTION / API_KEY(或OPENAI_API_KEY) / BASE_URL(或OPENAI_BASE_URL) / EMBEDDINGS_MODEL_NAME / MODEL_NAME",
    "  COOKIE（可选，仅本机使用，别泄露）",
  ];
  console.log(lines.join("\n"));
  process.exit(1);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectMilvusWithRetry(client, address) {
  // 解决常见报错：
  // "Milvus Proxy is not ready yet. please wait"
  //
  // 原因：容器刚启动时，19530 端口可能已经开放，但 Proxy 还没就绪。
  // 做法：连接 + 轻量 RPC 探测，失败则退避重试。
  const maxAttempts = Number(process.env.MILVUS_CONNECT_RETRIES || "12");
  const baseDelayMs = Number(
    process.env.MILVUS_CONNECT_RETRY_DELAY_MS || "1500",
  );

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await client.connectPromise;
      // 用一个轻量 API 做“就绪探测”：
      // 如果 Proxy 未就绪，这里通常会抛出 "not ready yet"
      await client.hasCollection({ collection_name: "_health_probe_" });
      return;
    } catch (e) {
      lastError = e;
      const msg = String(e?.message || e || "").toLowerCase();
      const retryable =
        msg.includes("not ready yet") ||
        msg.includes("service unavailable") ||
        msg.includes("unavailable") ||
        msg.includes("connection refused") ||
        msg.includes("deadline exceeded");

      if (!retryable || attempt === maxAttempts) {
        break;
      }

      const waitMs = baseDelayMs * attempt;
      console.log(
        chalk.yellow(
          `Milvus 尚未就绪（attempt ${attempt}/${maxAttempts}），${waitMs}ms 后重试...`,
        ),
      );
      await sleep(waitMs);
    }
  }

  throw new Error(
    [
      `Milvus 连接失败：${String(lastError?.message || lastError || "unknown")}`,
      `address=${address}`,
      "请先确认：",
      "1) docker compose 已启动：docker compose -f milvus-standalone-docker-compose.yml up -d",
      "2) 健康检查通过：curl http://localhost:9091/healthz",
      "3) 如果刚启动，等待 20~60 秒再重试",
      "",
      "也可调大重试参数：",
      "- MILVUS_CONNECT_RETRIES=20",
      "- MILVUS_CONNECT_RETRY_DELAY_MS=2000",
    ].join("\n"),
  );
}

async function ensureCollectionReady({ client, collectionName, dim }) {
  const reset = (process.env.RESET_COLLECTION || "0") === "1";
  const has = await client.hasCollection({ collection_name: collectionName });
  if (has?.value === true && reset) {
    console.log(
      chalk.yellow(
        `RESET_COLLECTION=1，删除旧集合：${collectionName}（方便你反复练习）`,
      ),
    );
    await client.dropCollection({ collection_name: collectionName });
  }

  const existsNow = reset ? { value: false } : has;
  if (existsNow?.value !== true) {
    console.log(chalk.blue(`创建集合：${collectionName}`));

    // schema 设计要点：
    // - id：主键（我们用 docId_chunkIndex 拼出来），保证唯一
    // - source_url/title/chunk_index：用于溯源与过滤（后续检索/展示非常关键）
    // - content：原文 chunk
    // - vector：content 的向量（dim 必须与 embedding 输出一致）
    await client.createCollection({
      collection_name: collectionName,
      fields: [
        {
          name: "id",
          data_type: DataType.VarChar,
          max_length: 200,
          is_primary_key: true,
          auto_id: false,
        },
        {
          name: "source_url",
          data_type: DataType.VarChar,
          max_length: 2048,
        },
        {
          name: "title",
          data_type: DataType.VarChar,
          max_length: 512,
        },
        {
          name: "chunk_index",
          data_type: DataType.Int32,
        },
        {
          name: "content",
          data_type: DataType.VarChar,
          max_length: 10000,
        },
        {
          name: "vector",
          data_type: DataType.FloatVector,
          dim,
        },
      ],
    });

    // 建索引：入门用 IVF_FLAT + COSINE
    // - COSINE：文本语义向量常用度量
    // - nlist：粗聚类桶数量；经验上与数据量相关（这里给默认 1024，后续可调）
    const nlist = Number(process.env.IVF_NLIST || "1024");
    console.log(chalk.blue("创建向量索引（IVF_FLAT + COSINE）"));
    await client.createIndex({
      collection_name: collectionName,
      field_name: "vector",
      index_type: IndexType.IVF_FLAT,
      metric_type: MetricType.COSINE,
      params: { nlist },
    });
  }

  // load：让集合进入可检索状态（不同 SDK 版本有 sync / async 两种）
  console.log(chalk.blue("加载集合（load）"));
  try {
    await client.loadCollectionSync({ collection_name: collectionName });
  } catch {
    try {
      await client.loadCollection({ collection_name: collectionName });
    } catch (e) {
      const msg = String(e?.message || e || "").toLowerCase();
      if (!msg.includes("already loaded")) throw e;
    }
  }
}

function normalizeSearchResults(searchRes) {
  const r = searchRes?.results;
  if (!r) return [];
  if (Array.isArray(r) && r.length > 0 && Array.isArray(r[0])) return r[0];
  return r;
}

async function performSearchWithFallback(client, baseReq) {
  // 兼容不同 SDK 版本的参数命名：data / vectors / vector
  try {
    return await client.search({ ...baseReq, data: baseReq.queryVectors });
  } catch {
    try {
      return await client.search({ ...baseReq, vectors: baseReq.queryVectors });
    } catch {
      return await client.search({
        ...baseReq,
        vector: baseReq.queryVectors[0],
      });
    }
  }
}

function formatContextFromChunks(rows) {
  return rows
    .map((r, i) => {
      return [
        `【参考片段 ${i + 1}】`,
        `source_url: ${r.source_url}`,
        `title: ${r.title}`,
        `chunk_index: ${r.chunk_index}`,
        `content: ${r.content}`,
      ].join("\n");
    })
    .join("\n\n---\n\n");
}

function extractMarkdownImages(text) {
  const re = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const images = [];
  const seen = new Set();
  for (const m of text.matchAll(re)) {
    const alt = (m[1] || "").trim();
    const url = (m[2] || "").trim();
    if (!url) continue;
    const key = `${alt}@@${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    images.push({ alt, url });
  }
  return images;
}

function formatImagesForPrompt(images) {
  if (!images || images.length === 0) return "（无）";
  return images.map((img) => `- ![${img.alt}](${img.url})`).join("\n");
}

function buildRagPrompt({ question, context, imagesText }) {
  return (
    "你是一个严谨的中文助手，只能基于【参考片段】回答问题。\n" +
    "如果【参考片段】里没有明确依据，请回复：不知道，并说明缺少哪些信息。\n" +
    "回答时尽量引用你依据的片段编号（例如：参考片段 2）。\n\n" +
    "如果【参考片段】里包含图片（Markdown 形式：![alt](url)），请你在回答末尾追加一个【图片列表】小节，原样输出这些图片链接。\n" +
    "如果没有图片，请在【图片列表】里输出：无。\n\n" +
    `【参考片段】\n${context}\n\n` +
    `【已提取的图片列表（供你核对，仍需以参考片段为准）】\n${imagesText}\n\n` +
    `【问题】\n${question}\n\n` +
    "【回答】\n"
  );
}

async function ragAnswerFromMilvus({ question, sourceUrl }) {
  // 第五步：RAG 问答（Retrieve -> Augment -> Generate）
  //
  // 你现在已经完成了：
  // - 抓取网页 -> 清洗 -> 分块 -> 写入 Milvus
  //
  // RAG 问答做的事是：
  // 1) 把问题 question 向量化（embedding）
  // 2) 在 Milvus 里检索最相关的 chunks（Retrieval）
  // 3) 把 chunks 拼成 context（Augment）
  // 4) 把 question + context 发给大模型生成回答（Generation）
  const milvusAddress = process.env.MILVUS_ADDRESS || "127.0.0.1:19530";
  const collectionName = process.env.MILVUS_COLLECTION || "zhihu_articles";
  const milvusClient = new MilvusClient({ address: milvusAddress });

  console.log(chalk.blue(`连接 Milvus：${milvusAddress}`));
  await connectMilvusWithRetry(milvusClient, milvusAddress);
  console.log(chalk.green("✓ Milvus 已连接"));

  console.log(chalk.blue("加载集合（load）"));
  try {
    await milvusClient.loadCollectionSync({ collection_name: collectionName });
  } catch {
    try {
      await milvusClient.loadCollection({ collection_name: collectionName });
    } catch (e) {
      const msg = String(e?.message || e || "").toLowerCase();
      if (!msg.includes("already loaded")) throw e;
    }
  }

  // embeddings + chat 模型初始化
  const apiKey = mustEnvAny(["OPENAI_API_KEY", "API_KEY"], "OpenAI API Key");
  const baseURL = optionalEnvAny(["OPENAI_BASE_URL", "BASE_URL"]);
  const embeddingsModel = mustEnvAny(
    ["EMBEDDINGS_MODEL_NAME"],
    "向量模型名（EMBEDDINGS_MODEL_NAME）",
  );
  const chatModel = mustEnvAny(["MODEL_NAME"], "对话模型名（MODEL_NAME）");

  const batchSize = Number(process.env.EMBEDDINGS_BATCH_SIZE || "10");
  const embeddings = new OpenAIEmbeddings({
    apiKey,
    model: embeddingsModel,
    configuration: baseURL ? { baseURL } : undefined,
    batchSize,
  });
  const llm = new ChatOpenAI({
    apiKey,
    model: chatModel,
    configuration: baseURL ? { baseURL } : undefined,
    temperature: 0,
  });

  // 检索：问题向量
  const topK = Number(process.env.TOPK || "5");
  const nprobe = Number(process.env.IVF_NPROBE || "16");
  const queryVectors = [await embeddings.embedQuery(question)];

  // 过滤：只在当前 sourceUrl 这篇文章里检索（避免不同网页混在一个库里后互相干扰）
  const filter =
    sourceUrl ?
      `source_url == "${sourceUrl.replaceAll('"', '\\"')}"`
    : undefined;

  const baseReq = {
    collection_name: collectionName,
    queryVectors,
    limit: topK,
    output_fields: ["source_url", "title", "chunk_index", "content"],
    metric_type: MetricType.COSINE,
    params: { nprobe },
    ...(filter ? { filter } : {}),
  };

  console.log(chalk.yellow("\n[Step 6/??] Retrieval：从 Milvus 检索相关片段"));
  console.log(chalk.red(`问题：${question}`));
  if (filter) console.log(chalk.gray(`filter: ${filter}`));

  const searchRes = await performSearchWithFallback(milvusClient, baseReq);
  const results = normalizeSearchResults(searchRes);
  console.log(chalk.green(`✓ 检索完成：TopK=${topK}，命中=${results.length}`));
  results.forEach((r, i) => {
    console.log(
      chalk.cyan(
        `[Top ${i + 1}] score=${r.score} chunk_index=${r.chunk_index} title=${r.title}`,
      ),
    );
  });

  const context = formatContextFromChunks(results);
  const images = extractMarkdownImages(context);
  const imagesText = formatImagesForPrompt(images);
  const prompt = buildRagPrompt({ question, context, imagesText });

  console.log(chalk.yellow("\n[Step 6/??] Generation：基于检索片段生成回答"));
  const resp = await llm.invoke(prompt);
  console.log(chalk.green("\nAI 回答："));
  console.log(resp.content);
}

async function writeChunksToMilvus({ url, title, chunks }) {
  // 1) 初始化 Milvus 客户端
  const milvusAddress = process.env.MILVUS_ADDRESS || "127.0.0.1:19530";
  const collectionName = process.env.MILVUS_COLLECTION || "zhihu_articles";
  const milvusClient = new MilvusClient({ address: milvusAddress });

  console.log(chalk.blue(`连接 Milvus：${milvusAddress}`));
  await connectMilvusWithRetry(milvusClient, milvusAddress);
  console.log(chalk.green("✓ Milvus 已连接"));

  // 2) 初始化 embeddings
  // 注意：这里尽量与项目其他脚本保持一致的环境变量命名（兼容 OPENAI_* 与 API_KEY/BASE_URL）
  const apiKey = mustEnvAny(["OPENAI_API_KEY", "API_KEY"], "OpenAI API Key");
  const baseURL = optionalEnvAny(["OPENAI_BASE_URL", "BASE_URL"]);
  const embeddingsModel = mustEnvAny(
    ["EMBEDDINGS_MODEL_NAME"],
    "向量模型名（EMBEDDINGS_MODEL_NAME）",
  );

  // batchSize：很多服务端会限制一次 embedding 最多多少条（你项目里常见限制是 10）
  const batchSize = Number(process.env.EMBEDDINGS_BATCH_SIZE || "10");
  const embeddings = new OpenAIEmbeddings({
    apiKey,
    model: embeddingsModel,
    configuration: baseURL ? { baseURL } : undefined,
    batchSize,
  });

  if (chunks.length === 0) {
    console.log(chalk.yellow("没有可写入的 chunks，跳过写入。"));
    return;
  }

  // 3) 先用第一条 chunk 推断 dim（Milvus 建表必须固定 dim）
  console.log(
    chalk.blue("推断向量维度 dim（用第一条 chunk 做一次 embedding）"),
  );
  const dim = (await embeddings.embedQuery(chunks[0])).length;
  console.log(chalk.green(`✓ dim=${dim}`));

  // 4) 确保集合存在 + 索引 + load
  await ensureCollectionReady({
    client: milvusClient,
    collectionName,
    dim,
  });
  console.log(chalk.green(`✓ 集合就绪：${collectionName}`));

  // 5) 批量 embedding + 批量 insert
  const docId = stableDocIdFromUrl(url);
  const maxContentLength = 10000;
  let inserted = 0;

  console.log(chalk.yellow("\n[Step 4/??] Embedding + Insert"));
  for (let start = 0; start < chunks.length; start += batchSize) {
    const batchChunks = chunks.slice(start, start + batchSize);

    // embedDocuments：一次性对多条文本做 embedding，比多次 embedQuery 更省网络往返
    const vectors = await embeddings.embedDocuments(batchChunks);

    const data = batchChunks.map((c, i) => {
      // 防御：content 超过 schema 的 max_length 时截断
      const content =
        c.length > maxContentLength ? c.slice(0, maxContentLength) : c;
      const chunkIndex = start + i;
      return {
        id: `${docId}_${chunkIndex}`,
        source_url: url,
        title: title || "",
        chunk_index: chunkIndex,
        content,
        vector: vectors[i],
      };
    });

    const res = await milvusClient.insert({
      collection_name: collectionName,
      data,
    });
    inserted += Number(res?.insert_cnt || 0);
    console.log(
      chalk.gray(
        `- inserted batch: [${start}-${start + batchChunks.length - 1}] insert_cnt=${res?.insert_cnt ?? "unknown"}`,
      ),
    );
  }

  // 6) flush：让数据持久化并更稳定地参与索引/检索
  console.log(chalk.blue("flush（持久化数据）"));
  try {
    await milvusClient.flushSync({ collection_names: [collectionName] });
  } catch {
    await milvusClient.flushCollection({ collection_name: collectionName });
  }

  console.log(
    chalk.green(
      `✓ 写入完成：inserted=${inserted} collection=${collectionName}`,
    ),
  );
}

async function getZhihuArticle(url) {
  // 你想抓取的 DOM 根节点：
  // - 你的目标是抓 #content 下的文本和图片，因此这里默认写 #content
  // - 如果目标网页结构变化，建议改成更稳的容器，例如：
  //   "article, .Post-RichText, .RichText"
  // - 这个 rootSelector 只决定“从哪里开始抽”，真正抽取的是 root 内的 p/img
  const rootSelector = process.env.ROOT_SELECTOR || ".Post-Main";

  // 知乎等站点可能会：
  // - 对非浏览器 UA 返回简化/空内容
  // - 对未登录用户返回“登录页/验证页”
  // 因此这里模拟浏览器请求头，尽量提高拿到正文 HTML 的概率。
  //
  // Cookie 的作用：
  // - 如果你的浏览器能正常看到全文，但脚本抓不到，通常就是需要登录态（Cookie）
  // - Cookie 非常敏感：只放在本机环境变量里用，绝对不要提交到代码仓库，也不要发给别人
  const cookie = process.env.COOKIE;
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Referer: "https://www.zhihu.com/",
    ...(cookie ? { Cookie: cookie } : {}),
  };

  // 注意：这里 selector 传的是 rootSelector（例如 #content），不是 "#content p,#content img"
  // 原因是：
  // 1) CheerioWebBaseLoader.load() 主要是抽取文本（pageContent），img 没有 text，图片信息会丢
  // 2) 我们需要“DOM”，才能读取 img 的 src/data-src 等属性
  //
  // 所以我们选择：
  // - 用 loader.scrape() 拿到 cheerio 的 $（DOM 级能力）
  // - 再自己在 rootSelector 内 find("p, img")，逐个提取文本/图片
  const loader = new CheerioWebBaseLoader(url, {
    selector: rootSelector,
    headers,
  });
  let $;
  try {
    // scrape() 会：
    // - 发起 HTTP 请求
    // - 把返回的 HTML 用 cheerio 解析
    // - 返回一个 $（类似 jQuery），你可以 $(selector).find(...)
    $ = await loader.scrape();
  } catch (e) {
    console.error(e);
  }

  // title 只是辅助信息，方便你验证抓到的是不是目标网页（以及后续做 metadata）
  const titleSelector = process.env.TITLE_SELECTOR || ".Post-Title";
  const title = $(titleSelector).text().trim() || $("title").text().trim();
  let root = $(rootSelector).first();
  if (root.length === 0) {
    // 兜底：知乎专栏文章常见的正文容器
    root = $(".Post-RichTextContainer").first();
  }
  if (root.length === 0) {
    throw new Error(
      `未找到正文容器：ROOT_SELECTOR=${rootSelector}，也未命中 .Post-RichTextContainer`,
    );
  }

  // parts：按原网页顺序拼接出的“可用于后续分块/向量化”的内容
  // images：单独把图片列表拿出来（后面你可以做 OCR、或只保留 src）
  const parts = [];
  const images = [];

  // 只抓两种节点：
  // - p：正文段落
  // - img：图片
  // 这样做的好处是：内容更干净，不会把导航/按钮/侧边栏抓进来，RAG 检索更准确
  root.find("p, img").each((_, el) => {
    const node = $(el);
    if (el.tagName === "p") {
      // 正文段落清洗：
      // - 多个空白合并为 1 个空格
      // - 去掉首尾空白
      // 这样后续切分更稳定，embedding 的输入更干净
      const t = node.text().replace(/\s+/g, " ").trim();
      if (t) parts.push(t);
      return;
    }

    // 图片链接提取（按优先级尝试多个属性）：
    // - 许多站点会把真实图片放在 data-original / data-src，而 src 可能是占位图
    // - 所以这里按常见顺序依次尝试，尽量拿到“真实图片 URL”
    const src =
      node.attr("data-original") ||
      node.attr("data-actualsrc") ||
      node.attr("data-src") ||
      node.attr("src");
    if (!src) return;

    const alt = (node.attr("alt") || "").trim();
    images.push({ src, alt });

    // 把图片也写进 content（用 Markdown 图片语法）：
    // - 好处：后续你把 content 切分后存向量库时，图片位置也能作为上下文线索
    // - 注意：embedding 模型对 Markdown 图片本身不会“看懂图片内容”，它只会把链接当作文本
    //   如果你希望“问图片内容也能回答”，需要引入 OCR 或多模态模型（后续可扩展）
    parts.push(`![${alt}](${src})`);
  });

  // 最终用于后续 RAG 的正文内容（文本 + 图片链接）
  // 如果 content 为空，常见原因是：没命中正文容器 or 返回的是登录/验证页
  const cleanedParts = cleanContentParts(parts, {
    keepImages: (process.env.KEEP_IMAGES || "1") === "1",
  });
  const content = cleanedParts.join("\n\n").trim();
  if (!content) {
    throw new Error("抓到的正文为空（可能被反爬/需要登录/正文选择器不匹配）");
  }

  return { url, title, content, images };
}

async function main() {
  try {
    const cli = parseCliArgs(process.argv.slice(2));
    if (cli.help || cli.h) printUsageAndExit();

    const mode = String(cli.mode || process.env.MODE || "all").toLowerCase();
    const url = String(cli.url || process.env.ZHIHU_URL || "");
    const question = String(
      cli.question ||
        process.env.QUESTION ||
        "这篇文章里，结构突破和动量的关系是什么？",
    );
    const noUrlFilter = cli.noUrlFilter === true || cli.noUrlFilter === "true";

    if (!url) {
      printUsageAndExit();
    }

    if (mode === "rag") {
      console.log(chalk.blue("模式：RAG（不重新抓取/写入）"));
      await ragAnswerFromMilvus({
        question,
        sourceUrl: noUrlFilter ? undefined : url,
      });
      return;
    }

    console.log(chalk.blue("模式：抓取 -> 清洗 -> 分块"));
    const { title, content, images } = await getZhihuArticle(url);
    console.log(chalk.green(`✓ 标题：${title || "（无）"}`));
    console.log(chalk.green(`✓ 文本长度：${content.length}`));
    console.log(chalk.green(`✓ 图片数量：${images.length}`));

    console.log(chalk.yellow("\n[Step 3/??] 分块（Chunking）"));
    const { chunks, chunkSize, chunkOverlap } = await splitToChunks(content);
    const avgLen =
      chunks.length === 0 ?
        0
      : Math.round(chunks.reduce((s, c) => s + c.length, 0) / chunks.length);
    console.log(
      chalk.green(
        `✓ 分块完成：chunks=${chunks.length}（chunkSize=${chunkSize}, chunkOverlap=${chunkOverlap}, avgLen≈${avgLen}）`,
      ),
    );

    const previewCount = Math.min(2, chunks.length);
    for (let i = 0; i < previewCount; i++) {
      console.log(chalk.cyan(`\n--- chunk #${i + 1}/${chunks.length} ---`));
      console.log(chunks[i]);
    }

    console.log(
      chalk.yellow("\n[Step 4/??] 写入 Milvus（Embedding + Insert）"),
    );
    await writeChunksToMilvus({ url, title, chunks });

    if (mode === "ingest") {
      console.log(chalk.blue("模式：ingest（已写入 Milvus，跳过问答）"));
      return;
    }

    console.log(chalk.yellow("\n[Step 6/??] RAG 问答"));
    await ragAnswerFromMilvus({
      question,
      sourceUrl: noUrlFilter ? undefined : url,
    });
  } catch (error) {
    console.error(error);
  }
}

main();
