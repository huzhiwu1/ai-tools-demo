import "dotenv/config";
import chalk from "chalk";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { Document } from "@langchain/core/documents";
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";

// 这是一个“教学向”的最小 RAG 示例，适合按顺序读代码理解：
// RAG = 检索（Retrieval）+ 生成（Generation）
//
// 你可以把它理解成：
// 1) 先把“知识库文档”放进一个能检索的“向量库”（索引阶段）
// 2) 用户提问时，先去向量库找最相关的几段资料（检索阶段）
// 3) 把这些资料拼到提示词里，再让大模型回答（生成阶段）
//
// 为什么要 RAG：
// - 大模型本身不“记得”你的私有数据（或者记得也不可靠/不可控）
// - RAG 让回答“基于资料”，可追溯，减少胡编乱造（幻觉）
//
// 这个脚本用到的关键对象：
// - Document：一条知识（文本 + metadata）
// - OpenAIEmbeddings：把文本转成向量（数字数组）
// - MemoryVectorStore：把向量存在内存里，并支持相似度检索
// - ChatOpenAI：用大模型把“问题 + 检索到的资料”组织成最终回答

function requireEnv(name) {
  // 为了让小白更容易排错：缺环境变量时直接报错，而不是跑到一半才 401/404
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `缺少环境变量 ${name}。请在项目根目录创建 .env 并设置：\n` +
        `API_KEY=你的key\n` +
        `MODEL_NAME=你的模型名\n` +
        `EMBEDDINGS_MODEL_NAME=你的向量模型名\n` +
        `BASE_URL=你的接口地址(如果需要)\n`,
    );
  }
  return value;
}

// 这些环境变量通常来自 .env 文件（dotenv/config 会自动加载）
// - API_KEY：访问模型服务的 key
// - MODEL_NAME：对话模型（用于“生成回答”）
// - EMBEDDINGS_MODEL_NAME：向量模型（用于“把文本变成向量”）
// - BASE_URL：如果你用的是兼容 OpenAI 的第三方网关/私有部署，这里填接口地址
const API_KEY = requireEnv("API_KEY");
const MODEL_NAME = requireEnv("MODEL_NAME");
const EMBEDDINGS_MODEL_NAME = requireEnv("EMBEDDINGS_MODEL_NAME");
const BASE_URL = process.env.BASE_URL;

// ChatOpenAI：对话/生成模型
// - temperature=0：让回答更稳定、少发挥，更适合教学和“基于资料回答”的场景
const llm = new ChatOpenAI({
  apiKey: API_KEY,
  model: MODEL_NAME,
  temperature: 0,
  configuration: BASE_URL ? { baseURL: BASE_URL } : undefined,
});

// OpenAIEmbeddings：向量模型（Embedding）
// - 它只负责把文本映射到向量空间（用于相似度检索），不会“回答问题”
const embeddings = new OpenAIEmbeddings({
  apiKey: API_KEY,
  model: EMBEDDINGS_MODEL_NAME,
  configuration: BASE_URL ? { baseURL: BASE_URL } : undefined,
});

// 这是我们的“知识库”
// 每一条 Document 通常包含：
// - pageContent：文本内容（真正会被向量化用于检索的部分）
// - metadata：结构化信息（不会直接参与向量化，但非常适合做过滤、展示、溯源）
const knowledgeBase = [
  new Document({
    pageContent:
      "公司报销规则：地铁/公交按实际票据报销；出租车需要附带行程单；餐饮单次不超过 100 元。",
    metadata: { source: "policy", topic: "报销" },
  }),
  new Document({
    pageContent:
      "请假流程：在 OA 提交申请 -> 直属主管审批 -> HR 备案。病假需提供医疗证明。",
    metadata: { source: "handbook", topic: "请假" },
  }),
  new Document({
    pageContent:
      "办公网络：访客 WiFi 为 GUEST-5G；内网 WiFi 为 CORP-5G。内网需要员工工号登录。",
    metadata: { source: "it", topic: "网络" },
  }),
  new Document({
    pageContent:
      "加班调休：工作日加班可申请调休；法定节假日按规定支付加班费或调休二选一。",
    metadata: { source: "policy", topic: "加班" },
  }),
  new Document({
    pageContent:
      "办公时间：周一到周五 10:00-19:00，中午休息 12:00-13:30；周末默认休息。",
    metadata: { source: "handbook", topic: "时间" },
  }),
];

function buildPrompt({ question, context }) {
  // Prompt 的关键目标：
  // 1) 明确要求：只能基于参考资料回答（减少幻觉）
  // 2) 给出“资料不足时”的标准回复（让行为更可控）
  //
  // 真正生产里你会更严格，比如要求引用片段编号、输出 JSON、或者分点回答等。
  return (
    "你是一个耐心的中文助手，只能基于【参考资料】回答问题。\n" +
    "如果资料里没有明确答案，请回复：不知道（并说明缺少哪些信息）。\n\n" +
    `【参考资料】\n${context}\n\n` +
    `【问题】\n${question}\n\n` +
    "【回答】"
  );
}

