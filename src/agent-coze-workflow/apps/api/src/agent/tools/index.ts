/**
 * 工具注册列表
 *
 * 职责：
 * 汇总所有工具，供 createReactAgent 使用。
 *
 * 关键细节：
 * - clarify_question 放在列表最前面，确保 LLM 优先考虑信息澄清
 * - read_file 紧随其后（文件读取是数据入口）
 * - 工具顺序影响 LLM 的选择偏好（description 权重更高）
 */

export { clarifyQuestionTool } from "./clarify.tool";
export { planWorkflowTool } from "./plan.tool";
export { generateWorkflowTool } from "./generate.tool";
export { saveToCozeTool } from "./save.tool";
export { testRunWorkflowTool } from "./test-run.tool";
export { readFileTool } from "./read-file.tool";
export { getPlatformFactsTool } from "./platform-facts.tool";
export { batchValidateTool } from "./batch-validate.tool";
export { updateWorkflowTool } from "./update-workflow.tool";
export { renameWorkflowTool } from "./rename-workflow.tool";

import { Logger } from "@nestjs/common";
import type { StructuredToolInterface } from "@langchain/core/tools";

import { clarifyQuestionTool } from "./clarify.tool";
import { planWorkflowTool } from "./plan.tool";
import { generateWorkflowTool } from "./generate.tool";
import { saveToCozeTool } from "./save.tool";
import { testRunWorkflowTool } from "./test-run.tool";
import { readFileTool } from "./read-file.tool";
import { getPlatformFactsTool } from "./platform-facts.tool";
import { batchValidateTool } from "./batch-validate.tool";
import { updateWorkflowTool } from "./update-workflow.tool";
import { renameWorkflowTool } from "./rename-workflow.tool";

const toolLogger = new Logger("Tool");

/** 工具出参转字符串：对象序列化为 JSON（避免 [object Object]），截断前先转字符串 */
function stringifyToolOutput(result: unknown): string {
  return typeof result === "object" && result !== null
    ? JSON.stringify(result)
    : String(result);
}

/**
 * 包装工具 invoke：统一记录入参 / 出参 / 耗时日志
 *
 * 通过覆盖实例 invoke 方法实现（StructuredTool 原型方法可被实例属性遮蔽），
 * 在 ALL_TOOLS 注册时统一包装，9 个工具自动覆盖，无需逐文件埋点。
 *
 * 特殊处理：clarify_question 触发的 GraphInterrupt 是正常的 interrupt 暂停，
 * 记为 debug 而非 error，避免误报工具失败。
 *
 * @param tool - 原始工具实例
 * @param toolName - 工具名（用于日志）
 * @returns 包装后的工具实例（类型不变，可直接传给 createReactAgent）
 */
function withToolLog<T extends StructuredToolInterface>(
  tool: T,
  toolName: string,
): T {
  const originalInvoke = tool.invoke.bind(tool) as (
    input: unknown,
    config?: unknown,
  ) => Promise<unknown>;
  (
    tool as unknown as {
      invoke: (input: unknown, config?: unknown) => Promise<unknown>;
    }
  ).invoke = async (input: unknown, config?: unknown) => {
    const start = Date.now();
    toolLogger.debug(
      `[Tool] ${toolName} 入参=${JSON.stringify(input ?? {}).slice(0, 300)}`,
    );
    try {
      const result = await originalInvoke(input, config);
      toolLogger.log(
        `[Tool] ${toolName} ok ${Date.now() - start}ms 出参=${stringifyToolOutput(result).slice(0, 300)}`,
      );
      return result;
    } catch (e) {
      if (e instanceof Error && e.name === "GraphInterrupt") {
        // interrupt 暂停是正常流程（clarify_question），不是失败
        toolLogger.debug(`[Tool] ${toolName} interrupt 暂停`);
      } else {
        toolLogger.error(
          `[Tool] ${toolName} ✗ ${Date.now() - start}ms ${(e as Error).message}`,
        );
      }
      throw e;
    }
  };
  return tool;
}

/**
 * 工具注册列表（供 createReactAgent 使用）
 *
 * 每个工具都用 withToolLog 包装，统一埋入入参/出参/耗时日志。
 */
export const ALL_TOOLS = [
  withToolLog(clarifyQuestionTool, "clarify_question"),
  withToolLog(readFileTool, "read_file"),
  withToolLog(getPlatformFactsTool, "get_platform_facts"),
  withToolLog(planWorkflowTool, "plan_workflow"),
  withToolLog(generateWorkflowTool, "generate_workflow"),
  withToolLog(saveToCozeTool, "save_to_coze"),
  withToolLog(testRunWorkflowTool, "test_run_workflow"),
  withToolLog(batchValidateTool, "batch_validate"),
  withToolLog(updateWorkflowTool, "update_workflow"),
  withToolLog(renameWorkflowTool, "rename_workflow"),
] as const;
