/**
 * Workflow Graph —— LangGraph 编排
 *
 * 职责：
 * 用 StateGraph 编排 WorkflowPlanner → WorkflowGenerator → 校验 → 修复 的完整 Agent 流程
 *
 * 节点链：
 * plan_node → sketch_node → generate_node → validate_node
 *   →（条件边：validate 失败且 repairCount < 3 时走 repair_node，否则 END）
 *   → repair_node → 回到 validate_node
 *
 * 关键细节：
 * - 每一步写入 state，便于前端日志展示和中间态追踪
 * - repairCount 上限 3 次，防止无限循环
 * - 模板化优先原则：planner/generator 是确定性代码，repairer 用 LLM 兜底
 * - 节点函数内 try/catch 不抛异常，错误写入 state.errors 保证图不中断
 */
import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import type { WorkflowPlan, WorkflowSketch, ValidationResult } from "@coze-workflow/shared";
import type { CozeWorkflow } from "@coze-workflow/workflow-schema";
import { validateWorkflow } from "@coze-workflow/workflow-schema";
import type { WorkflowPlanner } from "./workflow-planner";
import type { WorkflowGenerator } from "./workflow-generator";
import type { WorkflowRepairer } from "./workflow-repairer";

// ============================================
// State 定义
// ============================================

export const WorkflowAgentState = Annotation.Root({
  /** 用户输入的需求 */
  requirement: Annotation<{ description: string; constraints?: string[] }>,
  /** 规划结果 */
  plan: Annotation<WorkflowPlan | null>,
  /** 工作流草图（中间产物） */
  sketch: Annotation<WorkflowSketch | null>,
  /** 最终 Coze 工作流 JSON */
  workflow: Annotation<CozeWorkflow | null>,
  /** 校验结果 */
  validation: Annotation<ValidationResult | null>,
  /** 执行日志 */
  errors: Annotation<string[]>,
  /** 修复次数 */
  repairCount: Annotation<number>,
});

export type WorkflowAgentStateType = typeof WorkflowAgentState.State;

// ============================================
// 图构建工厂
// ============================================

/**
 * 创建编译后的 LangGraph 工作流图
 *
 * 三个 Agent 实例通过闭包注入，免去 LangGraph 的依赖注入复杂度。
 */
export function createWorkflowGraph(
  planner: WorkflowPlanner,
  generator: WorkflowGenerator,
  repairer: WorkflowRepairer,
) {
  // ── 节点：规划 ──
  const planNode = async (state: WorkflowAgentStateType) => {
    try {
      const plan = await planner.plan(state.requirement);
      return { plan };
    } catch (e) {
      return {
        errors: [`plan_node 失败: ${(e as Error).message}`],
      };
    }
  };

  // ── 节点：草图 ──
  const sketchNode = async (state: WorkflowAgentStateType) => {
    try {
      if (!state.plan) {
        return { errors: ["sketch_node: plan 为空，跳过"] };
      }
      const { sketch } = generator.generate(state.plan);
      return { sketch };
    } catch (e) {
      return {
        errors: [`sketch_node 失败: ${(e as Error).message}`],
      };
    }
  };

  // ── 节点：生成 ──
  const generateNode = async (state: WorkflowAgentStateType) => {
    try {
      if (!state.plan) {
        return { errors: ["generate_node: plan 为空，跳过"] };
      }
      const { workflow } = generator.generate(state.plan);
      return { workflow };
    } catch (e) {
      return {
        errors: [`generate_node 失败: ${(e as Error).message}`],
      };
    }
  };

  // ── 节点：校验 ──
  const validateNode = (state: WorkflowAgentStateType) => {
    try {
      if (!state.workflow) {
        return {
          validation: { valid: false, errors: [{ code: "NO_WORKFLOW", message: "工作流为空" }], warnings: [] },
          errors: ["validate_node: workflow 为空"],
        };
      }
      const validation = validateWorkflow(state.workflow);
      return { validation };
    } catch (e) {
      return {
        validation: { valid: false, errors: [{ code: "VALIDATE_ERROR", message: (e as Error).message }], warnings: [] },
        errors: [`validate_node 异常: ${(e as Error).message}`],
      };
    }
  };

  // ── 节点：修复 ──
  const repairNode = async (state: WorkflowAgentStateType) => {
    try {
      if (!state.workflow || !state.validation) {
        return {
          errors: ["repair_node: workflow 或 validation 为空，跳过"],
          repairCount: state.repairCount + 1,
        };
      }
      const fixed = await repairer.repair(state.workflow, state.validation);
      return {
        workflow: fixed,
        repairCount: state.repairCount + 1,
        errors: [`repair_node: 第 ${state.repairCount + 1} 次修复完成`],
      };
    } catch (e) {
      return {
        errors: [`repair_node 失败: ${(e as Error).message}`],
        repairCount: state.repairCount + 1,
      };
    }
  };

  // ── 条件路由：validate 后决定继续修复还是结束 ──
  const decideAfterValidate = (state: WorkflowAgentStateType): string => {
    if (!state.validation) return END;

    // 验证通过 → 结束
    if (state.validation.valid) {
      return END;
    }

    // 验证失败 + 修复次数未超限 → 进修复
    if (state.repairCount < 3) {
      return "repair_node";
    }

    // 修复超限 → 结束（带错误）
    return END;
  };

  // ── 构建图 ──
  const graph = new StateGraph(WorkflowAgentState)
    .addNode("plan_node", planNode)
    .addNode("sketch_node", sketchNode)
    .addNode("generate_node", generateNode)
    .addNode("validate_node", validateNode)
    .addNode("repair_node", repairNode)
    .addEdge(START, "plan_node")
    .addEdge("plan_node", "sketch_node")
    .addEdge("sketch_node", "generate_node")
    .addEdge("generate_node", "validate_node")
    .addConditionalEdges("validate_node", decideAfterValidate)
    .addEdge("repair_node", "validate_node")
    .compile();

  return graph;
}
