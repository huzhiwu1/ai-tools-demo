/**
 * [Tool] update_workflow - 工作流更新
 *
 * 职责：
 * 根据 LLM 归因分析后的修改指令，修改工作流中的节点字段。
 * 内部先用 DeepSeekClient 将自然语言指令解析为结构化修改指令
 * （type/target/content），再按类型精确执行，替代原来的关键词猜谜。
 *
 * 流程：
 * 1. chatStructured 解析 fixInstruction → { type, target, content }
 * 2. 按 type 在 workflow.nodes 中查找目标节点（title 或 id）
 * 3. 修改对应字段，返回完整 workflow + changes 列表
 *
 * 关键细节：
 * - 本工具不调平台 API（save_to_coze 负责保存）
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

/** 结构化修改指令 schema（每个字段 describe，LLM 据此输出） */
const UpdateInstructionSchema = z.object({
  type: z
    .enum([
      "llm_prompt",
      "code_logic",
      "condition",
      "threshold",
      "data",
      "other",
    ])
    .describe(
      "修改类型：llm_prompt=改 LLM 节点提示词 / code_logic=改代码节点逻辑 / " +
        "condition=改条件分支 / threshold=调阈值 / data=更新数据常量 / other=其他",
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
        "type 从枚举中选择最合适的一项；target 写工作流节点摘要中存在的节点标识；" +
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
  async ({ workflow, fixInstruction }) => {
    try {
      const wf = workflow as unknown as Record<string, unknown>;
      const nodes = wf.nodes as Array<Record<string, unknown>> | undefined;
      if (!nodes || !Array.isArray(nodes)) {
        return "工作流更新失败: workflow 缺少 nodes 字段";
      }

      // 1. LLM 结构化解析修改指令（失败降级为错误提示）
      const instruction = await parseInstruction(workflow, fixInstruction);
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
          // 仅当明确要求"重写逻辑/重写代码"时才允许调 CodeGenerator（防幻觉）
          const isRewriteRequest =
            /重写|改.*逻辑|新.*算法|替换.*逻辑|修改.*实现|rewrite|new.*algorithm/i.test(
              instruction.content + fixInstruction,
            );
          if (!isRewriteRequest) {
            return (
              `工作流更新失败: 修改类型为 code_logic 但指令未明确要求重写逻辑。` +
              `如只需改阈值/数据常量请用 threshold/data 类型。`
            );
          }
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
      }

      if (changes.length === 0) {
        return "工作流更新失败: 无有效修改";
      }

      return JSON.stringify({ workflow: wf, changes }, null, 2);
    } catch (e) {
      return `工作流更新失败: ${(e as Error).message}`;
    }
  },
  {
    name: "update_workflow",
    description:
      "根据归因分析结果修改工作流节点。传入当前 workflow JSON + 归因分析结论 + " +
      "想要的修改（自然语言即可，如「把相似度阈值从 0.8 调到 0.6」），" +
      "工具会用 LLM 自动理解意图并结构化执行，支持修改 LLM 节点提示词、" +
      "代码节点逻辑（自动生成 Python 代码）、条件分支、阈值、数据常量。" +
      "返回修改后的完整 workflow 和 changes 列表。修改后需调用 save_to_coze 重新保存。",
    schema: z.object({
      workflow: z
        .record(z.string(), z.any())
        .describe(
          "当前工作流 JSON（含 meta、nodes、edges），通常从 generate_workflow 的输出中获取",
        ),
      fixInstruction: z
        .string()
        .describe(
          "LLM 归因分析后给出的修改指令（自然语言），包含要改的节点名称和具体修改内容，如「把『相似度计算』节点的阈值从 0.8 改为 0.6」",
        ),
    }),
  },
);
