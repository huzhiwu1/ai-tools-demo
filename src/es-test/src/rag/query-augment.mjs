/**
 * [查询扩展：用 LLM 生成多角度检索问句]
 *
 * 职责：根据用户原始问题，用大模型生成 3 条不同角度的检索问句
 *       提高混合检索的召回率
 *
 * 流程：
 * 1. 将用户问题发送给 LLM
 * 2. LLM 通过 withStructuredOutput 输出 3 条检索问句（zod schema 约束）
 * 3. 将原始问题 + 3 条扩展问句合并为检索列表
 *
 * 关键细节：
 * - withStructuredOutput 让 LLM 严格按 schema 输出，避免格式错误
 * - zod schema 的 .describe() 是灵魂，LLM 通过描述理解每个字段的含义
 * - 检索列表 = [原始问题, 扩展问句1, 扩展问句2, 扩展问句3]
 * - 每条检索问句都会分别走 ES 和 Milvus 检索
 *
 * 为什么需要查询扩展？
 *   用户提问往往比较口语化或模糊，直接搜索可能遗漏相关文档
 *   例如："家里无线老是断断续续的咋整啊"
 *   扩展后可能变成：["路由器断流排查方法", "WiFi信号不稳定解决方案", "网络频繁掉线修复步骤"]
 *   这样每条扩展问句都能从不同角度召回相关文档
 */
import { ChatPromptTemplate } from "@langchain/core/prompts";
import * as z from "zod";

// ============================================
// 1. 定义输出 Schema（zod）
// ============================================
// 每个字段必须有 .describe()，否则 LLM 无法理解字段用途
export const QueryAugmentationSchema = z.object({
  queries: z
    .array(z.string())
    .length(3)
    .describe(
      "恰好 3 条中文检索问句：不同角度改写或扩写；保留订单号、品牌等字面信息；不要编造事实",
    ),
});

// ============================================
// 2. 定义 Prompt 模板
// ============================================
const AUGMENT_PROMPT = ChatPromptTemplate.fromMessages([
  [
    "system",
    `用户会给出一句中文问题。请另外写出恰好 3 条检索用的问句（与原意一致、角度尽量不同），便于搜索引擎或向量库分别召回：
可改写说法、换提问角度、或略加限定词；专有名词、型号、订单号等必须保留原样。
只输出结构化字段 queries（长度为 3 的字符串数组）。`,
  ],
  ["human", "{query}"],
]);

// ============================================
// 3. 查询扩展主函数
// ============================================
/**
 * 将用户问题扩展为 3 条不同角度的检索问句
 *
 * @param chatModel - LangChain ChatModel 实例
 * @param query - 用户原始问题
 * @returns { queries: string[] } - 包含 3 条扩展问句的对象
 */
export async function augmentQuery(chatModel, query) {
  // withStructuredOutput 让 LLM 严格按 zod schema 输出
  // 底层会把 schema 翻译成自然语言约束插入 prompt，然后自动解析
  const structured = chatModel.withStructuredOutput(QueryAugmentationSchema);
  const chain = AUGMENT_PROMPT.pipe(structured);

  try {
    const raw = await chain.invoke({ query });
    return { queries: normalizeThreeQueries(query, raw.queries) };
  } catch {
    // 如果 LLM 输出格式不对，降级为重复原始问题
    return { queries: normalizeThreeQueries(query, []) };
  }
}

/**
 * 确保 queries 数组恰好有 3 条
 * 不足的用原始问题补齐，超过的截断
 */
function normalizeThreeQueries(original, list) {
  const out = (list ?? [])
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean);
  while (out.length < 3) out.push(original);
  return out.slice(0, 3);
}

// ============================================
// 4. 生成最终检索列表
// ============================================
/**
 * 原始问题在前，其后接 LLM 生成的扩展问句
 * 每条问句各跑一次 ES、Milvus
 *
 * @param original - 用户原始问题
 * @param augmentation - augmentQuery 的返回结果
 * @returns string[] - 用于检索的问句列表（4 条：1 条原始 + 3 条扩展）
 */
export function retrievalQueryStrings(original, augmentation) {
  return [original, ...(augmentation?.queries ?? [])]
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean);
}
