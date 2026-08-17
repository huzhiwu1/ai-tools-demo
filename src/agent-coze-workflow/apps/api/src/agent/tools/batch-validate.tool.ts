/**
 * [Tool] batch_validate - 批量验证工作流
 *
 * 职责：
 * 对已部署的工作流批量试运行，轮询执行结果，对照期望值验证准确性，
 * 汇总准确率和错误明细，供 LLM 归因分析。
 *
 * 流程：
 * 1. 3 路并发执行用例（worker pool，间隔 5s 轮询，单用例 120s 超时）
 * 2. 每个用例：testRun → 轮询 getProcess → 比对
 * 3. 早期终止：最早完成的 5 个用例全失败 → abort 剩余用例，立即返回
 * 4. 汇总：accuracy + 失败明细（截断）+ failurePatterns（归因分组）
 *
 * 关键细节：
 * - 并发 + 限流：手写 worker pool（3 路），不引入 p-limit 依赖；
 *   20 个用例最坏 7 轮 × 120s ≈ 14 分钟上限，远优于原串行 100 分钟
 * - 结果截断（控制返回 token，防撑爆上下文）：
 *   details 只保留失败用例（passed 只计数）；失败 >10 个只留前 10 个；
 *   actual 截断 200 字符；input 只保留非空值最多 3 个 key
 * - 早期终止用 AbortController：in-flight 用例轮询感知 signal 立即退出，
 *   未完成用例计 unexecuted，不污染 accuracy
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
/** 单用例轮询超时（ms） — 含 LLM 节点的工作流运行缓慢，但 2 分钟够用 */
const POLL_TIMEOUT_MS = 120_000;
/** 并发数 — 3 路并发 + 限流，避免平台限流 */
const CONCURRENCY = 3;
/** 结果截断：details 最多保留的失败用例数 */
const MAX_FAILURE_DETAILS = 10;
/** 结果截断：actual 最大字符数 */
const ACTUAL_MAX_CHARS = 200;
/** 结果截断：input 最多保留的 key 数 */
const INPUT_MAX_KEYS = 3;
/** 早期终止：最早完成的 N 个用例全部失败时终止（accuracy = 0% 场景） */
const EARLY_STOP_MIN_COMPLETED = 5;

/** 单个用例的验证结果（details 条目） */
interface CaseDetail {
  input: Record<string, unknown>;
  expected: string;
  actual: string;
  match: boolean;
  error?: string;
}

/** 单用例执行结果：done = 有结论（pass/失败归类）；skipped = 早期终止未完成 */
type CaseOutcome =
  | {
      kind: "done";
      detail: CaseDetail;
      pattern: "pass" | "emptyOutput" | "mismatch" | "executionError";
    }
  | { kind: "skipped" };

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

/**
 * 截断 input：只保留非空值，最多 INPUT_MAX_KEYS 个 key
 *
 * 空值对归因无意义，key 数量过多会放大返回 token。
 */
function truncateInput(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const nonEmpty = Object.entries(input).filter(
    ([, value]) => value !== null && value !== undefined && value !== "",
  );
  return Object.fromEntries(nonEmpty.slice(0, INPUT_MAX_KEYS));
}

/**
 * 执行单个用例：testRun → 轮询 getProcess（每 5s，最多 120s）→ 比对
 *
 * 轮询循环感知 signal：早期终止时立即退出（含睡眠醒来后的二次检查），
 * 返回 skipped，该用例不计入 accuracy。
 *
 * @param workflowId - 已部署工作流 ID
 * @param testCase - 用例（input + expected）
 * @param signal - 早期终止信号
 * @returns 执行结果（done 或 skipped）
 */
