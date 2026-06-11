/**
 * [混合检索 RAG：ES 关键词 + Milvus 向量语义 + Rerank 重排]
 *
 * 职责：实现完整的混合检索 RAG 流水线
 *
 * 流程（LangGraph 状态图）：
 * START → query_augment（查询扩展）
 *       → es_recall（ES 关键词检索）∥ milvus_recall（Milvus 向量检索）
 *       → merge（合并去重）
 *       → rerank（Rerank 重排序）
 *       → generate_answer（LLM 生成回答）
 *       → END
 *
 * 关键细节：
 * - query_augment：用 LLM 把用户问题扩展为 3 条多角度检索问句
 * - es_recall：每条问句分别走 ES 的 multi_match 搜索
 * - milvus_recall：每条问句分别走 Milvus 的向量相似搜索
 * - merge：ES + Milvus 结果按 id 去重合并
 * - rerank：用 Rerank 模型对合并结果重新排序，取 topN
 * - generate_answer：LLM 基于重排后的上下文生成最终回答
 *
 * 为什么需要混合检索？
 *   ES 关键词检索：擅长精确匹配（订单号、品牌名等）
 *   Milvus 向量检索：擅长语义匹配（"网络不稳定" → 匹配"路由器断流"）
 *   两者互补，混合检索效果优于任一单独方式
 *
 * 运行方式：
 *   1. 先运行 node src/rag/seed-data.mjs 初始化数据
 *   2. 再运行 node src/rag/hybrid-retrieval.mjs 执行混合检索
 */
import "dotenv/config";
import { Client } from "@elastic/elasticsearch";
import { Document } from "@langchain/core/documents";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { Milvus } from "@langchain/community/vectorstores/milvus";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { DashScopeRerank } from "../rerank/dashscope-rerank.mjs";
import { augmentQuery, retrievalQueryStrings } from "./query-augment.mjs";

const INDEX = "life_notes";

// ============================================
// 1. 定义 LangGraph 状态
// ============================================
// 每个字段对应流水线中一个节点的输出
// Annotation() 声明字段的类型和合并策略
const HybridRetrievalState = Annotation.Root({
  query: Annotation(), // 用户原始问题
  queryAugmentation: Annotation(), // 查询扩展结果
  esHits: Annotation(), // ES 检索结果
  milvusHits: Annotation(), // Milvus 检索结果
  merged: Annotation(), // 合并去重后的结果
  topDocuments: Annotation(), // Rerank 后的 topN 文档
  answer: Annotation(), // LLM 生成的最终回答
});

// ============================================
// 2. 辅助函数
// ============================================

/** 把 ES 的 hit 对象转为 LangChain Document 格式 */
function docFromEsHit(hit) {
  const s = hit._source ?? {};
  const text = [s.note_title ?? s.title, s.note_body ?? s.content]
    .filter(Boolean)
    .join("\n");
  return new Document({
    pageContent: text,
    metadata: { id: hit._id, source: "es", ...s },
  });
}

/** 合并 ES 和 Milvus 结果，按 metadata.id 去重（保留首次出现） */
function merge(esDocs, milvusDocs) {
  const combined = [...(esDocs ?? []), ...(milvusDocs ?? [])].filter(
    (d) => d?.pageContent,
  );
  return dedupeDocsById(combined);
}

/** 按 metadata.id 去重，保留首次出现的顺序 */
function dedupeDocsById(docs) {
  const seen = new Set();
  const out = [];
  for (const d of docs ?? []) {
    if (!d?.pageContent) continue;
    const id = d.metadata?.id != null ? String(d.metadata.id).trim() : "";
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(d);
  }
  return out;
}

/** 打印文档列表（调试用） */
function printDocs(label, docs) {
  console.log(`\n=== ${label} (${docs?.length ?? 0} 条) ===`);
  for (let i = 0; i < (docs ?? []).length; i++) {
    const d = docs[i];
    const preview = (d.pageContent ?? "").slice(0, 200).replace(/\n/g, " ");
    console.log(`[${i}] ${preview}${d.pageContent?.length > 200 ? "…" : ""}`);
    console.log(`    metadata:`, d.metadata ?? {});
  }
}

