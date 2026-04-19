import "dotenv/config";
import { CheerioWebBaseLoader } from "@langchain/community/document_loaders/web/cheerio";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import chalk from "chalk";
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

async function getZhihuArticle(url) {
  // 你想抓取的 DOM 根节点：
  // - 你的目标是抓 #content 下的文本和图片，因此这里默认写 #content
  // - 如果目标网页结构变化，建议改成更稳的容器，例如：
  //   "article, .Post-RichText, .RichText"
  // - 这个 rootSelector 只决定“从哪里开始抽”，真正抽取的是 root 内的 p/img
  const rootSelector = ".Post-Main";

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
  const title = $(".Post-Title").text().trim();
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
    console.log(chalk.blue("开始抓取知乎文章"));
    const url =
      process.env.ZHIHU_URL ||
      "https://zhuanlan.zhihu.com/p/1993469340872377578";
    const { title, content, images } = await getZhihuArticle(url);

    console.log(chalk.green(`✓ 标题：${title || "（无）"}`));
    console.log(chalk.green(`✓ 文本长度：${content.length}`));
    console.log(chalk.green(`✓ 图片数量：${images.length}`));

    // 第三步：分块
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

    // 预览前 2 个 chunk（帮助你理解“切出来长什么样”）
    const previewCount = Math.min(2, chunks.length);
    for (let i = 0; i < previewCount; i++) {
      console.log(chalk.cyan(`\n--- chunk #${i + 1}/${chunks.length} ---`));
      console.log(chunks[i]);
    }

    // 你接下来要做的第四步（还没实现）通常是：
    // - 对 chunks 做 embedding
    // - 写入 Milvus（每条记录存：url/title/chunk_index/content/vector）
  } catch (error) {
    console.error(error);
  }
}

main();
