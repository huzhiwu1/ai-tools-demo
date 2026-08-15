/**
 * [Tool] update_workflow - 工作流更新（句柄化 + op 化）
 *
 * 职责：
 * 按结构化操作指令（op）修改工作流节点字段。LLM 直接输出 operations
 * 数组（主路径，零解析），代码按 op 确定性执行；fixInstruction 自然语言
 * 作为兼容入口，内部解析为 operations 后执行。
 * 替代旧 {type, target, content} + 每 type 一套正则猜句式的解析方式。
 *
 * 流程：
 * 1. iteration 计数检查（修 off-by-one：>= MAX_ITERATIONS 拒绝）
 * 2. 解析工作流来源：参数 workflow ?? workflowCache.get(workflowId)，
 *    缓存/参数都没有则报错
 * 3. stale 检测（缓存命中时）：比对平台 submit_commit_id，
 *    线上被外部修改则刷新缓存并提示
 * 4. operations 来源：参数直传（主路径）→ fixInstruction 解析（兼容）
 * 5. applyOperations 深拷贝后逐条执行，返回 changes/errors 汇总
 * 6. changes > 0 → 写回缓存 + markDirty + 迭代计数 +1；全失败不计数
 * 7. 返回 changes 摘要（不再返回完整 workflow）
 *
 * 关键细节：
 * - 本工具不调平台保存 API（save_to_coze 负责保存），仅 stale 检测时调 getSchema
 * - 句柄化：LLM 不传大 JSON，只传 workflowId + operations，从服务端缓存取工作流
 * - stale 检测失败（拿不到平台最新版本）直接报错，防止旧缓存覆盖平台侧人工修改
 * - applyOperations 深拷贝返回新对象：不污染缓存原对象，save 失败可回滚
 * - 一期 op：set / set_ref / rewrite_code；delete_node / delete_edge 二期未启用
 * - LLM 解析失败降级：返回明确错误字符串，引导 LLM 直接输出 operations
 * - 找不到 target 返回"未找到节点: xxx"
 * - try/catch 兜底，错误以字符串返回给 LLM
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { CozeWorkflow } from "@coze-workflow/workflow-schema";
import { DeepSeekClient } from "../../llm/deepseek.client";
import { CodeGenerator } from "../../workflow-engine/code-generator";
import { platformToProject } from "../../workflow-engine/platform-to-project";
import { workflowCache } from "../workflow-cache";
import { cozeClient } from "./coze-client";
import {
  incrementIteration,
  peekIteration,
  MAX_ITERATIONS,
  iterationLimitMessage,
} from "./iteration-counter";
import {
  UpdateOperationSchema,
  UpdateOperationsParseSchema,
  normalizeOperations,
  applyOperations,
} from "../operations";

/** 模块级单例：无状态可安全共享，LLM 失败内部已降级 */
const client = new DeepSeekClient();
const codeGenerator = new CodeGenerator(client);

/**
 * 生成工作流节点摘要（id/title/type），帮助 LLM 定位 target 节点
 *
 * @param workflow - 当前工作流 JSON
 */
function summarizeNodes(
  workflow: unknown,
): Array<{ id: string; title: string; type: string }> {
  const wf = workflow as Record<string, unknown>;
  const nodes = (wf?.nodes as Array<Record<string, unknown>>) ?? [];
  return nodes.map((n) => ({
    id: String(n.id ?? ""),
    title: String(n.title ?? ""),
    type: String(n.type ?? ""),
  }));
}

/**
 * fixInstruction 解析的 system prompt：手动描述 op 结构
 *
 * DeepSeek jsonMode 不自动注入 schema（deepseek.client.ts 注释），
 * 且 discriminatedUnion 的 toJsonSchema 没有顶层 properties，
 * describeSchemaFields 拿到空串——所以输出格式必须在 prompt 里写清楚。
 */
