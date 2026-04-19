import "dotenv/config";
import { CheerioWebBaseLoader } from "@langchain/community/document_loaders/web/cheerio";
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
  const content = parts.join("\n\n").trim();
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
    console.log("\n===== 内容预览（前 1200 字）=====\n");
    console.log(content.slice(0, 1200));
    console.log("\n===== 预览结束 =====");
  } catch (error) {
    console.error(error);
  }
}

main();