/** 打印查询扩展结果 */
function printQueryRewrite(original, augmentation) {
  const qs = augmentation?.queries ?? [];
  const forRetrieval = retrievalQueryStrings(original, augmentation);

  console.log(`\n--- 查询扩展（LLM 生成 ${qs.length} 条检索问句）---`);
  console.log("原始 query:", original ?? "");
  for (let i = 0; i < qs.length; i++)
    console.log(`  [${i + 1}] ${qs[i] ?? ""}`);
  console.log(
    `\n逐条 ES + Milvus（共 ${forRetrieval.length} 条检索串，含原始问题）:`,
  );
  for (let i = 0; i < forRetrieval.length; i++) {
    console.log(`  [${i + 1}] ${forRetrieval[i] ?? ""}`);
  }
}

/** 将消息内容转为字符串 */
function stringifyMessageContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((c) =>
      typeof c === "string" ? c : typeof c?.text === "string" ? c.text : "",
    )
    .join("");
}

/** 把文档列表格式化为 LLM 上下文 */
function formatDocsAsContext(docs) {
  return (docs ?? [])
    .map((d, i) => {
      const meta = d.metadata ?? {};
      const src = meta.source ?? "";
      const id = meta.id != null ? String(meta.id) : "";
      const head = id
        ? `[${i + 1}] id=${id}${src ? ` source=${src}` : ""}`
        : `[${i + 1}]`;
      return `${head}\n${d.pageContent ?? ""}`;
    })
    .join("\n\n---\n\n");
}

// ============================================
// 3. LLM 回答 Prompt
// ============================================
const ANSWER_PROMPT = ChatPromptTemplate.fromMessages([
  [
    "system",
    `你是阅读用户「生活笔记」知识库并作答的助手。
规则：
- 只根据下方「检索片段」推断答案；片段里没有的信息不要编造。
- 若片段不足以回答，明确说明「笔记里未提到」，并可给出一句保守建议。
- 回答简洁有条理，可使用简短列表；口吻自然中文。`,
  ],
  [
    "human",
    `用户问题：{query}

检索片段：
{context}`,
  ],
]);

const NO_CONTEXT_PROMPT = ChatPromptTemplate.fromMessages([
  [
    "system",
    `你是阅读用户「生活笔记」知识库并作答的助手。当前没有检索到任何片段。
请用一两句话说明无法从笔记中回答，并礼貌询问用户是否换个说法或补充关键词。`,
  ],
  ["human", "用户问题：{query}"],
]);

// ============================================
// 4. 编译 LangGraph 状态图
// ============================================
/**
 * 构建混合检索 RAG 的 LangGraph 工作流
 *
 * @param esClient - ES 客户端
 * @param milvus - LangChain Milvus 向量库实例
 * @param reranker - Rerank 重排序器
 * @param chatModel - LLM 聊天模型
 * @returns 编译后的 LangGraph 图
 */
