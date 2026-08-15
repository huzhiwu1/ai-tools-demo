/**
 * [Tool] update_workflow - 工作流更新（句柄化）
 *
 * 职责：
 * 根据 LLM 归因分析后的修改指令，修改工作流中的节点字段。
 * 内部先用 DeepSeekClient 将自然语言指令解析为结构化修改指令
 * （type/target/content），再按类型精确执行，替代原来的关键词猜谜。
 *
 * 流程：
 * 1. iteration 计数（保留现状上限约束）
 * 2. 解析工作流来源：参数 workflow ?? workflowCache.get(workflowId)，缓存/参数都没有则报错
 * 3. stale 检测（缓存命中时）：比对平台 submit_commit_id，线上被外部修改则刷新缓存并提示
 * 4. chatStructured 解析 fixInstruction → { type, target, content }
 * 5. 按 type 在 workflow.nodes 中查找目标节点（title 或 id）
 * 6. 修改对应字段，标记缓存 dirty，返回 changes 摘要（不再返回完整 workflow）
 *
 * 关键细节：
 * - 本工具不调平台保存 API（save_to_coze 负责保存），仅 stale 检测时调 getSchema
 * - 句柄化：LLM 不传大 JSON，只传 workflowId + fixInstruction，从服务端缓存取工作流
 * - stale 检测失败（拿不到平台最新版本）直接报错，防止旧缓存覆盖平台侧人工修改
 * - target 优先匹配节点 title（中文名），其次 id，最后 title 包含
 * - code_logic 复用 CodeGenerator（LLM 生成平台规范 Python 代码）
 * - LLM 解析失败降级：返回明确错误字符串，让 Agent 重新组织语言
 * - 找不到 target 返回"未找到节点: xxx"
 * - try/catch 兜底，错误以字符串返回给 LLM
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
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

/** 结构化修改指令 schema（每个字段 describe，LLM 据此输出） */
const UpdateInstructionSchema = z.object({
  type: z
    .enum([
      "llm_prompt",
      "code_logic",
      "condition",
      "threshold",
      "data",
      "output_field",
      "other",
    ])
    .describe(
      "修改类型：llm_prompt=改 LLM 节点提示词 / code_logic=改代码节点逻辑 / " +
        "condition=改条件分支 / threshold=调阈值 / data=更新数据常量 / " +
        "output_field=改节点输出字段名或结束节点返回变量（如把输出从 lyrics 改为 result） / " +
        "other=其他",
    ),
  target: z
    .string()
    .describe("目标节点标识（title 或 id，尽量用 title 中文名）"),
  content: z
    .string()
    .describe(
      "具体修改内容：新提示词 / 新逻辑描述 / 新条件 / 新阈值（如 0.8 改为 0.6）/ 新数据（JSON 或文本）",
    ),
});

/** LLM 结构化解析失败时的错误提示（让 Agent 重新组织语言） */
const PARSE_FAIL_MESSAGE =
  "工作流更新失败: 无法解析修改指令。" +
  "请用更明确的语言描述，例如：把「歌词识别」节点的相似度阈值从 0.8 改为 0.6；" +
  "或：重写「相似度计算」节点的逻辑，改为编辑距离算法。";

/** 模块级单例：无状态可安全共享，LLM 失败内部已降级 */
const client = new DeepSeekClient();
const codeGenerator = new CodeGenerator(client);

type UpdateInstruction = z.infer<typeof UpdateInstructionSchema>;

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
 * 用 LLM 将自然语言修改指令解析为结构化指令
 *
 * @returns 解析结果；LLM 调用失败返回 null（调用方降级）
 */
async function parseInstruction(
  workflow: unknown,
  fixInstruction: string,
): Promise<UpdateInstruction | null> {
  try {
    return await client.chatStructured(
      UpdateInstructionSchema,
      "你是工作流修改指令解析器。将用户的自然语言修改指令解析为结构化修改指令。" +
        "type 必须严格从 [llm_prompt, code_logic, condition, threshold, data, output_field, other] 中选择一项；" +
        "output_field 用于改节点输出字段名/结束节点返回变量（如「把输出从 lyrics 改为 result」）；" +
        "target 写工作流节点摘要中存在的节点标识；" +
        "content 写完整的修改内容（不要省略）。无法归类的指令用 type=other。",
      `当前工作流节点摘要：${JSON.stringify(summarizeNodes(workflow))}\n\n` +
        `用户修改指令：${fixInstruction}`,
    );
  } catch (e) {
    return null;
  }
}

/**
 * 按 target 查找节点：title 精确匹配 → id 匹配 → title 包含
 *
 * @returns 目标节点；未找到返回 undefined
 */