const PARSE_SYSTEM_PROMPT =
  "你是工作流修改指令解析器。将用户的自然语言修改指令解析为操作数组，输出 JSON 数组。" +
  "每个元素是以下三种操作之一（op 字段区分）：" +
  '1. {op:"set", target:"节点title或id", field:"白名单字段", value:新值}——改字段。' +
  "白名单字段：config.model（模型名，字符串）/ userPrompt / systemPrompt / code / language（以上字符串值）；" +
  "branches（条件分支数组，元素形状 {expression:条件表达式, targetNodeId:跳转节点id}）/ outputs / outputVariables / inputVariables（以上数组值）；data（任意 JSON）。" +
  '2. {op:"set_ref", target:"结束节点", outputName:"输出变量名", ref:"nodeId.outputName"}——改结束节点输出引用。' +
  '3. {op:"rewrite_code", target:"代码节点", logicDescription:"新的业务逻辑描述"}——重写代码逻辑。' +
  '（delete_node / delete_edge 本期未启用，不要输出。）' +
  "无法归类的指令不要输出任何元素（输出空数组）。";

/** LLM 解析失败/无结果时的错误提示（引导 LLM 直接输出 operations，codex I5） */
const PARSE_FAIL_MESSAGE =
  "工作流更新失败: 无法将指令归类为 set/set_ref/rewrite_code 操作。" +
  "请直接输出 operations 参数（结构化操作数组），例如：" +
  '[{op:"set", target:"LLM 处理", field:"config.model", value:"Qwen3.5-Omni-Plus"}]。' +
  "不要用自然语言描述修改意图。";

