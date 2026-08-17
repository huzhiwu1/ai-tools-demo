/**
 * [Tool] save_to_coze - 部署工作流到 Coze 平台（句柄化）
 *
 * 职责：
 * 将工作流 JSON（参数或服务端缓存）转换为平台内部 schema，
 * 创建 Coze 工作流并保存。
 *
 * 流程：
 * 1. 解析目标工作流：参数 workflow ?? workflowCache.get(workflowId)（句柄化，缓存 miss 且无参数则报错）
 * 2. convertToPlatformSchema(workflow) → 平台内部 schema JSON 字符串
 * 3. cozeClient.createWorkflow() → 获取 workflowId（首次创建）；传 workflowId 则更新
 * 4. cozeClient.validateTree() → 平台连通性校验（有错误则返回给 LLM，不继续 save）
 * 5. cozeClient.saveWorkflow(workflowId, schemaJson) → 保存
 * 6. 成功后维护缓存：来自缓存的更新 → clearDirty；首次创建 → 写入缓存供后续句柄化复用
 *
 * 关键细节：
 * - 使用共享单例 cozeClient（见 coze-client.ts），内部管理编辑锁和重试
 * - save 失败回滚（dirty 缓存来源）：save 前快照，失败后恢复快照并保持 dirty（修改仍待保存）
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
import { workflowCache } from "../workflow-cache";

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
 * 按名称搜索平台工作流，返回第一个同名的工作流
 *
 * 用于 save 超时/重名时复用已存在的工作流（避免残留空壳 + 平台产生 _2 副本）。
 *
 * @param name - 工作流名称（与创建时同名比较）
 * @returns 同名工作流的 workflowId；查询失败或不存在返回 null（不阻塞主流程）
 */
async function findWorkflowByName(
  name: string,
  spaceId?: string,
): Promise<{ workflowId: string } | null> {
  try {
    const { workflows } = await cozeClient.listWorkflows(50, undefined, spaceId);
    const hit = workflows.find(
      (w) => w.name.toLowerCase() === name.toLowerCase(),
    );
    return hit ? { workflowId: hit.workflowId } : null;
  } catch {
    return null; // 查询失败不阻塞，走原逻辑
  }
}

/**
 * 创建平台工作流：遇"名称已存在"或超时时复用同名工作流（走更新路径）
 *
 * 重名常见场景：同一需求重复保存，此前自动加 _2 后缀会残留多个副本；
 * 超时场景：create 实际可能已成功，重试新建会产生第二个工作流。
 * 两者都改为：查同名工作流，存在则复用其 workflowId（后续走全量更新）。
 * 查不到同名（罕见：大小写/截断差异）时保留 _2 后缀兑底。
 *
 * @param name - 工作流名称
 * @param desc - 工作流描述
 * @returns workflowId 与实际使用的名称（复用场景 usedName 用原名）
 */
