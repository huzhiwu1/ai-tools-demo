/**
 * [Tool] test_run_workflow - 试运行工作流
 *
 * 职责：
 * 对已保存到 Coze 平台的工作流进行试运行，返回 executeId。
 *
 * 关键细节：
 * - 使用共享单例 cozeClient（见 coze-client.ts，与 save.tool.ts 共用同一实例）
 * - response_format 可指定输出格式（可选，默认不传）
 * - try/catch 兜底，错误以字符串返回给 LLM
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { cozeClient } from "./coze-client";

export const testRunWorkflowTool = tool(
  async ({ workflowId, input }) => {
    try {
      const executeId = await cozeClient.testRun(
        workflowId,
        (input ?? {}) as Record<string, unknown>,
      );
      return JSON.stringify({ executeId, workflowId }, null, 2);
    } catch (e) {
      return `试运行失败: ${(e as Error).message}`;
    }
  },
  {
    name: "test_run_workflow",
    description:
      "对已保存到 Coze 平台的工作流进行试运行测试，返回 executeId（执行 ID），" +
      "可用于后续在 Coze 平台查看运行日志。",
    schema: z.object({
      workflowId: z.string().describe("save_to_coze 返回的 workflowId"),
      input: z
        .record(z.string(), z.any())
        .optional()
        .describe("可选的试运行输入参数（JSON 对象），不传则使用默认空输入"),
    }),
  },
);
