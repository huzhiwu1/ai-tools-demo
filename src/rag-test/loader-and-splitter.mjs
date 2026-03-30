import "dotenv/config";

import "cheerio";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { CheerioWebBaseLoader } from "@langchain/community/document_loaders/web/cheerio";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";
import chalk from "chalk";
import { File as NodeFile } from "node:buffer";

const requireEnv = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `缺少环境变量 ${name}。请在项目根目录创建 .env 并设置：\n` +
        `${name}=你的值`,
    );
  }
  return value;
};

async function main() {
  console.log(chalk.blue("=".repeat(100)));
  console.log(
    chalk.blue("RAG 教学：网页加载 -> 切分 -> 向量化 -> 检索 -> 生成"),
  );
  console.log(chalk.blue("=".repeat(100)));

  // 兼容性提示（重要）：
  // 一些运行环境（尤其是 Node.js 18）可能没有全局 File，这会导致底层 HTTP/SDK 报错。
  // 为了让脚本更稳，这里在缺失时用 node:buffer 的 File 补上。
  // 如果你本机 Node >= 20 一般不需要这段，但保留也没坏处。
  if (typeof globalThis.File === "undefined") {
    globalThis.File = NodeFile;
  }

  // ========= 0) 环境变量与 API 参数（你能控制“连到哪家模型服务”）=========
  //
  // 你需要在 .env 配置：
  // - API_KEY：模型服务的 key
  // - BASE_URL：服务地址（很多第三方会提供 OpenAI 兼容接口）
  // - MODEL_NAME：对话模型（用于“生成回答”）
  // - EMBEDDINGS_MODEL_NAME：向量模型（用于“生成向量”做检索）
  //
  // 为什么要两个模型：
  // - embeddings 模型：把文本变成向量，目的是“检索”
  // - chat 模型：读“检索到的资料 + 你的问题”，目的是“生成”
  const apiKey = requireEnv("API_KEY");
  const baseURL = requireEnv("BASE_URL");
  const modelName = requireEnv("MODEL_NAME");
  const embeddingsModelName = requireEnv("EMBEDDINGS_MODEL_NAME");

  // ========= 1) 构建模型（Generation）=========
  //
  // ChatOpenAI 用于生成回答。
  // - temperature=0：更稳、更少发挥，更适合“只基于资料回答”的 RAG 场景
  // - model：对话模型名（具体有哪些模型名取决于你的 BASE_URL 服务提供方）
  const model = new ChatOpenAI({
    temperature: 0,
    model: modelName,
    apiKey,
    configuration: { baseURL },
  });

  // ========= 2) 构建向量模型（Embeddings）=========
  //
  // OpenAIEmbeddings 用于把文本转成向量。
  // batchSize 很关键：很多服务端会限制一次请求最多 embedding 多少条文本。
  // 你之前遇到的 400：batch size must not be larger than 10
  // 就是因为一次性 embedding 的条数超过了服务限制。
  const embeddings = new OpenAIEmbeddings({
    apiKey,
    model: embeddingsModelName,
    batchSize: 10,
    configuration: { baseURL },
  });

  // ========= 3) Loader：从网页把“原始文本”抓出来（Retrieval 的数据源）=========
  //
  // RAG 的第一步永远是：你要把“知识”变成可检索的形态。
  // 这里我们把掘金文章的正文段落抓出来，组成 Document 列表。
  // selector 决定你抓哪些 DOM 节点；抓得越干净，后续切分/检索越准。
  const cheerioLoader = new CheerioWebBaseLoader(
    "https://juejin.cn/post/7590699877630378022",
    { selector: ".main-area p" },
  );

  console.log(chalk.yellow("\n[Step 1/5] 加载网页内容（Loader）"));
  const documents = await cheerioLoader.load();
  console.log(
    chalk.gray(
      `已加载 documents=${documents.length}（每个 Document 约对应网页的一段/一组段落）`,
    ),
  );

  // ========= 4) Splitter：把大文档切成“小块”（Chunking）=========
  //
  // 为什么要切分：
  // - embedding 的输入有长度限制；太长会报错或被截断
  // - 不切分会导致“检索粒度太粗”：你问一个点，它可能返回整篇文章
  //
  // chunkSize / chunkOverlap 怎么选：
  // - chunkSize：块越大，包含信息更多，但更容易混入不相关内容；也更贵
  // - chunkOverlap：块之间重叠，避免“关键句刚好被切断”导致语义丢失
  //
  // separators：切分优先级（越靠前越优先），中文场景常用：段落->换行->句号->感叹号->问号
  const splitterLoader = new RecursiveCharacterTextSplitter({
    chunkSize: 400,
    chunkOverlap: 50,
    separators: ["\n\n", "\n", "。", "！", "？"],
  });

  console.log(chalk.yellow("\n[Step 2/5] 切分文档（Splitter/Chunking）"));
  const splitDocuments = await splitterLoader.splitDocuments(documents);
  console.log(
    chalk.gray(
      `切分后 splitDocuments=${splitDocuments.length}（数量通常会显著增加，后续 embedding 成本也会增加）`,
    ),
  );
  if (splitDocuments.length > 0) {
    console.log(
      chalk.gray("示例 chunk（前 1 条，便于你理解 chunk 长什么样）："),
    );
    console.log(chalk.gray(splitDocuments[0].pageContent));
  }

  // ========= 5) VectorStore：把 chunks 向量化并存入向量库（Indexing）=========
  //
  // MemoryVectorStore.fromDocuments 做了两件事：
  // 1) 对每个 chunk 走 embeddings -> 得到向量
  // 2) 把 {向量, Document} 存到向量库里
  //
  // 这是“索引阶段”：只要你的知识库变了（换文章、换切分、换 embedding 模型），都需要重建索引。
  console.log(chalk.yellow("\n[Step 3/5] 建立向量库（Embedding + Indexing）"));
  const vectorStore = await MemoryVectorStore.fromDocuments(
    splitDocuments,
    embeddings,
  );
  console.log(
    chalk.gray(
      "向量库建立完成（MemoryVectorStore：只存在内存，脚本结束就消失）",
    ),
  );

  // ========= 6) Retriever：检索器（Query -> 找最相关 chunks）=========
  //
  // asRetriever({k})：封装一个“帮你找资料”的对象
  // - k=2 表示拿最相关的 2 个 chunk
  // 真正项目里 k 往往会更大（例如 4~10），再做 rerank/过滤。
  const retriever = vectorStore.asRetriever({ k: 2 });

  // ========= 7) RAG 主循环：问问题 -> 检索 -> 拼上下文 -> 生成答案 =========
  //
  // 注意：RAG 的“增强”发生在生成前：把检索到的资料显式放进 prompt。
  const questions = ["作者中心思想是什么", "作者的有哪些特别的经历"];

  for (const question of questions) {
    console.log("\n" + chalk.green("=".repeat(100)));
    console.log(chalk.blue(`问题：${question}`));
    console.log(chalk.green("=".repeat(100)));

    console.log(chalk.yellow("[Step 4/5] 检索（Retrieve）"));
    const retrievedDocs = await retriever.invoke(question);
    console.log(
      chalk.gray(
        `检索到 ${retrievedDocs.length} 条 chunk（按相似度从高到低排序）`,
      ),
    );

    // 额外展示：带分数的检索结果（用于调试检索质量）
    // - 返回类型：[Document, number][]
    // - number 一般是“距离分数”（越小越相似），但不同向量库/度量方式含义可能不同
    const scored = await vectorStore.similaritySearchWithScore(question, 2);
    scored.forEach(([doc, score], i) => {
      console.log(
        chalk.gray(
          `score[${i + 1}]=${score} | chunkPreview=${doc.pageContent.slice(0, 60).replaceAll("\n", " ")}...`,
        ),
      );
    });

    // 把检索到的 chunk 拼成上下文
    // 这里把 metadata 也带上，方便溯源/引用（生产里还可以把 URL、标题、段落位置写入 metadata）
    const context = retrievedDocs
      .map((v, i) => {
        const metadata = v.metadata ? JSON.stringify(v.metadata) : "{}";
        return `【片段 ${i + 1}】metadata=${metadata}\n${v.pageContent}`;
      })
      .join("\n\n---\n\n");

    // Prompt 设计要点：
    // - 明确约束：只能基于资料回答（减少“幻觉”）
    // - 明确兜底：资料不足就说不知道，并说明缺什么
    // - 你也可以要求：引用片段编号、输出 JSON、分点回答等
    const prompt =
      "你是一个耐心的中文助手，只能基于【参考资料】回答问题。\n" +
      "如果资料里没有明确答案，请回复：不知道（并说明缺少哪些信息）。\n\n" +
      `【参考资料】\n${context}\n\n` +
      `【问题】\n${question}\n\n` +
      "【回答】";

    console.log(chalk.yellow("[Step 5/5] 生成（Generate）"));
    const response = await model.invoke(prompt);
    console.log(chalk.blue(response.content));
  }

  console.log("\n" + chalk.blue("=".repeat(100)));
  console.log(
    chalk.blue(
      "扩展方向（你可以继续练习的点）：\n" +
        "1) 提升溯源：让模型在回答里引用【片段1】【片段2】并给出理由\n" +
        "2) 提升检索：调 chunkSize/overlap/k，或对结果做 rerank（重排序）\n" +
        "3) 提升质量：对网页内容做清洗（去广告/导航/无关段落）\n" +
        "4) 规模化：把 MemoryVectorStore 换成持久化向量库（PGVector/Milvus 等）\n" +
        "5) 增量更新：只对新增文档做 embedding，避免每次全量重建\n",
    ),
  );
}

await main();
