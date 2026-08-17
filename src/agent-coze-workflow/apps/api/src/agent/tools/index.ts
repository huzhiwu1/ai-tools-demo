/**
 * 工具注册列表
 *
 * 职责：
 * 汇总所有工具，供 ReactAgentService 自建主循环使用。
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
export { listWorkflowsTool } from "./list-workflows.tool";
export { readWorkflowTool } from "./read-workflow.tool";

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
import { listWorkflowsTool } from "./list-workflows.tool";
import { readWorkflowTool } from "./read-workflow.tool";

const toolLogger = new Logger("Tool");

/** 工具调用默认超时（ms）—— 单个工具超过 120 秒判定为卡死，放弃等待 */
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

/** 长任务工具单独超时（ms）—— batch_validate 含平台侧工作流执行，放宽到 300 秒 */
const TOOL_TIMEOUT_OVERRIDES: Record<string, number> = {
  batch_validate: 300_000,
};

/** 工具出参转字符串：对象序列化为 JSON（避免 [object Object]），截断前先转字符串 */
function stringifyToolOutput(result: unknown): string {
  return typeof result === "object" && result !== null
    ? JSON.stringify(result)
    : String(result);
}

/**
 * 包装工具 invoke：为每次调用包裹超时控制（需求 3.3）
 *
 * 单个工具调用超过阈值后放弃等待，返回「工具调用超时」提示给 LLM，
 * 不中断整个 Agent 流。JS 无法强制终止 Promise，底层任务继续在后台跑，
 * 但超时后其结果被丢弃、后续错误被吞掉，避免 unhandledRejection。
 *
 * @param tool - 原始工具实例
 * @param toolName - 工具名（用于超时提示）
 * @param timeoutMs - 超时阈值（ms）
 * @returns 包装后的工具实例（类型不变）
 */
function withToolTimeout<T extends StructuredToolInterface>(
  tool: T,
  toolName: string,
  timeoutMs: number,
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
    const task = originalInvoke(input, config);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        task,
        new Promise<string>((resolve) => {
          timer = setTimeout(() => {
            // 超时：底层任务继续跑，但结果不再回传给 Agent；
            // 挂 catch 吞掉它后续的错误，避免 unhandledRejection 崩溃进程
            task.catch(() => {
              /* 超时后的底层错误已被丢弃 */
            });
            resolve(
              `工具 ${toolName} 调用超时（超过 ${Math.round(timeoutMs / 1000)} 秒），` +
                "已放弃等待。请告知用户该操作耗时过长，或换更小的验证集重试。",
            );
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  return tool;
}

/**
 * 包装工具 invoke：统一记录入参 / 出参 / 耗时日志
 *
 * 通过覆盖实例 invoke 方法实现（StructuredTool 原型方法可被实例属性遮蔽），
 * 在 ALL_TOOLS 注册时统一包装，12 个工具自动覆盖，无需逐文件埋点。
 *
 * @param tool - 原始工具实例
 * @param toolName - 工具名（用于日志）
 * @returns 包装后的工具实例（类型不变，可直接传给 bindTools）
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
      toolLogger.error(
        `[Tool] ${toolName} ✗ ${Date.now() - start}ms ${(e as Error).message}`,
      );
      throw e;
    }
  };
  return tool;
}

/**
 * 工具注册列表（供自建主循环 bindTools 使用）
 *
 * 每个工具都用 withToolLog 包装，统一埋入入参/出参/耗时日志。
 */
export const ALL_TOOLS = [
  withToolLog(
    withToolTimeout(
      clarifyQuestionTool,
      "clarify_question",
      DEFAULT_TOOL_TIMEOUT_MS,
    ),
    "clarify_question",
  ),
  withToolLog(
    withToolTimeout(readFileTool, "read_file", DEFAULT_TOOL_TIMEOUT_MS),
    "read_file",
  ),
  withToolLog(
    withToolTimeout(
      getPlatformFactsTool,
      "get_platform_facts",
      DEFAULT_TOOL_TIMEOUT_MS,
    ),
    "get_platform_facts",
  ),
  withToolLog(
    withToolTimeout(planWorkflowTool, "plan_workflow", DEFAULT_TOOL_TIMEOUT_MS),
    "plan_workflow",
  ),
  withToolLog(
    withToolTimeout(
      generateWorkflowTool,
      "generate_workflow",
      DEFAULT_TOOL_TIMEOUT_MS,
    ),
    "generate_workflow",
  ),
  withToolLog(
    withToolTimeout(saveToCozeTool, "save_to_coze", DEFAULT_TOOL_TIMEOUT_MS),
    "save_to_coze",
  ),
  withToolLog(
    withToolTimeout(
      listWorkflowsTool,
      "list_workflows",
      DEFAULT_TOOL_TIMEOUT_MS,
    ),
    "list_workflows",
  ),
  withToolLog(
    withToolTimeout(readWorkflowTool, "read_workflow", DEFAULT_TOOL_TIMEOUT_MS),
    "read_workflow",
  ),
  withToolLog(
    withToolTimeout(
      testRunWorkflowTool,
      "test_run_workflow",
      DEFAULT_TOOL_TIMEOUT_MS,
    ),
    "test_run_workflow",
  ),
  withToolLog(
    withToolTimeout(
      batchValidateTool,
      "batch_validate",
      TOOL_TIMEOUT_OVERRIDES["batch_validate"],
    ),
    "batch_validate",
  ),
  withToolLog(
    withToolTimeout(
      updateWorkflowTool,
      "update_workflow",
      DEFAULT_TOOL_TIMEOUT_MS,
    ),
    "update_workflow",
  ),
  withToolLog(
    withToolTimeout(
      renameWorkflowTool,
      "rename_workflow",
      DEFAULT_TOOL_TIMEOUT_MS,
    ),
    "rename_workflow",
  ),
] as const;
