import "dotenv/config";
import { CheerioWebBaseLoader } from "@langchain/community/document_loaders/web/cheerio";

// 第一步：抓取网页正文
// 可通过环境变量覆盖：
// ZHIHU_URL="https://zhuanlan.zhihu.com/p/1993469340872377578" node src/zhihu-rag/zhihu-fetch.mjs
const TARGET_URL =
  process.env.ZHIHU_URL ||
  "https://zhuanlan.zhihu.com/p/1993469340872377578";

function cleanText(text) {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

async function loadWithSelector(url) {
  // 知乎专栏正文一般在 article / RichText 容器里，优先精准抽取
  const loader = new CheerioWebBaseLoader(url, {
    selector: "article, .Post-RichText, .RichText",
  });
  return loader.load();
}

async function loadFallback(url) {
  // 兜底：如果站点结构变化，退回整页抽取
  const loader = new CheerioWebBaseLoader(url);
  return loader.load();
}

async function main() {
  try {
    console.log(`开始抓取: ${TARGET_URL}`);

    let docs = await loadWithSelector(TARGET_URL);
    let rawText = docs.map((d) => d.pageContent || "").join("\n\n").trim();

    // 选择器抽不到内容时，使用整页兜底
    if (!rawText || rawText.length < 200) {
      console.log("选择器抽取内容较少，尝试整页兜底抽取...");
      docs = await loadFallback(TARGET_URL);
      rawText = docs.map((d) => d.pageContent || "").join("\n\n").trim();
    }

    const content = cleanText(rawText);
    if (!content) {
      throw new Error("未抓取到有效文本，请检查 URL 或网络访问权限。");
    }

    console.log(`抓取成功，文本长度: ${content.length} 字符`);
    console.log("\n===== 内容预览（前 800 字）=====\n");
    console.log(content.slice(0, 800));
    console.log("\n===== 预览结束 =====");

    // 后续第二步（分块 + 向量化）会直接复用 content 变量
  } catch (error) {
    console.error("抓取失败:", error.message);
    process.exit(1);
  }
}

main();

