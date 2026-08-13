/**
 * [Tool] batch_validate - 批量验证工作流
 *
 * 职责：
 * 对已部署的工作流批量试运行，轮询执行结果，对照期望值验证准确性，
 * 汇总准确率和错误明细，供 LLM 归因分析。
 *
 * 流程：
 * 1. 遍历 cases（串行，默认间隔 5s 轮询）
 * 2. 每个用例：testRun → 轮询 getProcess（每 5s，最多 5min）→ 比对
 * 3. 汇总：accuracy + details + failurePatterns（归因分组）
 *
 * 关键细节：
 * - 串行执行优先（稳），避免平台限流
 * - 5 分钟超时上限（含 LLM 的工作流运行缓慢），超时标记 executionError 继续下一个
 * - getProcess 用 workflow_id + execute_id 查询，executeStatus=2 表示完成，
 *   从 end 节点的 output 提取实际输出
 * - try/catch 兜底，错误以字符串返回给 LLM
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { cozeClient } from "./coze-client";
import {
  incrementIteration,
  MAX_ITERATIONS,
  iterationLimitMessage,
} from "./iteration-counter";

/** 轮询间隔（ms） — 工作流可能运行缓慢，5 秒轮询避免频繁请求 */
const POLL_INTERVAL_MS = 5_000;
/** 轮询超时（ms） — 一些工作流（含 LLM）运行缓慢，5 分钟超时 */
const POLL_TIMEOUT_MS = 300_000;

/**
 * 睡眠指定毫秒
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 递归提取执行输出中的字符串值
 *
 * 工作流 end 节点返回值可能嵌套在 data.output、output 等多层中。
 */
function extractOutputString(output: unknown): string {
  if (typeof output === "string") return output;
  if (typeof output === "number" || typeof output === "boolean") {
    return String(output);
  }
  if (output === null || output === undefined) return "";
  if (typeof output === "object") {
    if (Array.isArray(output)) {
      for (const item of output) {
        const s = extractOutputString(item);
        if (s) return s;
      }
      return "";
    }
    const obj = output as Record<string, unknown>;
    for (const key of ["output", "result", "text", "content"]) {
      if (key in obj && obj[key] !== null && obj[key] !== undefined) {
        const s = extractOutputString(obj[key]);
        if (s) return s;
      }
    }
    for (const key of Object.keys(obj)) {
      const s = extractOutputString(obj[key]);
      if (s) return s;
    }
  }
  return "";
}

export const batchValidateTool = tool(
  async ({ workflowId, cases: rawCases }) => {
    // 迭代计数：每次调用 +1，超过上限直接返回错误，不执行验证
    const iteration = incrementIteration(workflowId);
    if (iteration > MAX_ITERATIONS) {
      return iterationLimitMessage(workflowId);
    }

    try {
      const cases = rawCases as Array<{
        input: Record<string, unknown>;
        expected: string;
      }>;

      if (!cases || cases.length === 0) {
        return "批量验证失败: cases 不能为空，至少需要 1 个测试用例";
      }

      const details: Array<{
        input: Record<string, unknown>;
        expected: string;
        actual: string;
        match: boolean;
        error?: string;
      }> = [];

      const failurePatterns = {
        emptyOutput: 0,
        mismatch: 0,
        executionError: 0,
      };

      for (const testCase of cases) {
        const { input, expected } = testCase;

        try {
          const executeId = await cozeClient.testRun(workflowId, input);

          let actual = "";
          let pollError = "";
          const startTime = Date.now();

          while (Date.now() - startTime < POLL_TIMEOUT_MS) {
            await sleep(POLL_INTERVAL_MS);

            try {
              const result = await cozeClient.getProcess(workflowId, executeId);

              if (result.executeStatus === 2) {
                // 已完成：从 end 节点的 output 提取结果
                const endNode = result.nodeResults.find(
                  (n) => n.NodeType === "End",
                );
                actual = endNode ? extractOutputString(endNode.output) : "";
                if (!actual) {
                  pollError = "执行完成但 end 节点无输出";
                }
                break;
              }

              if (result.executeStatus === 3) {
                // 失败：从失败节点收集错误信息
                const failedNode = result.nodeResults.find(
                  (n) => n.nodeStatus === 4,
                );
                pollError =
                  failedNode?.errorInfo ||
                  result.reason ||
                  "执行失败（无错误信息）";
                break;
              }
            } catch (e) {
              pollError = `查询执行结果失败: ${(e as Error).message}`;
              break;
            }
          }

          if (!actual && !pollError) {
            pollError = "执行超时（超过 90 秒）";
          }

          if (pollError) {
            failurePatterns.executionError++;
            details.push({
              input,
              expected,
              actual: "",
              match: false,
              error: pollError,
            });
          } else if (!actual) {
            failurePatterns.emptyOutput++;
            details.push({
              input,
              expected,
              actual: "",
              match: false,
              error: "输出为空",
            });
          } else if (actual === expected) {
            details.push({ input, expected, actual, match: true });
          } else {
            failurePatterns.mismatch++;
            details.push({
              input,
              expected,
              actual,
              match: false,
              error: `期望 "${expected}"，实际 "${actual}"`,
            });
          }
        } catch (e) {
          failurePatterns.executionError++;
          details.push({
            input,
            expected,
            actual: "",
            match: false,
            error: (e as Error).message,
          });
        }
      }

      const passed = details.filter((d) => d.match).length;
      const failed = details.length - passed;
      const accuracy =
        details.length > 0
          ? Number(((passed / details.length) * 100).toFixed(1))
          : 0;

      return JSON.stringify(
        {
          total: details.length,
          passed,
          failed,
          accuracy,
          details,
          failurePatterns,
        },
        null,
        2,
      );
    } catch (e) {
      return `批量验证失败: ${(e as Error).message}`;
    }
  },
  {
    name: "batch_validate",
    description:
      "批量试运行已部署的工作流，对照期望值验证准确性。传入 cases 列表（由 LLM 构造），" +
      "每个用例含 input 和 expected，串行执行并返回 accuracy + 错误明细 + 归因分组。" +
      "用于验证闭环：accuracy < 100% 时分析 failurePatterns 归因，调用 update_workflow 修改后重新验证。",
    schema: z.object({
      workflowId: z.string().describe("save_to_coze 返回的 workflowId"),
      cases: z
        .array(
          z.object({
            input: z
              .record(z.string(), z.any())
              .describe("试运行输入参数（JSON 对象）"),
            expected: z.string().describe("期望的输出结果（字符串，用于比对）"),
          }),
        )
        .describe(
          "测试用例列表，由 LLM 根据用户需求 + 文件内容构造。每个用例含 input 和 expected",
        ),
    }),
  },
);
