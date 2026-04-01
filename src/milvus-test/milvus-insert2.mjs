import "dotenv/config";
import {
  MilvusClient,
  DataType,
  MetricType,
  IndexType,
} from "@zilliz/milvus2-sdk-node";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import chalk from "chalk";

// 学习目标（一步一步跑通 Milvus 常用闭环）：
// 连接 -> 准备数据 -> 生成向量 -> 设计表结构 -> 创建集合 -> 建索引 -> 加载 -> 插入 -> flush -> 搜索(+过滤)
//
// 为什么这么设计：
// - 先生成向量并“推断 dim”（维度），再建表：避免“表的 dim 和向量长度不一致”这个常见坑
// - 建索引 + load：让检索性能稳定且更快（大数据量场景尤为关键）
// - 搜索时加 filter：真实业务常常“先用标量条件缩小候选集，再做向量检索”
//
// 模式说明：
// - 本脚本固定使用“真实文本向量”（embedding），不再提供随机向量模式
// - 好处：你看到的搜索结果具备语义意义，更贴近真实 RAG 场景

const COLLECTION_NAME = process.env.MILVUS_COLLECTION || "ai_diary";
const VECTOR_DIM_ENV = process.env.VECTOR_DIM; // 可选：如果模型支持指定维度（如 t-e-3-large），你也可以显式指定
const RESET_COLLECTION = (process.env.RESET_COLLECTION || "1") === "1"; // 反复练习时更友好
const IVF_NLIST = Number(process.env.IVF_NLIST || "1024"); // 索引聚类桶数量
const IVF_NPROBE = Number(process.env.IVF_NPROBE || "16"); // 搜索时探测桶数量
const TOPK = Number(process.env.TOPK || "3"); // 搜索返回条数

const requireEnvAny = (names, label) => {
  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }
  throw new Error(`缺少环境变量：${label}\n已尝试：${names.join(" / ")}`);
};

// 初始化 embeddings（必需）
const apiKey = requireEnvAny(["OPENAI_API_KEY", "API_KEY"], "OpenAI API Key");
const baseURL = process.env.OPENAI_BASE_URL || process.env.BASE_URL;
const embeddingsModelName = requireEnvAny(
  ["EMBEDDINGS_MODEL_NAME"],
  "向量模型名（EMBEDDINGS_MODEL_NAME）",
);
const chatModelName = requireEnvAny(["MODEL_NAME"], "对话模型名（MODEL_NAME）");
const dimensions =
  VECTOR_DIM_ENV && Number.isFinite(Number(VECTOR_DIM_ENV)) ?
    Number(VECTOR_DIM_ENV)
  : undefined;
// 说明：只有部分模型支持 dimensions 参数（例如 OpenAI 的 text-embedding-3 系列）。
// 如果模型不支持传维度，传了会报错；删掉 VECTOR_DIM 环境变量即可。
const embeddings = new OpenAIEmbeddings({
  apiKey,
  model: embeddingsModelName,
  configuration: baseURL ? { baseURL } : undefined,
  ...(dimensions ? { dimensions } : {}),
  batchSize: 10,
});

const llm = new ChatOpenAI({
  apiKey,
  model: chatModelName,
  temperature: 0,
  configuration: baseURL ? { baseURL } : undefined,
});

const client = new MilvusClient({
  address: "localhost:19530",
});

async function getEmbedding(text) {
  // 把文本变向量（RAG 的关键一步）
  // 真实场景：用 embedDocuments 批量生成，减少网络往返；这里用 embedQuery 更直观
  const result = await embeddings.embedQuery(text);
  return result; // number[]，长度即为向量维度 dim
}

async function inferVectorsAndDim(diaryList) {
  // 返回：{ vectors: number[][], dim: number }
  const vecs = [];
  for (const d of diaryList) {
    vecs.push(await getEmbedding(d.content));
  }
  const inferred = vecs[0]?.length;
  if (!inferred) {
    throw new Error("无法从 embedding 结果推断向量维度 dim");
  }
  if (VECTOR_DIM_ENV && Number(VECTOR_DIM_ENV) !== inferred) {
    console.warn(
      `提示：你设置了 VECTOR_DIM=${VECTOR_DIM_ENV}，但模型实际输出 dim=${inferred}。已以模型输出为准。`,
    );
  }
  return { vectors: vecs, dim: inferred };
}