export function compileHybridRetrievalGraph(
  esClient,
  milvus,
  reranker,
  chatModel,
) {
  const ES_K = 15; // ES 每次检索取 top 15
  const MILVUS_K = 15; // Milvus 每次检索取 top 15

  return (
    new StateGraph(HybridRetrievalState)
      // 节点1：查询扩展 —— 用 LLM 生成 3 条多角度检索问句
      .addNode("query_augment", async (state) => ({
        queryAugmentation: await augmentQuery(chatModel, state.query ?? ""),
      }))

      // 节点2：ES 关键词检索 —— 每条问句分别搜索，合并去重
      .addNode("es_recall", async (state) => {
        const qs = retrievalQueryStrings(state.query, state.queryAugmentation);
        const n = Math.max(1, qs.length);
        const kEach = Math.max(2, Math.ceil(ES_K / n)); // 均分每条问句的 K
        // 并行搜索所有问句
        const batches = await Promise.all(
          qs.map((q) =>
            esClient.search({
              index: INDEX,
              size: kEach,
              query: {
                multi_match: {
                  query: q,
                  fields: ["note_title^2", "note_body", "title", "content"],
                  type: "best_fields",
                  analyzer: "ik_smart", // 搜索时用 IK 智能分词
                },
              },
            }),
          ),
        );
        const flat = batches.flatMap((res) =>
          (res.hits?.hits ?? []).map(docFromEsHit),
        );
        return { esHits: dedupeDocsById(flat) };
      })

      // 节点3：Milvus 向量语义检索 —— 每条问句分别搜索
      .addNode("milvus_recall", async (state) => {
        const qs = retrievalQueryStrings(state.query, state.queryAugmentation);
        const n = Math.max(1, qs.length);
        const kEach = Math.max(2, Math.ceil(MILVUS_K / n));
        const batches = await Promise.all(
          qs.map((q) => milvus.similaritySearch(q, kEach)),
        );
        const flat = batches.flat();
        return { milvusHits: dedupeDocsById(flat) };
      })

      // 节点4：合并去重
      .addNode("merge", async (state) => ({
        merged: merge(state.esHits, state.milvusHits),
      }))

      // 节点5：Rerank 重排序 —— 用 Rerank 模型按相关度重排，取 topN
      .addNode("rerank", async (state) => {
        const merged = state.merged ?? [];
        if (!merged.length) return { topDocuments: [] };
        const topDocuments = await reranker.compressDocuments(
          merged,
          state.query,
        );
        return { topDocuments };
      })

      // 节点6：LLM 生成回答
      .addNode("generate_answer", async (state) => {
        const query = state.query ?? "";
        const docs = state.topDocuments ?? [];
        if (!docs.length) {
          // 没有检索到相关文档，使用降级 prompt
          const chain = NO_CONTEXT_PROMPT.pipe(chatModel);
          const msg = await chain.invoke({ query });
          return { answer: stringifyMessageContent(msg.content).trim() };
        }
        // 有检索结果，拼接上下文让 LLM 作答
        const chain = ANSWER_PROMPT.pipe(chatModel);
        const msg = await chain.invoke({
          query,
          context: formatDocsAsContext(docs),
        });
        return { answer: stringifyMessageContent(msg.content).trim() };
      })

      // 定义边（节点间的执行顺序）
      .addEdge(START, "query_augment") // 开始 → 查询扩展
      .addEdge("query_augment", "es_recall") // 查询扩展 → ES 检索
      .addEdge("query_augment", "milvus_recall") // 查询扩展 → Milvus 检索（并行！）
      .addEdge(["es_recall", "milvus_recall"], "merge") // 两个检索都完成 → 合并
      .addEdge("merge", "rerank") // 合并 → 重排序
      .addEdge("rerank", "generate_answer") // 重排序 → 生成回答
      .addEdge("generate_answer", END) // 生成回答 → 结束
      .compile()
  );
}

// ============================================
// 5. 初始化各组件并运行示例
// ============================================

// ES 客户端
const esClient = new Client({ node: "http://localhost:9200" });

// Embedding 模型（文本 → 向量，用于 Milvus 查询）
const embeddings = new OpenAIEmbeddings({
  model: "text-embedding-v3",
  apiKey: process.env.OPENAI_API_KEY,
  configuration: {
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
});

// Milvus 向量库（连接已有集合）
const milvus = await Milvus.fromExistingCollection(embeddings, {
  url: "http://localhost:19530",
  collectionName: INDEX,
  textField: "doc_text",
  vectorField: "embedding",
});

// Rerank 重排序器
const reranker = new DashScopeRerank({
  apiKey: process.env.OPENAI_API_KEY,
  model: "qwen3-rerank",
  topN: 3, // 重排后只保留最相关的 3 条
  baseUrl:
    "https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank",
});

// LLM 聊天模型
const chatModel = new ChatOpenAI({
  model: process.env.LLM_MODEL_NAME ?? "qwen-turbo",
  apiKey: process.env.OPENAI_API_KEY,
  temperature: 0.2,
  configuration: {
    baseURL: process.env.OPENAI_BASE_URL,
  },
});

// 示例查询
const SAMPLE_QUERIES = ["家里无线老是断断续续的咋整啊"];

// 编译状态图
const graph = compileHybridRetrievalGraph(
  esClient,
  milvus,
  reranker,
  chatModel,
);

// 输出 Mermaid 流程图（可在 Mermaid 编辑器中可视化）
const drawable = await graph.getGraphAsync();
console.log(drawable.drawMermaid());
console.log();

// 逐条执行查询
for (const query of SAMPLE_QUERIES) {
  console.log(`query: ${query}`);

  const state = await graph.invoke({ query });

  // 打印各阶段结果
  printQueryRewrite(state.query, state.queryAugmentation);
  console.log("\n（原始 JSON）", JSON.stringify(state.queryAugmentation));

  printDocs("Elasticsearch 检索", state.esHits);
  printDocs("Milvus 检索", state.milvusHits);
  printDocs("重排后保留", state.topDocuments ?? []);

  console.log("\n=== 大模型生成回答 ===\n");
  console.log(state.answer ?? "");
}
