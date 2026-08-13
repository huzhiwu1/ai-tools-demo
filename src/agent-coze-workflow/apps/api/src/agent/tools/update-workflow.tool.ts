/**
 * [Tool] update_workflow - 工作流更新
 *
 * 职责：
 * 根据 LLM 归因分析后的修改指令，修改工作流中的节点字段。
 * 支持按关键词匹配修改类型：阈值、代码、prompt、数据常量等。
 *
 * 流程：
 * 1. 解析 fixInstruction 中的关键词，确定修改类型
 * 2. 按类型在 workflow.nodes 中查找目标节点
 * 3. 修改对应字段，返回完整 workflow + changes 列表
 *
 * 关键细节：
 * - 本工具不调平台 API（save_to_coze 负责保存）
 * - 修改类型按关键词匹配优先级：阈值 > 代码/逻辑 > prompt/提示词 > 数据/常量
 * - 未匹配到关键词时返回错误提示让 LLM 明确指令
 * - try/catch 兜底，错误以字符串返回给 LLM
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";

/**
 * 在代码文本中查找并替换阈值常量
 *
 * 匹配数字比较（如 0.8、0.01 等），按 fixInstruction 中的数字替换。
 */
function replaceThreshold(
  code: string,
  instruction: string,
): { code: string; changed: boolean } {
  const thresholdPattern = /(\d+\.?\d*)\s*[改为→]\s*(\d+\.?\d*)/;
  const match = thresholdPattern.exec(instruction);

  if (!match) return { code, changed: false };

  const oldVal = match[1];
  const newVal = match[2];

  const escapedOld = oldVal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(escapedOld, "g");
  const oldCode = code;
  const newCode = code.replace(regex, newVal);

  return { code: newCode, changed: oldCode !== newCode };
}

