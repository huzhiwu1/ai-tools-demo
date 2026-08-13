/**
 * PlatformValidator - 工作流平台兼容性校验
 *
 * 职责：
 * 在 save_to_coze 前校验 CozeWorkflow 是否满足已知平台约束，
 * 防止保存后平台执行 panic（如代码节点缺 outputs、条件节点 TODO target、
 * LLM 节点模型不存在等）。
 *
 * 校验项（与 docs/coze-platform/platform-facts.md 同步）：
 * 1. code/llm 节点必须有 outputs 声明
 * 2. condition 节点 branches 无 "TODO" targetNodeId
 * 3. LLM 节点 model 在平台模型列表内
 * 4. database 节点 connection 非空
 * 5. 所有边引用的节点 ID 存在
 * 6. start/end 节点存在且唯一
 *
 * 关键细节：
 * - 只做不可执行的阻断检查（errors），不做 warn（warnings 放 validateWorkflow）
 * - 与 validateWorkflow 互补，不做重复检查
 * - 平台模型列表内联于此（取子集验证常用），与 platform-facts.md 同步维护
 */

import type { CozeWorkflow, CozeNode } from "@coze-workflow/workflow-schema";

/** 平台已知可用模型名列表（platform-facts.md 25 个的子集，用于校验） */
const PLATFORM_MODELS = new Set([
  "Doubao-Seed-2.0-Lite",
  "Doubao-Seed-2.0-mini",
  "Doubao-Seed-1.6",
  "gemini-3.1-pro-preview",
  "Qiniu-Gemini-3.1-Pro-Preview",
  "Qwen3.5-Omni-Plus",
  "Doubao-Seed-2.1-turbo",
  "Doubao-Seed-2.1-pro",
  "Doubao-Seed-2.0-Pro",
  "Doubao-Seed-1.8",
  "doubao-seed-1.6-vision",
  "qwen3-vl-plus",
  "Qwen3.7-Plus",
  "Qwen3.6-Plus",
  "Qwen3.5-Plus-2026-2-15",
  "Deepseek-V4-Flash-VolcEngine",
  "Deepseek-V4-Pro-VolcEngine",
  "Deepseek-V3-VolcEngine",
  "GLM-5",
  "qwen-max",
  "qwen-flash",
  "qwen-plus",
  "Qwen3-32B",
  "Doubao-1.5-Pro-32k",
  "Doubao-1.5-Lite",
]);

/** 平台兼容性校验结果 */
export interface PlatformCompatibilityResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * 校验工作流平台兼容性
 *
 * @param workflow - 待保存的工作流
 * @returns 校验结果（errors 阻断保存，warnings 仅提示）
 */
export function checkPlatformCompatibility(
  workflow: CozeWorkflow,
): PlatformCompatibilityResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const { nodes = [], edges = [] } = workflow;

  // 1. start/end 节点存在且唯一
  const startNodes = nodes.filter((n) => n.type === "start");
  const endNodes = nodes.filter((n) => n.type === "end");
  if (startNodes.length !== 1) {
    errors.push(`必须包含且仅包含一个开始节点（当前 ${startNodes.length} 个）`);
  }
  if (endNodes.length !== 1) {
    errors.push(`必须包含且仅包含一个结束节点（当前 ${endNodes.length} 个）`);
  }

  // 2. 校验每个节点
  const nodeIds = new Set(nodes.map((n) => n.id));

  for (const node of nodes) {
    evalNode(node, nodeIds, errors, warnings);
  }

  // 3. 边引用的节点存在
  for (const edge of edges) {
    if (edge.sourceNodeId && !nodeIds.has(edge.sourceNodeId)) {
      errors.push(
        `边 "${edge.id}" 引用了不存在的源节点 "${edge.sourceNodeId}"`,
      );
    }
    if (edge.targetNodeId && !nodeIds.has(edge.targetNodeId)) {
      errors.push(
        `边 "${edge.id}" 引用了不存在的目标节点 "${edge.targetNodeId}"`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/** 校验单个节点的平台兼容性 */
function evalNode(
  node: CozeNode,
  nodeIds: Set<string>,
  errors: string[],
  warnings: string[],
): void {
  const title = node.title ?? node.id;

  // 2a. code 节点必须有 outputs
  if (node.type === "code") {
    const c = node as CozeNode & { outputs?: unknown[] };
    if (!c.outputs || c.outputs.length === 0) {
      errors.push(`代码节点「${title}」缺少 outputs 声明（平台会 panic）`);
    }
    return;
  }

  // 2b. llm 节点必须有 outputs，model 必须在平台列表中
  if (node.type === "llm") {
    const l = node as CozeNode & {
      outputs?: unknown[];
      config?: { model?: string };
    };
    if (!l.outputs || l.outputs.length === 0) {
      errors.push(`LLM 节点「${title}」缺少 outputs 声明（平台会 panic）`);
    }
    const model = l.config?.model;
    if (model && !PLATFORM_MODELS.has(model)) {
      errors.push(
        `LLM 节点「${title}」模型 "${model}" 不在平台可用模型列表中（请用 get_platform_facts 确认）`,
      );
    }
    return;
  }

  // 2c. condition 节点 branches 无 TODO
  if (node.type === "condition") {
    const cond = node as CozeNode & {
      branches?: Array<{ targetNodeId?: string }>;
    };
    const branches = cond.branches ?? [];
    for (let i = 0; i < branches.length; i++) {
      const target = branches[i]?.targetNodeId;
      if (!target || target === "TODO") {
        errors.push(
          `条件节点「${title}」分支 ${i} 的 targetNodeId 为 "${target ?? "空"}"，应指向真实节点`,
        );
      }
    }
    // 条件节点引用的 targetNodeId 是否存在
    for (let i = 0; i < branches.length; i++) {
      const target = branches[i]?.targetNodeId;
      if (target && target !== "TODO" && !nodeIds.has(target)) {
        errors.push(
          `条件节点「${title}」分支 ${i} 指向不存在的节点 "${target}"`,
        );
      }
    }
    return;
  }

  // 2d. database 节点 connection 非空
  if (node.type === "database_query") {
    const db = node as CozeNode & { connection?: string };
    if (!db.connection) {
      errors.push(
        `数据库节点「${title}」connection 为空（不应存在 database 节点）`,
      );
    }
    return;
  }
}
