// @coze-workflow/workflow-schema - 工作流本地校验器

import type { CozeWorkflow } from "../types/index";

// ============================================
// 工作流本地校验
//
// 设计思想：
// - 在发送到 Coze API 之前，先在本地校验 JSON 结构
// - 减少无效 API 调用，提高 Agent 效率
// - 校验规则与 Coze 平台保持一致
// ============================================

/** 校验结果 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * 校验完整工作流
 *
 * TODO: 当前为占位实现，后续补充完整校验规则
 * - 节点 ID 唯一性
 * - 边的 source/target 节点必须存在
 * - 必须有且仅有一个 start 节点
 * - 必须有至少一个 end 节点
 * - 不能有孤立节点
 * - 条件节点必须至少有两个分支
 * - LLM 节点必须有 userPrompt
 * - 不允许循环引用（除非明确允许）
 */
export function validateWorkflow(workflow: CozeWorkflow): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const { nodes, edges } = workflow;

  // 基础校验：节点和边非空
  if (nodes.length === 0) {
    errors.push("工作流必须包含至少一个节点");
  }

  if (edges.length === 0) {
    errors.push("工作流必须包含至少一条连线");
  }

  // 校验 start 节点存在
  const hasStart = nodes.some((n) => n.type === "start");
  if (!hasStart) {
    errors.push("工作流必须包含一个开始节点（type: start）");
  }

  // 校验 end 节点存在
  const hasEnd = nodes.some((n) => n.type === "end");
  if (!hasEnd) {
    errors.push("工作流必须包含至少一个结束节点（type: end）");
  }

  // 校验节点 ID 唯一性
  const ids = nodes.map((n) => n.id);
  const uniqueIds = new Set(ids);
  if (ids.length !== uniqueIds.size) {
    errors.push("工作流节点 ID 必须唯一");
  }

  // 校验边引用的节点存在
  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const edge of edges) {
    if (!nodeIds.has(edge.sourceNodeId)) {
      errors.push(`边 ${edge.id} 引用了不存在的源节点: ${edge.sourceNodeId}`);
    }
    if (!nodeIds.has(edge.targetNodeId)) {
      errors.push(`边 ${edge.id} 引用了不存在的目标节点: ${edge.targetNodeId}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