async function runCase(
  workflowId: string,
  testCase: { input: Record<string, unknown>; expected: string },
  signal: AbortSignal,
): Promise<CaseOutcome> {
  const { input, expected } = testCase;

  try {
    const executeId = await cozeClient.testRun(workflowId, input);

    let actual = "";
    let pollError = "";
    const startTime = Date.now();

    while (!signal.aborted && Date.now() - startTime < POLL_TIMEOUT_MS) {
      await sleep(POLL_INTERVAL_MS);

      // 睡眠期间可能被终止：醒来后再检查一次，避免多打一次无效请求
      if (signal.aborted) return { kind: "skipped" };

      try {
        const result = await cozeClient.getProcess(workflowId, executeId);

        if (result.executeStatus === 2) {
          // 已完成：从 end 节点的 output 提取结果
          const endNode = result.nodeResults.find((n) => n.NodeType === "End");
          actual = endNode ? extractOutputString(endNode.output) : "";
          if (!actual) {
            pollError = "执行完成但 end 节点无输出";
          }
          break;
        }

        if (result.executeStatus === 3) {
          // 失败：从失败节点收集错误信息
          const failedNode = result.nodeResults.find((n) => n.nodeStatus === 4);
          pollError =
            failedNode?.errorInfo || result.reason || "执行失败（无错误信息）";
          break;
        }
      } catch (e) {
        pollError = `查询执行结果失败: ${(e as Error).message}`;
        break;
      }
    }

    // 轮询退出后再次检查：可能是终止信号（比超时优先级高）
    if (signal.aborted) return { kind: "skipped" };

    if (!actual && !pollError) {
      pollError = `执行超时（超过 ${POLL_TIMEOUT_MS / 1000} 秒）`;
    }

    const trimmedActual = actual.slice(0, ACTUAL_MAX_CHARS);

    if (pollError) {
      return {
        kind: "done",
        pattern: "executionError",
        detail: {
          input: truncateInput(input),
          expected,
          actual: "",
          match: false,
          error: pollError,
        },
      };
    }
    if (!actual) {
      return {
        kind: "done",
        pattern: "emptyOutput",
        detail: {
          input: truncateInput(input),
          expected,
          actual: "",
          match: false,
          error: "输出为空",
        },
      };
    }
    if (actual === expected) {
      return {
        kind: "done",
        pattern: "pass",
        detail: {
          input: truncateInput(input),
          expected,
          actual: trimmedActual,
          match: true,
        },
      };
    }
    return {
      kind: "done",
      pattern: "mismatch",
      detail: {
        input: truncateInput(input),
        expected,
        actual: trimmedActual,
        match: false,
        error: `期望 "${expected}"，实际 "${trimmedActual}"`,
      },
    };
  } catch (e) {
    if (signal.aborted) return { kind: "skipped" };
    return {
      kind: "done",
      pattern: "executionError",
      detail: {
        input: truncateInput(input),
        expected,
        actual: "",
        match: false,
        error: (e as Error).message,
      },
    };
  }
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

      // 并发池共享状态（JS 单线程，worker 之间通过闭包协作，无竞态）
      const earlyStop = new AbortController();
      let nextIndex = 0;
      let completed = 0;
      let passed = 0;
      let terminatedEarly = false;
      const failedDetails: CaseDetail[] = [];
      const failurePatterns = {
        emptyOutput: 0,
        mismatch: 0,
        executionError: 0,
      };

      /**
       * 每完成一个用例后统一收口：统计 + 失败明细收集 + 早期终止判断
       *
       * 早期终止条件：最早完成的 5 个用例全部失败（passed = 0）。
       * abort 后：未启动用例不再调度，in-flight 用例轮询感知 signal 立即退出。
       */
      const recordOutcome = (outcome: CaseOutcome): void => {
        if (outcome.kind !== "done") return;
        completed += 1;
        const { detail, pattern } = outcome;
        if (pattern === "pass") {
          passed += 1;
          return;
        }
        failurePatterns[pattern] += 1;
        failedDetails.push(detail);
        if (
          !terminatedEarly &&
          completed >= EARLY_STOP_MIN_COMPLETED &&
          passed === 0
        ) {
          terminatedEarly = true;
          earlyStop.abort();
        }
      };

      /** worker：循环领取用例直到队列耗尽或早期终止 */
      const worker = async (): Promise<void> => {
        while (!terminatedEarly) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= cases.length) return;
          const outcome = await runCase(
            workflowId,
            cases[index],
            earlyStop.signal,
          );
          recordOutcome(outcome);
        }
      };

      // 启动并发 worker（用例少于并发数时只启动需要的数量）
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, cases.length) }, () =>
          worker(),
        ),
      );

      const failed = failedDetails.length;
      const accuracy =
        completed > 0 ? Number(((passed / completed) * 100).toFixed(1)) : 0;
      const omittedFailures =
        failed > MAX_FAILURE_DETAILS ? failed - MAX_FAILURE_DETAILS : 0;
      const unexecuted = cases.length - completed;

      return JSON.stringify(
        {
          total: cases.length,
          completed,
          passed,
          failed,
          accuracy,
          terminatedEarly,
          ...(terminatedEarly
            ? {
                terminationReason: `最早完成的 ${EARLY_STOP_MIN_COMPLETED} 个用例全部失败（accuracy 0%），已提前终止验证`,
              }
            : {}),
          unexecuted,
          details: failedDetails.slice(0, MAX_FAILURE_DETAILS),
          ...(omittedFailures > 0 ? { omittedFailures } : {}),
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
      "每个用例含 input 和 expected，3 路并发执行并返回 accuracy + 失败明细 + 归因分组。" +
      "失败明细只含失败用例（最多 10 个），用于验证闭环：accuracy < 100% 时分析 " +
      "failurePatterns 归因，调用 update_workflow 修改后重新验证。",
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