async function createWorkflowWithRetry(
  name: string,
  desc: string,
  spaceId?: string,
): Promise<{ workflowId: string; usedName: string }> {
  try {
    const workflowId = await cozeClient.createWorkflow(name, desc, spaceId);
    return { workflowId, usedName: name };
  } catch (e) {
    const msg = (e as Error).message;

    // 超时错误：create 可能已成功 → 查同名复用（避免残留空壳 + 第二个工作流）
    if (/超时|timeout/i.test(msg)) {
      const existing = await findWorkflowByName(name, spaceId);
      if (existing) {
        console.warn(
          `[save_to_coze] create 超时但同名工作流已存在，复用 ${existing.workflowId} 更新`,
        );
        return { workflowId: existing.workflowId, usedName: name };
      }
    }

    // 重名错误：先查同名，存在则复用（不再无脑 _2）
    if (/已存在|exist|duplicate/i.test(msg)) {
      const existing = await findWorkflowByName(name, spaceId);
      if (existing) {
        console.warn(
          `[save_to_coze] 名称冲突，复用同名工作流 ${existing.workflowId} 更新（不新建）`,
        );
        return { workflowId: existing.workflowId, usedName: name };
      }
      // 查不到同名（罕见：可能是大小写/截断差异）→ 保留原 _2 后缀兑底
      for (let i = 2; i <= 4; i++) {
        const candidate = `${sanitizeWorkflowName(name)}_${i}`.slice(0, 50);
        try {
          const workflowId = await cozeClient.createWorkflow(candidate, desc, spaceId);
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

    throw e;
  }
}

export const saveToCozeTool = tool(
  async ({ workflow, workflowId, workflowHandle, spaceId }) => {
    // 1. 解析目标工作流来源：缓存条目（供句柄化取值 + dirty 快照用）
    const cached =
      typeof workflowId === "string" && workflowId.length > 0
        ? workflowCache.get(workflowId)
        : undefined;

    // save 失败回滚快照（缓存来源且 dirty 时）：失败后恢复缓存对象、dirty 保持 true
    let snapshot: Record<string, unknown> | undefined;
    if (cached && cached.dirty) {
      snapshot = JSON.parse(JSON.stringify(cached.workflow)) as Record<
        string,
        unknown
      >;
    }
    const rollbackCache = () => {
      if (cached && snapshot) {
        workflowCache.set(workflowId!, snapshot, {
          commitId: cached.commitId,
        });
        workflowCache.markDirty(workflowId!);
      }
    };

    try {
      // 2. 目标工作流：参数 workflow ?? 服务端缓存（句柄化，workflowId 或 generate 返回的 workflowHandle）
      const source =
        workflow ??
        cached?.workflow ??
        (typeof workflowHandle === "string" && workflowHandle.length > 0
          ? workflowCache.get(workflowHandle)?.workflow
          : undefined);
      if (!source) {
        return "保存失败: 未提供 workflow 且缓存中无此工作流。请先 generate_workflow 生成后再保存";
      }
      const cozeWorkflow = source as unknown as CozeWorkflow;

      // 3. 结构校验（现有 validateWorkflow，来自 packages/workflow-schema）
      const structValidation = validateWorkflow(cozeWorkflow);
      if (!structValidation.valid) {
        return `保存失败: 工作流结构校验未通过，请先修复:\n${structValidation.errors.map((e) => "- " + e.message).join("\n")}`;
      }

      // 4. 平台兼容性校验（新增，针对已知平台坑）
      const compatResult = checkPlatformCompatibility(cozeWorkflow);
      if (!compatResult.valid) {
        return `保存失败: 平台兼容性校验未通过:\n${compatResult.errors.join("\n")}`;
      }

      // 动态拉取模型列表，构建 模型名 → modelType 映射（不硬编码，模型可能变更）
      let modelTypeMap: Record<string, number> | undefined;
      try {
        const models = await cozeClient.listModels(spaceId);
        if (models.length > 0) {
          modelTypeMap = Object.fromEntries(
            models.map((m) => [m.name, m.modelType]),
          );
        }
      } catch {
        // 拉取失败不阻塞保存：converter 内部查不到时默认 201
      }

      const schemaJson = convertToPlatformSchema(cozeWorkflow, modelTypeMap);

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

      // 4. 平台 validate_tree 校验（保存前提前暴露端口未连接等问题，避免"保存 → 平台报错 → 重试"往返）
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
            await cozeClient.deleteWorkflow(platformWorkflowId, spaceId);
          } catch {
            // 删除失败不影响主流程，继续返回错误信息
          }
        }
        // save 失败回滚：恢复缓存快照（dirty 保持 true，修改仍待保存）
        rollbackCache();
        return (
          `${isUpdate ? "更新" : "保存"}失败: 平台 validate_tree 校验未通过` +
          (isUpdate
            ? "（原工作流已保留，修复后重新 save_to_coze 并带上原 workflowId）"
            : "，已删除空壳工作流") +
          `。请修复节点连线后重新保存:\n` +
          errorMessages.map((m) => "- " + m).join("\n")
        );
      }

      const submitCommitId = await cozeClient.saveWorkflow(
        platformWorkflowId,
        schemaJson,
        spaceId,
      );

      // 5. 缓存维护：来自缓存的更新 → clearDirty + 刷新 commitId；
      // 首次创建 → 写缓存（带 commitId，stale 检测基线）；handle 条目用后即删
      if (typeof workflowHandle === "string" && workflowHandle.length > 0) {
        workflowCache.remove(workflowHandle);
      }
      if (cached) {
        workflowCache.clearDirty(platformWorkflowId);
        workflowCache.set(
          platformWorkflowId,
          cozeWorkflow as unknown as Record<string, unknown>,
          {
            commitId: submitCommitId,
          },
        );
      } else {
        workflowCache.set(
          platformWorkflowId,
          cozeWorkflow as unknown as Record<string, unknown>,
          { commitId: submitCommitId },
        );
      }

      return JSON.stringify(
        {
          workflowId: platformWorkflowId,
          saved: true,
          name: usedName,
          updated: isUpdate,
        },
        null,
        2,
      );
    } catch (e) {
      // save 异常失败：恢复缓存快照（dirty 保持 true，修改仍待保存）
      rollbackCache();
      return `保存失败: ${(e as Error).message}`;
    }
  },
  {
    name: "save_to_coze",
    description:
      "将工作流部署到 Coze 平台。**不传 workflowId 时创建新的工作流并保存**；" +
      "**传 workflowId 时更新该已有工作流**（修复迭代场景：update_workflow 修改后重新保存，" +
      "必须把原 workflowId 传入，避免每次修复都新建工作流）。" +
      "workflow 参数可选（句柄化）：优先传 generate_workflow 返回的 workflowHandle，" +
      "或修复迭代时只传 workflowId 从服务端缓存获取。返回平台分配的 workflowId。",
    schema: z.object({
      workflow: z
        .record(z.string(), z.any())
        .optional()
        .describe(
          "可选。工作流 JSON。不传时从服务端缓存按 workflowId / workflowHandle 获取（句柄化）",
        ),
      workflowHandle: z
        .string()
        .optional()
        .describe(
          "generate_workflow 返回的 workflowHandle 句柄（推荐首次保存时传，工具从缓存取工作流）",
        ),
      workflowId: z
        .string()
        .optional()
        .describe("已有工作流 ID（可选）。传了=更新该工作流；不传=首次创建"),
      spaceId: z.string().optional().describe("目标空间 ID（缺省用 .env 的 COZE_SPACE_ID）"),
    }),
  },
);
