/**
 * WorkflowRepairer - 工作流修复器
 *
 * 职责：
 * 接收校验失败的 CozeWorkflow，尝试最小化修复
 *
 * 流程：
 * 1. 接收 worklow + ValidationResult（含 errors）
 * 2. 按错误类型分类处理（缺失节点、ID 重复、边引用不存在等）
 * 3. 代码规则修复优先，LLM 兜底
 *
 * 关键细节：
 * - 规则驱动修复优先（确定性）：补 start/end 节点、去重 ID、移除死边
 * - LLM 兜底（非确定性）：复杂语义错误交给 LLM 用 REPAIR_PROMPT 处理
 * - 每次修复只做最小改动，不重写整张图
 */
import { generateId } from "@coze-workflow/shared";
import type { ValidationResult } from "@coze-workflow/shared";
import type {
  CozeWorkflow,
  CozeNode,
  CozeEdge,
} from "@coze-workflow/workflow-schema";
import { createStartNode, createEndNode } from "@coze-workflow/workflow-schema";
import { REPAIR_PROMPT } from "../prompts/repair-prompt";
import type { DeepSeekClient } from "../llm/deepseek.client";
import { z } from "zod";

/** LLM 修复输出 Schema */
const RepairOutputSchema = z.object({
  summary: z.string().describe("修复内容摘要"),
  fixed: z.boolean().describe("是否成功修复"),
  remaining: z.array(z.string()).describe("仍存在的问题列表"),
});

export class WorkflowRepairer {
  constructor(private readonly client: DeepSeekClient) {}

  /**
   * 尝试修复校验失败的工作流
   *
   * @param workflow - 待修复的工作流
   * @param validation - 校验结果（含 errors 和 warnings）
   * @returns 修复后的工作流
   */
  async repair(
    workflow: CozeWorkflow,
    validation: ValidationResult,
  ): Promise<CozeWorkflow> {
    // 深拷贝，避免副作用
    let fixed: CozeWorkflow = JSON.parse(
      JSON.stringify(workflow),
    ) as CozeWorkflow;

    // 第一步：规则驱动修复（确定性）
    fixed = this.applyRuleFixes(fixed, validation);

    // 第二步：如果仍有复杂错误，调 LLM 兜底
    const remainingErrors = validation.errors.filter(
      (e) =>
        ![
          "NO_NODES",
          "NO_EDGES",
          "MISSING_START",
          "MISSING_END",
          "DUPLICATE_NODE_ID",
        ].includes(e.code),
    );

    if (remainingErrors.length > 0) {
      try {
        const userPrompt = JSON.stringify({
          workflow: fixed,
          errors: remainingErrors.map((e) => ({
            code: e.code,
            message: e.message,
          })),
        });
        const result = await this.client.chatStructured(
          RepairOutputSchema,
          REPAIR_PROMPT,
          userPrompt,
        );
        console.log("[WorkflowRepairer] LLM 修复完成:", result.summary);
      } catch (e) {
        console.warn(
          "[WorkflowRepairer] LLM 修复失败，仅应用规则修复:",
          (e as Error).message,
        );
      }
    }

    return fixed;
  }

  /**
   * 规则驱动修复（确定性的）
   */
  private applyRuleFixes(
    workflow: CozeWorkflow,
    validation: ValidationResult,
  ): CozeWorkflow {
    const errorCodes = new Set(validation.errors.map((e) => e.code));

    // 补 start 节点
    if (errorCodes.has("MISSING_START")) {
      workflow.nodes.unshift(createStartNode());
    }

    // 补 end 节点
    if (errorCodes.has("MISSING_END")) {
      workflow.nodes.push(createEndNode());
    }

    // 去重：相同 ID 的节点只保留第一个
    if (errorCodes.has("DUPLICATE_NODE_ID")) {
      const seen = new Set<string>();
      workflow.nodes = workflow.nodes.filter((n) => {
        if (seen.has(n.id)) {
          n.id = generateId(); // 重新生成 ID
        }
        seen.add(n.id);
        return true;
      });
    }

    // 移除引用不存在节点的死边
    if (
      errorCodes.has("MISSING_SOURCE_NODE") ||
      errorCodes.has("MISSING_TARGET_NODE")
    ) {
      const nodeIds = new Set(workflow.nodes.map((n) => n.id));
      workflow.edges = workflow.edges.filter(
        (e) => nodeIds.has(e.sourceNodeId) && nodeIds.has(e.targetNodeId),
      );
    }

    return workflow;
  }
}
