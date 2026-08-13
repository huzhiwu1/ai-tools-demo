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
 * - 使用共享单例 cozeClient（见 coze-client.ts），内部管理编辑锁和重试
 * - try/catch 兜底，错误以字符串返回给 LLM
 * - COZE_API_BASE_URL / COZE_SESSION_KEY / COZE_SPACE_ID 配置集中在 coze-client.ts 中读取
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { CozeWorkflow } from "@coze-workflow/workflow-schema";
import { validateWorkflow } from "@coze-workflow/workflow-schema";
import { checkPlatformCompatibility } from "../../workflow-engine/platform-validator";
import { convertToPlatformSchema } from "../../coze/schema-converter";
import { cozeClient } from "./coze-client";

export const saveToCozeTool = tool(
  async ({ workflow }) => {
    try {
      const cozeWorkflow = workflow as unknown as CozeWorkflow;

      // 1. 结构校验（现有 validateWorkflow，来自 packages/workflow-schema）
      const structValidation = validateWorkflow(cozeWorkflow);
      if (!structValidation.valid) {
        return `保存失败: 工作流结构校验未通过，请先修复:\n${structValidation.errors.map((e) => "- " + e.message).join("\n")}`;
      }

      // 2. 平台兼容性校验（新增，针对已知平台坑）
      const compatResult = checkPlatformCompatibility(cozeWorkflow);
      if (!compatResult.valid) {
        return `保存失败: 平台兼容性校验未通过:\n${compatResult.errors.join("\n")}`;
      }

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
