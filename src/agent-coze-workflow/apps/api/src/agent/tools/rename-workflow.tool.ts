/**
 * [Tool] rename_workflow - 工作流改名
 *
 * 职责：
 * 修改已创建工作流的名称/描述（复用 CozeClient.updateMeta，不走 save，
 * 不影响工作流内容）。
 *
 * 流程：
 * 1. sanitize 名称（字母开头 + 字母数字下划线 + 截断 50）
 * 2. cozeClient.updateMeta() → 平台改名
 * 3. 返回 { workflowId, renamed, name }
 *
 * 关键细节：
 * - 平台约束：name 只允许字母数字下划线且以字母开头（update_meta 实测）
 * - 当 save_to_coze 提示"工作流名称已存在"时，Agent 可用本工具改名后重新保存
 * - try/catch 兜底，错误以 "改名失败: xxx" 字符串返回给 LLM
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { cozeClient } from "./coze-client";

/**
 * 清洗工作流名称：平台只允许字母开头 + 字母/数字/下划线，长度 ≤ 50
 *
 * @param name - 原始名称（可能含中文/空格等非法字符）
 * @returns 平台合法的英文工作流名（空输入降级为 "workflow"）
 */
function sanitizeWorkflowName(name: string): string {
  // 非法字符转下划线 → 去前导非字母 → 截断 50 → 空兜底
  return (
    name
      .replace(/[^a-zA-Z0-9_]/g, "_")
      .replace(/^[^a-zA-Z]+/, "")
      .slice(0, 50) || "workflow"
  );
}

export const renameWorkflowTool = tool(
  async ({ workflowId, name, desc }) => {
    try {
      // 名称 sanitize：字母开头 + 字母数字下划线（平台约束）
      const cleanName = sanitizeWorkflowName(name);
      await cozeClient.updateMeta(workflowId, cleanName, desc ?? "");
      return JSON.stringify(
        { workflowId, renamed: true, name: cleanName },
        null,
        2,
      );
    } catch (e) {
      return `改名失败: ${(e as Error).message}`;
    }
  },
  {
    name: "rename_workflow",
    description:
      "修改已创建工作流的名称/描述（不走 save，不影响工作流内容）。" +
      "当保存时提示'工作流名称已存在'时，用本工具改成新名称后重新保存；" +
      "名称只允许字母数字下划线且以字母开头。",
    schema: z.object({
      workflowId: z.string().describe("已存在的工作流 ID"),
      name: z.string().describe("新名称（自动清洗为字母开头+字母数字下划线）"),
      desc: z.string().optional().describe("新描述（可选）"),
    }),
  },
);
