// @coze-workflow/workflow-schema - 工作流本地校验器
//
// 设计思想：
// - 在发送到 Coze API 之前先校验 JSON 结构
// - 减少无效 API 调用，提高 Agent 效率
// - 校验规则分三个层级：结构校验、业务规则、代码安全

import type { CozeWorkflow, CozeNode } from "../types/index";
import type {
  ValidationResult,
  ValidationError,
  ValidationWarning,
} from "@coze-workflow/shared";

// ============================================
// 入口：校验函数
// ============================================

/**
 * 校验工作流 JSON 字符串是否可解析
 *
 * 适用场景：接收到前端提交的 JSON 字符串后，先校验格式再解析
 */
export function validateWorkflowJson(jsonString: string): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  try {
    const parsed = JSON.parse(jsonString);
    if (!parsed || typeof parsed !== "object") {
      errors.push({
        code: "INVALID_JSON",
        message: "工作流 JSON 解析结果不是有效的对象",
      });
      return { valid: false, errors, warnings };
    }

    // 校验 _temp 字段存在（Coze 工作流导出格式约定）
    if (!parsed._temp) {
      warnings.push({
        code: "MISSING_TEMP",
        message: "工作流 JSON 缺少 _temp 字段（Coze 平台约定）",
      });
    }

    // JSON 可解析，继续深入校验结构
    const structResult = validateWorkflow(parsed as CozeWorkflow);
    return {
      ...structResult,
      warnings: [...warnings, ...structResult.warnings],
    };
  } catch (e) {
    errors.push({
      code: "PARSE_ERROR",
      message: `工作流 JSON 解析失败: ${(e as Error).message}`,
    });
    return { valid: false, errors, warnings };
  }
}

/**
 * 校验 CozeWorkflow 对象的结构
 */
export function validateWorkflow(workflow: CozeWorkflow): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  const { nodes, edges } = workflow;

  // ---------- 基础结构校验 ----------

  if (!nodes || nodes.length === 0) {
    errors.push({
      code: "NO_NODES",
      message: "工作流必须包含至少一个节点",
    });
    return { valid: false, errors, warnings };
  }

  if (!edges || edges.length === 0) {
    errors.push({
      code: "NO_EDGES",
      message: "工作流必须包含至少一条连线",
    });
  }

  // ---------- start / end 节点存在 ----------

  const hasStart = nodes.some((n) => n.type === "start");
  if (!hasStart) {
    errors.push({
      code: "MISSING_START",
      message: "工作流必须包含一个开始节点（type: start）",
    });
  }

  const hasEnd = nodes.some((n) => n.type === "end");
  if (!hasEnd) {
    errors.push({
      code: "MISSING_END",
      message: "工作流必须包含至少一个结束节点（type: end）",
    });
  }

  // ---------- 节点 ID 唯一性 ----------

  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (!node.id) {
      errors.push({
        code: "NODE_NO_ID",
        message: `节点缺少 id 字段: ${JSON.stringify(node.title ?? node)}`,
      });
    } else if (nodeIds.has(node.id)) {
      errors.push({
        code: "DUPLICATE_NODE_ID",
        message: `节点 ID "${node.id}" 重复`,
        nodeId: node.id,
      });
    } else {
      nodeIds.add(node.id);
    }
  }

  // ---------- edges 引用的节点存在 ----------

  for (const edge of edges) {
    if (edge.sourceNodeId && !nodeIds.has(edge.sourceNodeId)) {
      errors.push({
        code: "MISSING_SOURCE_NODE",
        message: `边引用了不存在的源节点: "${edge.sourceNodeId}"`,
        edgeId: edge.id,
        nodeId: edge.sourceNodeId,
      });
    }
    if (edge.targetNodeId && !nodeIds.has(edge.targetNodeId)) {
      errors.push({
        code: "MISSING_TARGET_NODE",
        message: `边引用了不存在的目标节点: "${edge.targetNodeId}"`,
        edgeId: edge.id,
        nodeId: edge.targetNodeId,
      });
    }
  }

  // ---------- 代码节点 sourcePortID 校验 ----------

  const codeNodes = nodes.filter(
    (n): n is CozeNode & { type: "code" } => n.type === "code",
  );
  for (const codeNode of codeNodes) {
    // 代码节点不应该有 sourcePortID（它只有一个输出口）
    const outgoingEdges = edges.filter((e) => e.sourceNodeId === codeNode.id);
    for (const edge of outgoingEdges) {
      if (edge.sourcePort) {
        // 条件节点的 sourcePort 是合法的，但代码节点不应该有
        // 这里的逻辑是：如果边有 sourcePort，需要确保源节点支持多端口
        // 目前只有 condition 节点支持多端口
        warnings.push({
          code: "CODE_NODE_SOURCE_PORT",
          message: `代码节点 "${codeNode.title}" 的边 "${edge.id}" 包含了 sourcePort，代码节点不支持多端口输出`,
          nodeId: codeNode.id,
        });
      }
    }
  }

  // ---------- _temp 字段存在（Coze 平台导出约定）----------

  if (!(workflow as unknown as Record<string, unknown>)._temp) {
    warnings.push({
      code: "MISSING_TEMP",
      message: "工作流对象缺少 _temp 字段（Coze 平台导出格式约定）",
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