function findTargetNode(
  nodes: Array<Record<string, unknown>>,
  target: string,
): Record<string, unknown> | undefined {
  return (
    nodes.find((n) => n.title === target) ??
    nodes.find((n) => n.id === target) ??
    nodes.find((n) => typeof n.title === "string" && n.title.includes(target))
  );
}

/**
 * 在字符串中替换阈值数字（content 格式：旧值 改为/→ 新值）
 *
 * @returns 替换后的字符串；content 不含阈值格式时返回原文 + changed=false
 */
function replaceThresholdText(
  text: string,
  content: string,
): { text: string; changed: boolean } {
  const match = /(\d+\.?\d*)\s*[改为→]\s*(\d+\.?\d*)/.exec(content);
  if (!match) return { text, changed: false };

  const oldVal = match[1];
  const newVal = match[2];
  const escapedOld = oldVal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const newText = text.replace(new RegExp(escapedOld, "g"), newVal);

  return { text: newText, changed: newText !== text };
}

export const updateWorkflowTool = tool(
  async ({ workflow, fixInstruction, workflowId }) => {
    // 迭代计数：开头只读检查（peek，不递增），修改成功后才计数
    const iteration = peekIteration(workflowId);
    if (iteration > MAX_ITERATIONS) {
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

      // 1. LLM 结构化解析修改指令（失败降级为错误提示）
      const instruction = await parseInstruction(wf, fixInstruction);
      if (!instruction) {
        return PARSE_FAIL_MESSAGE;
      }
      if (instruction.type === "other") {
        return `工作流更新失败: 无法归类的修改指令。${instruction.content}`;
      }

      // 2. 定位目标节点
      const node = findTargetNode(nodes, instruction.target);
      if (!node) {
        return `工作流更新失败: 未找到节点: ${instruction.target}`;
      }

      const changes: string[] = [];
      const targetName = String(node.title ?? instruction.target);

      // 3. 按类型执行修改
      switch (instruction.type) {
        case "llm_prompt": {
          if (node.type !== "llm") {
            return `工作流更新失败: 节点 ${targetName} 不是 LLM 节点（type=${String(node.type)}）`;
          }
          // system/user 判断：target 或 content 出现 system/系统 关键词 → systemPrompt
          const isSystem =
            /system|系统/.test(instruction.target) ||
            /system|系统/.test(instruction.content);
          if (isSystem) {
            node.systemPrompt = instruction.content;
            changes.push(`节点 ${targetName} systemPrompt 已更新`);
          } else {
            node.userPrompt = instruction.content;
            changes.push(`节点 ${targetName} userPrompt 已更新`);
          }
          break;
        }

        case "code_logic": {
          if (node.type !== "code") {
            return `工作流更新失败: 节点 ${targetName} 不是代码节点（type=${String(node.type)}）`;
          }
          // 放宽：用户明确指向该代码节点并给出修改内容即执行。
          // 原逻辑要求"重写/改逻辑"关键词，实测 LLM 说"把 Output 的 key 改掉"不触发导致失败。
          // 无 referenceData 时不重写代码节点（防止 LLM 凭空生成全新代码）
          const refDataStr = node.referenceData as
            | Record<string, string>
            | undefined;
          if (!refDataStr || Object.keys(refDataStr).length === 0) {
            return (
              `工作流更新失败: 代码逻辑重写需要 referenceData（原工作流的参考数据），` +
              `否则 LLM 会幻觉编造数据。请提供原工作流的参考数据。`
            );
          }
          // 复用 CodeGenerator：传入 referenceData，prompt 强调保留原数据
          const newCode = await codeGenerator.generateCode(
            instruction.content,
            undefined,
            refDataStr,
          );
          node.code = newCode;
          node.language = "python";
          changes.push(
            `节点 ${targetName} 代码逻辑已按新描述重写（保留原 referenceData）`,
          );
          break;
        }

        case "condition": {
          if (node.type !== "condition") {
            return `工作流更新失败: 节点 ${targetName} 不是条件节点（type=${String(node.type)}）`;
          }
          node.branches = [{ label: "match", condition: instruction.content }];
          changes.push(`节点 ${targetName} 条件分支已更新`);
          break;
        }

        case "threshold": {
          const threshold = replaceThresholdText(
            (node.code as string) ?? "",
            instruction.content,
          );
          if (!threshold.changed && node.type === "condition") {
            // 条件节点的 branches 里替换阈值
            const branches = node.branches as
              | Array<{ label?: string; condition?: string }>
              | undefined;
            if (branches && branches.length > 0) {
              const b = branches[0];
              const replaced = replaceThresholdText(
                b.condition ?? "",
                instruction.content,
              );
              if (replaced.changed) {
                b.condition = replaced.text;
                changes.push(
                  `节点 ${targetName} 条件阈值已更新: ${instruction.content}`,
                );
                break;
              }
            }
            return (
              `工作流更新失败: 节点 ${targetName} 中未找到阈值 ${instruction.content}。` +
              `threshold 指令需为「旧值 改为/→ 新值」格式，且节点中需存在该旧值。`
            );
          }
          if (!threshold.changed) {
            return (
              `工作流更新失败: 节点 ${targetName} 代码中未找到阈值 ${instruction.content}。` +
              `threshold 指令需为「旧值 改为/→ 新值」格式。`
            );
          }
          node.code = threshold.text;
          changes.push(`节点 ${targetName} 阈值已更新: ${instruction.content}`);
          break;
        }

        case "data": {
          if (node.type !== "code") {
            return `工作流更新失败: 节点 ${targetName} 不是代码节点（type=${String(node.type)}）`;
          }
          // content 优先按 JSON 解析，失败则按原文本存储
          try {
            node.data = JSON.parse(instruction.content);
          } catch {
            node.data = instruction.content;
          }
          changes.push(`节点 ${targetName} 数据常量已更新`);
          break;
        }

        case "output_field": {
          // 目标：改节点 outputs 声明里的字段名，或结束节点 outputVariables 引用
          // content 格式约定：`旧字段名 -> 新字段名`（或 `改为`）
          const match = /([\w.]+)\s*(?:->|→|改为)\s*([\w.]+)/.exec(
            instruction.content,
          );
          if (!match) {
            return (
              `工作流更新失败: output_field 指令格式应为「旧字段名 -> 新字段名」` +
              `（如 lyrics -> result），收到: ${instruction.content}`
            );
          }
          const [, oldName, newName] = match;

          // 场景 A：改节点 outputs 声明（含结束节点 outputVariables）
          const outputs = node.outputs as Array<{ name?: string }> | undefined;
          if (Array.isArray(outputs)) {
            let changed = false;
            for (const o of outputs) {
              if (o.name === oldName) {
                o.name = newName;
                changed = true;
              }
            }
            if (changed) {
              changes.push(`节点 ${targetName} 输出字段 ${oldName} -> ${newName}`);
              break;
            }
          }

          // 结束节点：outputVariables 是 [{name, value}]，同样按 name 匹配替换
          const outputVars = node.outputVariables as
            | Array<{ name?: string }>
            | undefined;
          if (Array.isArray(outputVars)) {
            let changed = false;
            for (const v of outputVars) {
              if (v.name === oldName) {
                v.name = newName;
                changed = true;
              }
            }
            if (changed) {
              changes.push(
                `节点 ${targetName} 结束输出变量 ${oldName} -> ${newName}`,
              );
              break;
            }
          }

          // 场景 B：改代码节点内部返回值（代码里 ret: Output = {旧字段: ...} → 新字段）
          // 仅当节点有 code 字段时做文本替换；只替换标识符，字符串字面量里的
          // 歌词内容由 LLM 的 content 精确控制（content 只写字段名对，不写歌词）
          if (typeof node.code === "string" && node.code.includes(oldName)) {
            const oldEscaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            node.code = node.code.replace(new RegExp(oldEscaped, "g"), newName);
            changes.push(`节点 ${targetName} 代码内 ${oldName} 已替换为 ${newName}`);
            break;
          }

          return `工作流更新失败: 节点 ${targetName} 中未找到输出字段 ${oldName}`;
        }
      }

      if (changes.length === 0) {
        return "工作流更新失败: 无有效修改";
      }

      // 修改来自缓存 → 标记 dirty（save_to_coze 成功后 clearDirty）
      if (fromCache) {
        workflowCache.markDirty(workflowId);
      }

      // 迭代计数：只对成功修改计（失败指令不消耗上限）
      incrementIteration(workflowId);

      // 句柄化：不再返回完整 workflow，只返回 changes 摘要 + 保存提示
      return (
        JSON.stringify({ changes, workflowId, dirty: true }, null, 2) +
        "\n\n修改已应用，请调用 save_to_coze（传 workflowId）保存后生效"
      );
    } catch (e) {
      return `工作流更新失败: ${(e as Error).message}`;
    }
  },
  {
    name: "update_workflow",
    description:
      "根据归因分析结果修改工作流节点。传入 workflowId + 修改指令（自然语言即可，如「把相似度阈值从 0.8 调到 0.6」），" +
      "工具会用 LLM 自动理解意图并结构化执行，支持修改 LLM 节点提示词、" +
      "代码节点逻辑（自动生成 Python 代码）、条件分支、阈值、数据常量、" +
      "输出字段名/结束节点返回变量（如「把输出从 lyrics 改为 result」）。" +
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
      fixInstruction: z
        .string()
        .describe(
          "修改指令（自然语言），如「把『相似度计算』节点的阈值从 0.8 改为 0.6」",
        ),
    }),
  },
);
