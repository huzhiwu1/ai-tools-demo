/**
 * 工具注册列表
 *
 * 职责：
 * 汇总所有工具，供 createReactAgent 使用。
 *
 * 关键细节：
 * - clarify_question 放在列表最前面，确保 LLM 优先考虑信息澄清
 * - 工具顺序影响 LLM 的选择偏好（description 权重更高）
 */

export { clarifyQuestionTool } from "./clarify.tool";
export { planWorkflowTool } from "./plan.tool";
export { generateWorkflowTool } from "./generate.tool";
export { saveToCozeTool } from "./save.tool";
export { testRunWorkflowTool } from "./test-run.tool";

import { clarifyQuestionTool } from "./clarify.tool";
import { planWorkflowTool } from "./plan.tool";
import { generateWorkflowTool } from "./generate.tool";
import { saveToCozeTool } from "./save.tool";
import { testRunWorkflowTool } from "./test-run.tool";

/**
 * 工具注册列表（供 createReactAgent 使用）
 */
export const ALL_TOOLS = [
  clarifyQuestionTool,
  planWorkflowTool,
  generateWorkflowTool,
  saveToCozeTool,
  testRunWorkflowTool,
] as const;