export const updateWorkflowTool = tool(
  async ({ workflow, fixInstruction, workflowId, operations, referenceData }) => {
    // 迭代计数：开头只读检查（peek，不递增），修改成功后才计数。
    // codex S2：>= MAX_ITERATIONS（旧代码 > 有 off-by-one，实际允许第 4 次）
    const iteration = peekIteration(workflowId);
    if (iteration >= MAX_ITERATIONS) {
      return iterationLimitMessage(workflowId);
    }

    try {
      // 句柄化：优先参数 workflow，其次服务端缓存按 workflowId 取
      const cached = workflowCache.get(workflowId);
      let wf: Record<string, unknown> | undefined;
      let fromCache = false;
      if (workflow) {
        wf = workflow as unknown as Record<string, unknown>;
      } else if (cached) {
        wf = cached.workflow;
        fromCache = true;
      } else {
        return (
          `工作流更新失败: 未找到工作流缓存（workflowId=${workflowId}）。` +
          `请先调用 read_workflow 或 save_to_coze 后再修改，或在参数中传入 workflow`
        );
      }

      // stale 检测（仅缓存命中时）：比对平台 submit_commit_id，
      // 防止用户（或其它会话）在平台侧人工修改后被旧缓存覆盖
      if (fromCache) {
        try {
          const { schemaJson, submitCommitId } =
            await cozeClient.getSchema(workflowId);
          const entry = workflowCache.get(workflowId);
          if (entry && !entry.commitId) {
            // 缓存尚无 commitId（首次 save 后未记录）：补记，不刷新内容
            entry.commitId = submitCommitId;
          } else if (
            entry &&
            entry.commitId &&
            entry.commitId !== submitCommitId
          ) {
            // 线上已被外部修改：反转换刷新缓存，要求 LLM 基于最新版本重新描述
            const converted = platformToProject(schemaJson, {
              workflowName: (
                entry.workflow.meta as { name?: string } | undefined
              )?.name,
            });
            workflowCache.set(
              workflowId,
              converted.workflow as unknown as Record<string, unknown>,
              { commitId: submitCommitId },
            );
            return "线上工作流已被修改，已从平台重新拉取最新版本，请基于最新版本重新描述修改指令";
          }
        } catch (e) {
          // stale 检测失败：不冒覆盖风险，报错让 LLM 稍后重试
          return `工作流更新失败: 无法获取平台最新版本（stale 检测失败）: ${(e as Error).message}`;
        }
      }

      const nodes = wf.nodes as Array<Record<string, unknown>> | undefined;
      if (!nodes || !Array.isArray(nodes)) {
        return "工作流更新失败: workflow 缺少 nodes 字段";
      }

      // 1. operations 来源：
      //    主路径：参数直传（零解析、零额外 LLM 调用，codex I4）
      //    兼容路径：fixInstruction → chatStructured 解析为 operations
      let operationsList = operations ?? [];
      if (operationsList.length === 0 && fixInstruction) {
        try {
          // 宽松解析：jsonMode 下模型对"顶层数组"约束遵守不稳定
          // （实测输出单个对象 / {ops:[...]} 包裹壳），union 容错后归一化
          const parsed = await client.chatStructured(
            UpdateOperationsParseSchema,
            PARSE_SYSTEM_PROMPT,
            `当前工作流节点摘要：${JSON.stringify(summarizeNodes(wf))}\n\n` +
              `用户修改指令：${fixInstruction}`,
          );
          operationsList = normalizeOperations(parsed);
        } catch {
          return PARSE_FAIL_MESSAGE;
        }
      }
      if (operationsList.length === 0) {
        return (
          "工作流更新失败: 请传 operations（结构化操作数组）或 fixInstruction（自然语言指令）"
        );
      }

      // 2. 逐条执行（部分失败不中断，汇总返回），深拷贝不污染缓存原对象
      const result = await applyOperations(wf as unknown as CozeWorkflow, operationsList, {
        userReferenceData: referenceData,
        codeGenerator,
      });
      const { workflow: nextWorkflow, changes, errors } = result;

      if (changes.length === 0) {
        // 全部失败：不写缓存、不消耗迭代计数（codex S2 与现状一致）
        return `工作流更新失败: 无有效修改。${errors.join("; ")}`;
      }

      // 修改来自缓存 → 写回新对象并标记 dirty（save_to_coze 成功后 clearDirty）
      if (fromCache) {
        const entry = workflowCache.get(workflowId);
        workflowCache.set(
          workflowId,
          nextWorkflow as unknown as Record<string, unknown>,
          { commitId: entry?.commitId },
        );
        workflowCache.markDirty(workflowId);
      }

      // 迭代计数：只对成功修改计（失败指令不消耗上限）
      incrementIteration(workflowId);

      // 句柄化：不再返回完整 workflow，只返回 changes 摘要 + 保存提示
      const summary = {
        changes,
        ...(errors.length > 0 ? { errors } : {}),
        workflowId,
        dirty: true,
      };
      return (
        JSON.stringify(summary, null, 2) +
        (errors.length > 0
          ? `\n\n⚠️ 部分修改未生效: ${errors.join("; ")}`
          : "") +
        "\n\n修改已应用，请调用 save_to_coze（传 workflowId）保存后生效"
      );
    } catch (e) {
      return `工作流更新失败: ${(e as Error).message}`;
    }
  },
  {
    name: "update_workflow",
    description:
      "根据修改意图更新工作流节点字段。推荐直接传 operations（结构化操作数组，主路径）：" +
      "set（改字段，白名单 config.model/userPrompt/systemPrompt/code/language/branches/outputs/outputVariables/inputVariables/data）、" +
      "set_ref（改结束节点输出引用，outputName + ref 如 node_xxx.result）、" +
      "rewrite_code（重写代码节点逻辑，工具侧自动注入节点已有参考数据防幻觉）。" +
      "未传 operations 时可传 fixInstruction 自然语言指令（工具会解析为 operations，兼容入口）。" +
      "工作流 JSON 从服务端缓存自动获取（句柄化，推荐不传 workflow 参数，避免背诵大 JSON）。" +
      "返回 changes 摘要（不再返回完整 workflow）。" +
      "修改后必须调用 save_to_coze（传 workflowId）保存，保存成功才生效（update 只改缓存不落平台）。",
    schema: z.object({
      workflow: z
        .record(z.string(), z.any())
        .optional()
        .describe(
          "可选。当前工作流 JSON。不传时从服务端缓存按 workflowId 获取（推荐：句柄化，避免背诵大 JSON）",
        ),
      workflowId: z
        .string()
        .describe(
          "工作流 ID（save_to_coze 返回的 platformWorkflowId），用于从缓存取工作流和迭代计数",
        ),
      operations: z
        .array(UpdateOperationSchema)
        .optional()
        .describe(
          "结构化修改操作数组（推荐主路径）。set 改字段（branches 元素形状 {expression,targetNodeId}）；" +
            "set_ref 改结束节点输出引用；rewrite_code 重写代码逻辑。未传时用 fixInstruction 解析",
        ),
      fixInstruction: z
        .string()
        .optional()
        .describe(
          "自然语言修改指令（兼容入口，operations 未传时用）。如「把『相似度计算』节点的阈值从 0.8 改为 0.6」",
        ),
      referenceData: z
        .record(z.string(), z.any())
        .optional()
        .describe(
          "可选。用户新提供的参考数据（如歌词库 {歌名: 歌词}）。重写代码节点时与节点已有参考数据合并，防止 LLM 幻觉编造数据",
        ),
    }),
  },
);
