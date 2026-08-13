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
 * 3. cozeClient.validateTree() → 平台连通性校验（有错误则返回给 LLM，不继续 save）
 * 4. cozeClient.saveWorkflow(workflowId, schemaJson) → 保存
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
import { resetIteration } from "./iteration-counter";

/**
 * 清洗工作流名称：平台只允许字母开头 + 字母/数字/下划线，长度 ≤ 50
 *
 * @param name - 原始名称
 * @returns 平台合法的英文工作流名（空输入降级为 "workflow"）
 */
function sanitizeWorkflowName(name: string): string {
  return (
    name
      .replace(/[^a-zA-Z0-9_]/g, "_")
      .replace(/^[^a-zA-Z]+/, "")
      .slice(0, 50) || "workflow"
  );
}

/**
 * 创建平台工作流，遇"名称已存在"时自动加 _2/_3 后缀重试（最多 3 次）
 *
 * 名称冲突是常见场景（同一需求重复保存），兜底自动改名避免把冲突抛给 Agent
 * 瞎转；若 Agent 想保留特定名称，可用 rename_workflow 先改名再保存。
 *
 * @param name - 工作流名称
 * @param desc - 工作流描述
 * @returns 成功创建的 workflowId 与实际使用的名称
 */
async function createWorkflowWithRetry(
  name: string,
  desc: string,
): Promise<{ workflowId: string; usedName: string }> {
  try {
    const workflowId = await cozeClient.createWorkflow(name, desc);
    return { workflowId, usedName: name };
  } catch (e) {
    const msg = (e as Error).message;
    // 非重名错误直接抛
    if (!/已存在|exist|duplicate/i.test(msg)) throw e;

    // 名称冲突：自动加后缀重试（_2, _3, _4）
    for (let i = 2; i <= 4; i++) {
      const candidate = `${sanitizeWorkflowName(name)}_${i}`.slice(0, 50);
      try {
        const workflowId = await cozeClient.createWorkflow(candidate, desc);
        console.warn(`[save_to_coze] 名称冲突，使用 ${candidate} 保存`);
        return { workflowId, usedName: candidate };
      } catch (e2) {
        const m2 = (e2 as Error).message;
        // 非重名错误直接抛（重名继续下一轮）
        if (!/已存在|exist|duplicate/i.test(m2)) throw e2;
      }
    }
    throw new Error(
      `工作流名称冲突且自动重试失败（${sanitizeWorkflowName(name)}_2 ~ _4 均占用），请用 rename_workflow 改名后重试`,
    );
  }
}

export const saveToCozeTool = tool(
  async ({ workflow, workflowId }) => {
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

      // 动态拉取模型列表，构建 模型名 → modelType 映射（不硬编码，模型可能变更）
      let modelTypeMap: Record<string, number> | undefined;
      try {
        const models = await cozeClient.listModels();
        if (models.length > 0) {
          modelTypeMap = Object.fromEntries(
            models.map((m) => [m.name, m.modelType]),
          );
        }
      } catch {
        // 拉取失败不阻塞保存：converter 内部查不到时默认 201
      }

      const schemaJson = convertToPlatformSchema(
        cozeWorkflow,
        modelTypeMap,
      );

      // 目标工作流：传了 workflowId → 更新已有工作流（修复迭代用，不新建）；
      // 没传 → 首次创建（名称冲突自动加后缀重试 _2/_3/_4）
      const isUpdate = typeof workflowId === "string" && workflowId.length > 0;
      let platformWorkflowId: string;
      let usedName: string;
      if (isUpdate) {
        platformWorkflowId = workflowId;
        usedName = cozeWorkflow.meta.name;
      } else {
        const created = await createWorkflowWithRetry(
          cozeWorkflow.meta.name,
          cozeWorkflow.meta.description,
        );
        platformWorkflowId = created.workflowId;
        usedName = created.usedName;
      }

      // 3. 平台 validate_tree 校验（保存前提前暴露端口未连接等问题，避免"保存 → 平台报错 → 重试"往返）
      const validationErrors = await cozeClient.validateTree(
        platformWorkflowId,
        schemaJson,
      );
      const errorMessages = validationErrors.flatMap((item) =>
        item.errors.map((e) => e.message),
      );
      if (errorMessages.length > 0) {
        // 仅首次创建时删除空壳工作流；更新已有工作流时保留原工作流（修复迭代不删）
        if (!isUpdate) {
          try {
            await cozeClient.deleteWorkflow(platformWorkflowId);
          } catch {
            // 删除失败不影响主流程，继续返回错误信息
          }
        }
        return (
          `${isUpdate ? "更新" : "保存"}失败: 平台 validate_tree 校验未通过` +
          (isUpdate ? "（原工作流已保留，修复后重新 save_to_coze 并带上原 workflowId）" : "，已删除空壳工作流") +
          `。请修复节点连线后重新保存:\n` +
          errorMessages.map((m) => "- " + m).join("\n")
        );
      }

      await cozeClient.saveWorkflow(platformWorkflowId, schemaJson);
      resetIteration(platformWorkflowId);
      return JSON.stringify(
        { workflowId: platformWorkflowId, saved: true, name: usedName, updated: isUpdate },
        null,
        2,
      );
    } catch (e) {
      return `保存失败: ${(e as Error).message}`;
    }
  },
  {
    name: "save_to_coze",
    description:
      "将工作流 JSON 部署到 Coze 平台。**不传 workflowId 时创建新的工作流并保存**；" +
      "**传 workflowId 时更新该已有工作流**（修复迭代场景：update_workflow 修改后重新保存，" +
      "必须把原 workflowId 传入，避免每次修复都新建工作流）。" +
      "返回平台分配的 workflowId。",
    schema: z.object({
      workflow: z
        .record(z.string(), z.any())
        .describe(
          "generate_workflow 返回的工作流 JSON 中的 workflow 字段（含 meta、nodes、edges）",
        ),
      workflowId: z
        .string()
        .optional()
        .describe(
          "已有工作流的 workflowId（可选）。修复迭代时传入，更新该工作流而非新建；首次创建时不要传",
        ),
    }),
  },
);