function formatContext(docs) {
  // 把检索到的 Document 列表拼成一段可读的“参考资料”
  // 这里把 metadata 一起输出：
  // - 小白学习时能看到“这条资料来自哪里/属于什么主题”
  // - 你也可以在回答里要求模型引用 metadata.source 来做溯源
  return docs
    .map((d, i) => {
      const meta = d.metadata ? JSON.stringify(d.metadata) : "{}";
      return `片段${i + 1}（metadata=${meta}）\n${d.pageContent}`;
    })
    .join("\n\n---\n\n");
}

async function main() {
  console.log(chalk.blue("=".repeat(80)));
  console.log(
    chalk.blue("RAG 教学脚本：Retrieval-Augmented Generation（检索增强生成）"),
  );
  console.log(chalk.blue("=".repeat(80)));
  console.log(
    [
      "你将看到 3 步：",
      "1) 把文档变成向量并存入向量库（向量化/索引）",
      "2) 针对问题检索最相关文档（检索）",
      "3) 把检索结果拼成上下文交给 LLM 生成回答（生成）",
    ].join("\n"),
  );

  console.log("\n" + chalk.yellow("Step 1/3：建立向量库（把知识库写进去）"));
  // MemoryVectorStore.fromDocuments 做了两件事：
  // 1) 对每个 Document.pageContent 调 embeddings 模型生成向量
  // 2) 把向量和原始 Document 一起存入向量库
  //
  // 注意：MemoryVectorStore 只存在内存里，脚本结束数据就没了。
  // 真正项目会用持久化向量库（例如 PGVector、Milvus、Pinecone 等）。
  const vectorStore = await MemoryVectorStore.fromDocuments(
    knowledgeBase,
    embeddings,
  );
  console.log(
    `已写入 ${knowledgeBase.length} 条 Document，每条包含 pageContent + metadata`,
  );

  const question = "报销打车需要什么材料？";
  console.log("\n" + chalk.yellow("Step 2/3：检索（找到与问题最相关的资料）"));
  console.log(chalk.red(`问题：${question}`));

  // k：topK，表示“取最相关的前 k 条”
  const k = 3;
  // similaritySearch：只返回 Document（不带分数）
  // 用途：你只关心“拿到哪些片段”，不关心“每条的相似度多少”
  const retrieved = await vectorStore.similaritySearch(question, k);
  // similaritySearchWithScore：返回 [Document, score][]
  // - score 通常是距离分数（越小越相似），但具体含义与向量库/度量有关
  // - 所以这个分数更适合“相对比较”和调试，不要迷信绝对值
  const scored = await vectorStore.similaritySearchWithScore(question, k);

  console.log(chalk.green(`检索 Top ${k} 结果（来自 similaritySearch）:`));
  retrieved.forEach((d, i) => {
    console.log(`\n[片段 ${i + 1}]`);
    console.log(`内容：${d.pageContent}`);
    console.log(`metadata：${JSON.stringify(d.metadata)}`);
  });

  console.log(
    "\n" +
      chalk.green(
        `检索 Top ${k} 结果（来自 similaritySearchWithScore，包含距离分数）:`,
      ),
  );
  scored.forEach(([d, score], i) => {
    // 这里为了让小白更直观地理解，做了一个近似转换：similarity ≈ 1 - score
    // 重要提醒：不同向量库/度量方式下，score 不一定在 0~1，也不一定能用 1-score 表示相似度
    // 更稳妥的用法：展示 score 供调试，同时以“排序结果”作为主要参考
    const similarity =
      typeof score === "number" ? (1 - score).toFixed(4) : "N/A";
    console.log(`\n[片段 ${i + 1}] score=${score} similarity≈${similarity}`);
    console.log(`内容：${d.pageContent}`);
    console.log(`metadata：${JSON.stringify(d.metadata)}`);
  });

  console.log(
    "\n" + chalk.yellow("Step 3/3：生成（把检索到的资料交给模型回答）"),
  );
  // 把检索到的文档拼成上下文（context）
  // 这一点就是“检索增强”的核心：把资料显式喂给大模型，而不是指望模型自己“知道”
  const context = formatContext(retrieved);
  // 把“问题 + 资料”组成提示词 prompt
  const prompt = buildPrompt({ question, context });

  // LLM 生成回答：你会看到它主要引用了“报销规则”那条 Document
  const response = await llm.invoke(prompt);
  console.log("\n" + chalk.cyan("模型回答："));
  console.log(response.content);

  console.log("\n" + chalk.blue("=".repeat(80)));
  console.log(
    [
      "你现在掌握了最小可运行的 RAG：",
      "- Document：知识条目",
      "- Embeddings：把文本变向量",
      "- VectorStore：存向量，支持相似度检索",
      "- Retriever/Search：找到相关资料",
      "- Prompt：把资料+问题交给 LLM 生成回答",
    ].join("\n"),
  );
}

// 入口：直接运行 main()
await main();
