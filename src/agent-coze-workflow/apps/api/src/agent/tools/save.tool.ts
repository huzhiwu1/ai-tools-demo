/**
 * [Tool] save_to_coze - 部署工作流到 Coze 平台
 *
 * 职责：
 * 将 generate_workflow 输出的工作流 JSON 转换为平台内部 schema，
 * 创建 Coze 工作流并保存。
 *
 * 流程：
 * 1. convertToPlatformSchema(workflow) → 平台内部 schema JSON 字符串
 * 2. cozeClient.createWorkflow() → 获取 workflowId
 * 3. cozeClient.saveWorkflow(workflowId, schemaJson) → 保存
 *
 * 关键细节：
 * - 使用模块级单例 cozeClient，内部管理编辑锁和重试
 * - try/catch 兜底，错误以字符串返回给 LLM
 * - .env 中的 COZE_API_BASE_URL / COZE_SESSION_KEY / COZE_SPACE_ID 由 CozeClient 内部读取
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { CozeWorkflow } from "@coze-workflow/workflow-schema";
import { CozeClient } from "../../mcp/cozeClient";
import { convertToPlatformSchema } from "../../mcp/schema-converter";

/** 模块级单例：cozeClient 内部管理编辑锁状态 */
const cozeClient = new CozeClient({
  baseUrl: process.env.COZE_API_BASE_URL ?? "",
  sessionKey: process.env.COZE_SESSION_KEY ?? "",
  spaceId: process.env.COZE_SPACE_ID ?? "",
});

export const saveToCozeTool = tool(
  async ({ workflow }) => {
    try {
      const cozeWorkflow = workflow as unknown as CozeWorkflow;
      const schemaJson = convertToPlatformSchema(cozeWorkflow);
      const workflowId = await cozeClient.createWorkflow(
        cozeWorkflow.meta.name,
        cozeWorkflow.meta.description,
      );
      await cozeClient.saveWorkflow(workflowId, schemaJson);
      return JSON.stringify({ workflowId, saved: true }, null, 2);
    } catch (e) {
      return `保存失败: ${(e as Error).message}`;
    }
  },
  {
    name: "save_to_coze",
    description:
      "将 generate_workflow 生成的工作流 JSON 部署到 Coze 平台。创建新的工作流并保存，" +
      "返回平台分配的 workflowId。",
    schema: z.object({
      workflow: z
        .record(z.string(), z.any())
        .describe(
          "generate_workflow 返回的工作流 JSON 中的 workflow 字段（含 meta、nodes、edges）",
        ),
    }),
  },
);