function normalizeSearchResults(searchRes) {
  const r = searchRes?.results;
  if (!r) return [];
  if (Array.isArray(r) && r.length > 0 && Array.isArray(r[0])) return r[0];
  return r;
}

function formatContextFromDiaries(rows) {
  // RAG 的 A：Augment（把检索到的内容拼成上下文 context）
  //
  // 为什么要拼 context：
  // - LLM 不会自动“看到数据库里的内容”，你必须把资料放进 prompt
  // - 结构化的格式（包含日期/心情/标签）能帮助模型做更可靠的归纳总结
  return rows
    .map((r, i) => {
      const tags = Array.isArray(r.tags) ? JSON.stringify(r.tags) : "[]";
      return [
        `【日记片段 ${i + 1}】`,
        `id: ${r.id}`,
        `date: ${r.date}`,
        `mood: ${r.mood}`,
        `tags: ${tags}`,
        `content: ${r.content}`,
      ].join("\n");
    })
    .join("\n\n---\n\n");
}

function buildRagPrompt({ question, context }) {
  // Prompt 的关键目标：
  // 1) 只能基于“参考资料”回答（减少幻觉）
  // 2) 资料不足时明确说不知道（可控失败）
  // 3) 让答案更可追溯：要求引用片段编号
  return (
    "你是一个耐心的中文助手，只能基于【日记片段】回答问题。\n" +
    "如果【日记片段】里没有明确依据，请回复：不知道，并说明缺少哪些信息。\n" +
    "回答时尽量引用你依据的片段编号（例如：日记片段 2）。\n\n" +
    `【日记片段】\n${context}\n\n` +
    `【问题】\n${question}\n\n` +
    "【回答】"
  );
}

