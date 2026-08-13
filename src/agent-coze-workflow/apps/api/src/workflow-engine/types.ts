/**
 * Agent 层类型定义 —— LLM 结构化输出 Schema
 *
 * 职责：
 * - 用 zod 定义 LLMPlanOutputSchema，供 DeepSeekClient.chatStructured() 使用
 * - 每个字段都有 .describe()，确保 LLM 理解字段语义
 *
 * 关键细节：
 * - needBranch/needCodeNode/needDatabaseNode 是布尔值，LLM 按需求语义判断
 * - constraints/riskHints 是字符串数组，接受空数组
 * - withStructuredOutput 会自动将 schema 翻译为格式指令，无需手写 JSON 容错
 */
import { z } from "zod";

/** LLM 规划输出 Schema */
export const LLMPlanOutputSchema = z.object({
  mode: z.string().describe("工作流模式，如 '问答'、'数据处理'、'多轮对话' 等"),
  goal: z.string().describe("一句话描述工作流目标"),
  inputType: z
    .string()
    .describe("用户输入的类型描述，如 '自然语言问题'、'JSON 数据' 等"),
  outputType: z
    .string()
    .describe("工作流输出的类型描述，如 '自然语言回答'、'结构化数据' 等"),
  needBranch: z.boolean().describe("是否需要条件分支节点来处理不同情况"),
  needCodeNode: z.boolean().describe("是否需要代码节点来执行数据处理逻辑"),
  needDatabaseNode: z
    .boolean()
    .describe("是否需要数据库查询节点来获取外部数据"),
  constraints: z.array(z.string()).describe("工作流需满足的约束条件列表"),
  riskHints: z.array(z.string()).describe("潜在风险和注意事项列表"),
});

/** LLM 规划输出类型（从 Schema 推导） */
export type LLMPlanOutput = z.infer<typeof LLMPlanOutputSchema>;