export const updateWorkflowTool = tool(
  async ({ workflow, fixInstruction }) => {
    try {
      const wf = workflow as unknown as Record<string, unknown>;
      const changes: Array<{
        nodeId: string;
        nodeTitle: string;
        field: string;
        oldValue: string;
        newValue: string;
      }> = [];

      const nodes = wf.nodes as Array<Record<string, unknown>> | undefined;
      if (!nodes || !Array.isArray(nodes)) {
        return "工作流更新失败: workflow 缺少 nodes 字段";
      }

      const instr = fixInstruction.toLowerCase();

      // 1. 阈值修改（优先级最高）
      if (
        instr.includes("阈值") ||
        instr.includes("threshold") ||
        instr.includes("相似度") ||
        instr.includes("匹配度")
      ) {
        for (const node of nodes) {
          const isCodeNode =
            node.type === "code" && typeof node.code === "string";
          const config = node.config as Record<string, unknown> | undefined;
          const isLlmNode = node.type === "llm" && config;

          if (isCodeNode) {
            const { code: newCode, changed } = replaceThreshold(
              node.code as string,
              fixInstruction,
            );
            if (changed) {
              changes.push({
                nodeId: node.id as string,
                nodeTitle: node.title as string,
                field: "code",
                oldValue: "阈值已替换",
                newValue: "已按指令修改阈值",
              });
              node.code = newCode;
            }
          }

          if (isLlmNode && config?.temperature !== undefined) {
            const tempMatch = /(\d+\.?\d*)\s*[改为→]\s*(\d+\.?\d*)/.exec(
              fixInstruction,
            );
            if (tempMatch) {
              const oldTemp = config.temperature;
              config.temperature = Number.parseFloat(tempMatch[2]);
              changes.push({
                nodeId: node.id as string,
                nodeTitle: node.title as string,
                field: "temperature",
                oldValue: String(oldTemp),
                newValue: tempMatch[2],
              });
            }
          }
        }
      }

      // 2. 代码 / 逻辑修改
      if (
        instr.includes("代码") ||
        instr.includes("逻辑") ||
        instr.includes("code") ||
        instr.includes("logic")
      ) {
        for (const node of nodes) {
          if (node.type === "code") {
            const codeBlockMatch =
              /```(?:python|javascript|js)?\s*([\s\S]*?)```/.exec(
                fixInstruction,
              );
            if (codeBlockMatch && codeBlockMatch[1].trim()) {
              const oldCode = (node.code as string) ?? "";
              node.code = codeBlockMatch[1].trim();
              const langMatch = /```(python|javascript|js)/.exec(
                fixInstruction,
              );
              if (langMatch) {
                node.language =
                  langMatch[1] === "js" ? "javascript" : langMatch[1];
              }
              changes.push({
                nodeId: node.id as string,
                nodeTitle: node.title as string,
                field: "code",
                oldValue:
                  oldCode.substring(0, 100) +
                  (oldCode.length > 100 ? "..." : ""),
                newValue: "已按指令重写代码逻辑",
              });
            }
          }
        }
      }

      // 3. prompt / 提示词修改
      if (
        instr.includes("prompt") ||
        instr.includes("提示词") ||
        instr.includes("system") ||
        instr.includes("user")
      ) {
        for (const node of nodes) {
          if (node.type === "llm") {
            const promptBlockMatch = /```\s*([\s\S]*?)```/.exec(fixInstruction);
            if (promptBlockMatch && promptBlockMatch[1].trim()) {
              const newPrompt = promptBlockMatch[1].trim();

              if (instr.includes("system") || instr.includes("系统提示词")) {
                const oldSystemPrompt = (node.systemPrompt as string) ?? "";
                node.systemPrompt = newPrompt;
                changes.push({
                  nodeId: node.id as string,
                  nodeTitle: node.title as string,
                  field: "systemPrompt",
                  oldValue:
                    oldSystemPrompt.substring(0, 100) +
                    (oldSystemPrompt.length > 100 ? "..." : ""),
                  newValue: "已按指令修改系统提示词",
                });
              } else {
                const oldUserPrompt = (node.userPrompt as string) ?? "";
                node.userPrompt = newPrompt;
                changes.push({
                  nodeId: node.id as string,
                  nodeTitle: node.title as string,
                  field: "userPrompt",
                  oldValue:
                    oldUserPrompt.substring(0, 100) +
                    (oldUserPrompt.length > 100 ? "..." : ""),
                  newValue: "已按指令修改用户提示词",
                });
              }
            }
          }
        }
      }

      // 4. 数据 / 常量修改
      if (
        instr.includes("数据") ||
        instr.includes("常量") ||
        instr.includes("constant") ||
        instr.includes("data")
      ) {
        for (const node of nodes) {
          if (node.type === "code") {
            const jsonMatch = /```json\s*([\s\S]*?)```/.exec(fixInstruction);
            if (jsonMatch && jsonMatch[1].trim()) {
              try {
                const newData = JSON.parse(jsonMatch[1].trim());
                node.data = newData;
                changes.push({
                  nodeId: node.id as string,
                  nodeTitle: node.title as string,
                  field: "data",
                  oldValue: "无",
                  newValue: "已按指令更新数据常量",
                });
              } catch {
                // JSON 解析失败，忽略
              }
            }
          }
        }
      }

      if (changes.length === 0) {
        return (
          "工作流更新失败: 无法识别修改类型。" +
          "请在 fixInstruction 中明确指定修改类型（阈值/代码/逻辑/prompt/提示词/数据/常量），" +
          "并包含具体修改内容。"
        );
      }

      return JSON.stringify(
        {
          workflow: wf,
          changes: changes.map((c) => ({
            nodeId: c.nodeId,
            nodeTitle: c.nodeTitle,
            field: c.field,
            oldValue: c.oldValue,
            newValue: c.newValue,
          })),
        },
        null,
        2,
      );
    } catch (e) {
      return `工作流更新失败: ${(e as Error).message}`;
    }
  },
  {
    name: "update_workflow",
    description:
      "根据归因分析结果修改工作流节点。支持按关键词匹配修改类型：" +
      "'阈值' → 修改代码节点中的相似度/判断阈值；" +
      "'代码'/'逻辑' → 重写代码节点的业务逻辑；" +
      "'prompt'/'提示词' → 修改 LLM 节点的 userPrompt/systemPrompt；" +
      "'数据'/'常量' → 更新代码节点中的数据常量。" +
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
          "LLM 归因分析后给出的修改指令，需包含修改类型关键词（阈值/代码/逻辑/prompt/提示词/数据/常量）和具体修改内容",
        ),
    }),
  },
);