async function performSearchWithFallback(baseReq) {
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

async function ensureCollectionLoaded({ collection_name }) {
  // Milvus 的集合需要处于“loaded”状态，才能稳定地进行检索。
  //
  // 常见情况：
  // - 第一次运行脚本：collection 未加载 -> 需要 load
  // - 反复运行脚本：collection 可能已经 loaded -> 再 load 可能会抛错（各版本 SDK/服务端报错信息略有差异）
  //
  // 这里做一个“尽量兼容”的处理：
  // - 优先调用 loadCollectionSync：确保返回时已加载完成（更稳定）
  // - 如果没有 sync 版本就降级到 loadCollection
  // - 如果报错但错误信息表示“已加载”，则忽略该错误
  const isAlreadyLoadedError = (e) => {
    const msg = String(e?.message || e || "").toLowerCase();
    return (
      msg.includes("already loaded") ||
      msg.includes("already_loaded") ||
      msg.includes("already been loaded")
    );
  };
  try {
    await client.loadCollectionSync({ collection_name });
    console.log(chalk.green("✓ Collection loaded (sync)"));
  } catch (e1) {
    if (isAlreadyLoadedError(e1)) {
      console.log(chalk.green("✓ Collection already loaded"));
      return;
    }
    try {
      await client.loadCollection({ collection_name });
      console.log(chalk.green("✓ Collection loaded"));
    } catch (e2) {
      if (isAlreadyLoadedError(e2)) {
        console.log(chalk.green("✓ Collection already loaded"));
        return;
      }
      throw e2;
    }
  }
}

function printSearchResults(results, { title, showContent = true } = {}) {
  if (title) console.log(chalk.yellow(title));
  if (!results || results.length === 0) {
    console.log(chalk.gray("（无结果）"));
    return;
  }
  results.forEach((r, i) => {
    console.log(
      chalk.cyan(
        `[Top ${i + 1}] score=${r.score} id=${r.id} date=${r.date} mood=${r.mood} tags=${JSON.stringify(
          r.tags,
        )}`,
      ),
    );
    if (showContent) {
      console.log(chalk.gray(r.content));
    }
    console.log("");
  });
}

async function searchByText({
  collectionName,
  queryText,
  limit,
  outputFields,
  filter,
  nprobe,
}) {
  // 把“自然语言 query”转成向量，然后用向量去 Milvus 做相似度检索。
  //
  // 这一步是“检索（Retrieval）”的核心：
  // - 对 RAG：检索出的结果会作为后续 prompt 的参考资料
  // - 对纯检索：你可以直接把结果展示给用户（例如知识库/ebook 段落召回）
  const queryVector = await getEmbedding(queryText);
  const queryVectors = [queryVector];

  // Milvus search 关键参数解释：
  // - collection_name：表名
  // - limit：返回 TopK 条相似结果
  // - output_fields：除了 score 以外，还要把哪些字段一起带回来（比如原文 content / 元数据）
  // - metric_type：相似度度量（COSINE/IP/L2），一般要与索引创建时一致
  // - params.nprobe：IVF 系列索引在搜索时探测多少个桶；越大召回越好但越慢
  // - filter：标量过滤表达式（先过滤再向量检索），可以显著降低误召回、提升相关性
  const baseReq = {
    collection_name: collectionName,
    queryVectors,
    limit,
    output_fields: outputFields,
    metric_type: MetricType.COSINE,
    params: { nprobe },
    ...(filter ? { filter } : {}),
  };

  const searchRes = await performSearchWithFallback(baseReq);
  return normalizeSearchResults(searchRes);
}

async function main() {
  try {
    console.log(chalk.blue("Connecting to Milvus (localhost:19530)..."));
    await client.connectPromise;
    console.log(chalk.green("✓ Connected\n"));

    // 1) 准备“日记数据”（只有 content 需要做 embedding；其他字段作为标量存储/过滤）
    const diaryContents = [
      {
        id: "diary_001",
        content:
          "今天天气很好，去公园散步了，心情愉快。看到了很多花开了，春天真美好。",
        date: "2026-01-10",
        mood: "happy",
        tags: ["生活", "散步"],
      },
      {
        id: "diary_002",
        content:
          "今天工作很忙，完成了一个重要的项目里程碑。团队合作很愉快，感觉很有成就感。",
        date: "2026-01-11",
        mood: "excited",
        tags: ["工作", "成就"],
      },
      {
        id: "diary_003",
        content:
          "周末和朋友去爬山，天气很好，心情也很放松。享受大自然的感觉真好。",
        date: "2026-01-12",
        mood: "relaxed",
        tags: ["户外", "朋友"],
      },
      {
        id: "diary_004",
        content:
          "今天学习了 Milvus 向量数据库，感觉很有意思。向量搜索技术真的很强大。",
        date: "2026-01-12",
        mood: "curious",
        tags: ["学习", "技术"],
      },
      {
        id: "diary_005",
        content:
          "晚上做了一顿丰盛的晚餐，尝试了新菜谱。家人都说很好吃，很有成就感。",
        date: "2026-01-13",
        mood: "proud",
        tags: ["美食", "家庭"],
      },
    ];

    // 2) 生成向量并推断 dim（重要！避免 dim 不一致的坑）
    console.log(chalk.yellow("Step 1/4：为日记生成向量（Embeddings）"));
    const { vectors, dim } = await inferVectorsAndDim(diaryContents);
    console.log(
      chalk.green(`✓ Vectors ready: dim=${dim}, count=${vectors.length}\n`),
    );

    console.log(chalk.yellow("Step 2/4：建表 + 建索引 + 加载（Milvus）"));
    // 3) 创建集合（表）前，按需删除旧表（便于反复练习）
    const has = await client.hasCollection({
      collection_name: COLLECTION_NAME,
    });
    if (has?.value === true) {
      if (RESET_COLLECTION) {
        console.log(
          `Dropping existing collection: ${COLLECTION_NAME} (RESET_COLLECTION=1)`,
        );
        await client.dropCollection({ collection_name: COLLECTION_NAME });
      } else {
        console.log(
          `Reusing existing collection: ${COLLECTION_NAME} (RESET_COLLECTION=0)`,
        );
      }
    }

    if (has?.value !== true || RESET_COLLECTION) {
      console.log("Creating collection with proper schema...");
      // 设计表结构（Schema）：
      // - id：VarChar 主键（手工指定更易读）
      // - vector：FloatVector，维度为上一步推断的 dim
      // - content/date/mood：VarChar 标量字段
      // - tags：Array<VarChar>，需要声明 element_type/max_capacity/max_length
      await client.createCollection({
        collection_name: COLLECTION_NAME,
        fields: [
          {
            name: "id",
            data_type: DataType.VarChar,
            max_length: 50,
            is_primary_key: true,
          },
          { name: "vector", data_type: DataType.FloatVector, dim },
          { name: "content", data_type: DataType.VarChar, max_length: 5000 },
          { name: "date", data_type: DataType.VarChar, max_length: 50 },
          { name: "mood", data_type: DataType.VarChar, max_length: 50 },
          {
            name: "tags",
            data_type: DataType.Array,
            element_type: DataType.VarChar,
            max_capacity: 10,
            max_length: 50,
          },
        ],
      });
      console.log("✓ Collection created\n");
    }

    // 创建索引
    console.log("\nCreating index...");
    await client.createIndex({
      collection_name: COLLECTION_NAME,
      field_name: "vector",
      index_type: IndexType.IVF_FLAT,
      metric_type: MetricType.COSINE,
      params: { nlist: IVF_NLIST }, // nlist 越大，粗聚类桶越多；结合数据规模调参
    });
    console.log("Index created");

    // 加载集合
    console.log("\nLoading collection...");
    await ensureCollectionLoaded({ collection_name: COLLECTION_NAME });

    // 插入日记数据
    console.log(chalk.yellow("\nStep 3/4：插入数据 + flush（Milvus）"));
    console.log("\nInserting diary entries...");
    const diaryData = diaryContents.map((diary, i) => ({
      ...diary,
      vector: vectors[i], // 长度必须等于 dim
    }));

    const insertResult = await client.insert({
      collection_name: COLLECTION_NAME,
      data: diaryData,
    });
    console.log(`✓ Inserted ${insertResult.insert_cnt} records\n`);

    // flush：让数据持久化并更稳定地参与索引/检索
    await client.flushSync({ collection_names: [COLLECTION_NAME] });
    console.log("✓ Flushed\n");

    // Step 4/4：RAG（检索增强生成）
    //
    // 你想要的能力是：
    // - 你提一个问题（question）
    // - 系统去 Milvus 检索出最相关的日记片段（Retrieval）
    // - 把片段拼成上下文（Augment）
    // - 交给大模型生成答案（Generation）
    console.log(chalk.yellow("Step 4/4：RAG（检索 -> 拼上下文 -> 生成回答）"));

    const question =
      process.env.QUESTION ||
      "我最近的生活状态如何？有哪些让我开心的事情，以及我在忙什么？";
    console.log(chalk.red(`问题：${question}`));

    // 4.1 纯检索演示（不调用大模型）
    //
    // 这一段是参考你给的“ebook_collection 检索脚本”风格写的：
    // - 先把 query 变成向量
    // - 调 Milvus search 拿到 TopK
    // - 打印 score + 关键信息字段（id/date/mood/tags/content）
    //
    // 和 ebook 场景的对应关系：
    // - ebook：output_fields 会带回 book_id/chapter_num/index/content 等字段
    // - diary：output_fields 会带回 date/mood/tags/content 等字段
    const outputFields = ["id", "date", "mood", "tags", "content"];
    const retrievalQueries = [
      question,
      "哪篇日记提到了成就感？是因为什么事情？",
      "周末做了什么活动？",
      "有哪些日记和学习/技术有关？",
    ];

    console.log(chalk.yellow("\n[Retrieval Demo] 1) 向量检索（无过滤）"));
    for (const q of retrievalQueries) {
      console.log(chalk.red(`Query: "${q}"`));
      const rows = await searchByText({
        collectionName: COLLECTION_NAME,
        queryText: q,
        limit: TOPK,
        outputFields,
        nprobe: IVF_NPROBE,
      });
      printSearchResults(rows, { showContent: true });
    }

    // 4.2 向量检索 + 标量过滤（filter）
    //
    // 真实业务里，filter 常常比“盲搜”更重要：
    // - 先用标量条件缩小候选集（例如只搜某个 userId / 某个时间范围 / 某个标签）
    // - 再在候选集里做向量相似度检索
    //
    // 注意：filter 的语法由 Milvus 的表达式语言决定；不同版本/字段类型支持的函数略有差异。
    // 下方给出三类常见示例，并对可能的兼容性问题做 try/catch，避免脚本直接中断。
    console.log(
      chalk.yellow("\n[Retrieval Demo] 2) 向量检索 + 标量过滤（filter）"),
    );

    const filterExamples = [
      {
        title: "只在心情 happy/relaxed 的日记里检索",
        filter: 'mood in ["happy", "relaxed"]',
      },
      {
        title: "只在指定日期之后的日记里检索（date 为 YYYY-MM-DD 字符串）",
        filter: 'date >= "2026-01-12"',
      },
      {
        title: "只在包含某个标签的日记里检索（数组字段 tags）",
        filter: 'array_contains(tags, "朋友")',
      },
    ];

    for (const ex of filterExamples) {
      console.log(chalk.cyan(`\n- ${ex.title}`));
      try {
        const rows = await searchByText({
          collectionName: COLLECTION_NAME,
          queryText: "这段时间发生了什么？",
          limit: TOPK,
          outputFields,
          nprobe: IVF_NPROBE,
          filter: ex.filter,
        });
        printSearchResults(rows, { showContent: true });
      } catch (e) {
        console.log(
          chalk.gray(
            `（该 filter 可能与你当前 Milvus/SDK 版本不兼容，已跳过）\n原因：${String(
              e?.message || e,
            )}`,
          ),
        );
      }
    }

    // 4.3 自定义 filter（从环境变量传入）
    //
    // 你可以像下面这样运行脚本：
    // FILTER='mood == "happy"' node src/milvus-test/milvus-insert2.mjs
    //
    // 这在做“调参/排查检索效果”时非常实用：不用改代码就能快速试不同过滤条件。
    const filter = process.env.FILTER;
    if (filter) {
      console.log(
        chalk.yellow("\n[Retrieval Demo] 3) 使用环境变量 FILTER 进行检索"),
      );
      console.log(chalk.cyan(`FILTER=${filter}`));
      const rows = await searchByText({
        collectionName: COLLECTION_NAME,
        queryText: question,
        limit: TOPK,
        outputFields,
        nprobe: IVF_NPROBE,
        filter,
      });
      printSearchResults(rows, { showContent: true });
    }

    // 4.4 RAG（检索结果作为上下文 -> 交给大模型回答）
    //
    // 这一步的关键点是：把“检索出来的原文片段”拼进 prompt，让模型只基于这些资料回答，减少幻觉。
    const queryVectors = [await getEmbedding(question)];

    // params.nprobe：搜索时探测的桶数量，越大召回更好但更慢
    const baseReq = {
      collection_name: COLLECTION_NAME,
      queryVectors,
      limit: TOPK,
      output_fields: outputFields,
      ...(filter ? { filter } : {}),
      params: { nprobe: IVF_NPROBE },
      metric_type: MetricType.COSINE,
    };

    const searchRes = await performSearchWithFallback(baseReq);
    const results = normalizeSearchResults(searchRes);
    console.log(chalk.green(`✓ Retrieval done, TopK=${TOPK}`));
    results.forEach((r, i) => {
      console.log(
        chalk.cyan(
          `[Top ${i + 1}] score=${r.score} id=${r.id} date=${r.date} mood=${r.mood} tags=${JSON.stringify(
            r.tags,
          )}`,
        ),
      );
    });

    const context = formatContextFromDiaries(results);
    const prompt = buildRagPrompt({ question, context });
    const response = await llm.invoke(prompt);

    console.log("\n" + chalk.cyan("AI 回答（基于检索到的日记片段）："));
    console.log(response.content);

    console.log(
      [
        "\n总结（你已经跑通了“Milvus + RAG”的最小闭环）：",
        "- Embeddings：把日记 content 和问题 question 变成向量",
        "- Schema：定义主键/向量/标量/数组字段（tags 需 element_type/max_capacity/max_length）",
        "- Index：IVF_FLAT + COSINE（nlist/nprobe 控制召回 vs 性能）",
        "- Load：加载集合以保证检索稳定",
        "- Insert + Flush：写入并持久化",
        "- Retrieval：用问题向量检索 TopK 相关日记片段",
        "- Augment：把片段整理成 context",
        "- Generation：让 LLM 基于 context 回答问题",
        "",
        "下一步建议：",
        "1) 把 date 换成 Int64 时间戳，练习范围过滤（date >= ...）",
        "2) 增加 userId 字段，练习多租户隔离（filter 指定 userId）",
        "3) 要求输出引用：让模型返回“依据：日记片段 n”列表，增强可追溯性",
      ].join("\n"),
    );
  } catch (error) {
    console.error("Error:", error.message);
  }
}

main();
