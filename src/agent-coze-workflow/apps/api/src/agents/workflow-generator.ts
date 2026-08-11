/**
 * WorkflowGenerator - 工作流生成器
 *
 * 职责：
 * 将 WorkflowPlan 映射为 WorkflowSketch（草图）和 CozeWorkflow（最终 JSON）
 *
 * 流程：
 * 1. 接收 WorkflowPlan（含 steps、modules、complexity）
 * 2. 按 steps 顺序创建 Coze 节点（模板化：每种 nodeType 调对应工厂函数）
 * 3. 按 dependencies 创建连线
 * 4. 组装 CozeWorkflow 最终结构
 *
 * 关键细节：
 * - 模板化优先：不使用 LLM，纯代码映射（确定性、零 token、高可靠）
 * - nodeType → 工厂函数映射：start/end/llm/code/condition/http/database_query
 * - 条件节点的 branches 在模板阶段填写占位 TODO，后续由 LLM/人工细化
 * - 生成阶段不涉及 Coze 节点 JSON 的精细配置（那是 Coze 平台编辑的事）
 */
import { generateId } from "@coze-workflow/shared";
import type { WorkflowPlan, WorkflowSketch } from "@coze-workflow/shared";
import type {
  CozeWorkflow,
  CozeNode,
  CozeEdge,
} from "@coze-workflow/workflow-schema";
import {
  createStartNode,
  createEndNode,
  createLLMNode,
  createCodeNode,
  createConditionNode,
  createHttpNode,
  createDatabaseQueryNode,
} from "@coze-workflow/workflow-schema";

export class WorkflowGenerator {
  /**
   * 只生成 WorkflowSketch（轻量中间产物）
   *
   * 供 graph.ts 的 sketch_node 单独调用，避免重复计算
   */
  generateSketch(plan: WorkflowPlan): WorkflowSketch {
    return this.buildSketch(plan);
  }

  /**
   * 只生成 CozeWorkflow（完整最终 JSON）
   *
   * 供 graph.ts 的 generate_node 单独调用，避免重复计算
   */
  generateWorkflow(plan: WorkflowPlan): CozeWorkflow {
    return this.buildWorkflow(plan);
  }

  /**
   * 从 WorkflowPlan 生成草图 + Coze 工作流（组合调用）
   *
   * @param plan - 规划结果
   * @returns sketch（中间产物）和 workflow（最终 JSON）
   */
  generate(plan: WorkflowPlan): {
    sketch: WorkflowSketch;
    workflow: CozeWorkflow;
  } {
    return {
      sketch: this.generateSketch(plan),
      workflow: this.generateWorkflow(plan),
    };
  }

  /**
   * 构建 WorkflowSketch（轻量中间产物）
   */
  private buildSketch(plan: WorkflowPlan): WorkflowSketch {
    const nodes: WorkflowSketch["nodes"] = [];
    const edges: WorkflowSketch["edges"] = [];
    let nodeIndex = 0;

    for (const step of plan.steps) {
      const id = `${step.nodeType}_${++nodeIndex}`;
      nodes.push({
        id,
        type: step.nodeType,
        label: this.nodeLabelForType(step.nodeType),
        purpose: step.description,
      });

      // 按 dependencies 连线
      for (const depOrder of step.dependencies) {
        const depStep = plan.steps.find((s) => s.order === depOrder);
        if (depStep) {
          const depIdx = plan.steps.indexOf(depStep);
          const fromId = nodes[depIdx]?.id;
          if (fromId) {
            edges.push({ from: fromId, to: id });
          }
        }
      }
    }

    return {
      name: plan.name,
      description: plan.description,
      nodes,
      edges,
      notes: [
        `预估复杂度: ${plan.estimatedComplexity}`,
        `模块: ${plan.modules.join(", ")}`,
      ],
    };
  }

  /**
   * 构建 CozeWorkflow（完整最终 JSON）
   */
  private buildWorkflow(plan: WorkflowPlan): CozeWorkflow {
    const cozeNodes: CozeNode[] = [];
    // order → nodeId 映射，供 edges 引用
    const orderToId = new Map<number, string>();

    let positionY = 80;

    for (const step of plan.steps) {
      const node = this.createNodeForStep(step, positionY);
      cozeNodes.push(node);
      orderToId.set(step.order, node.id);
      positionY += 120;
    }

    // 按 dependencies 创建连线
    const edges: CozeEdge[] = [];
    for (const step of plan.steps) {
      for (const depOrder of step.dependencies) {
        const sourceId = orderToId.get(depOrder);
        const targetId = orderToId.get(step.order);
        if (sourceId && targetId) {
          edges.push({
            id: generateId(),
            sourceNodeId: sourceId,
            targetNodeId: targetId,
          });
        }
      }
    }

    return {
      meta: {
        name: plan.name,
        description: plan.description,
        version: "1.0.0",
      },
      nodes: cozeNodes,
      edges,
      _temp: {
        bounds: { x: 0, y: 0, width: 800, height: positionY + 100 },
        externalData: {},
      },
    };
  }

  /**
   * 根据 PlanStep 创建对应类型的 Coze 节点
   */
  private createNodeForStep(
    step: { nodeType: string; description: string },
    y: number,
  ): CozeNode {
    const title = this.nodeLabelForType(step.nodeType);
    const baseOverrides = {
      title,
      desc: step.description,
    };

    switch (step.nodeType) {
      case "start":
        return createStartNode();
      case "end":
        return createEndNode();
      case "llm":
        return createLLMNode(baseOverrides);
      case "code":
        return createCodeNode(baseOverrides);
      case "condition":
        return createConditionNode(baseOverrides);
      case "http":
        return createHttpNode(baseOverrides);
      case "database_query":
        return createDatabaseQueryNode(baseOverrides);
      default:
        // 未知类型降级为 LLM 节点
        return createLLMNode({ title: step.nodeType, desc: step.description });
    }
  }

  /**
   * nodeType → 中文标签映射
   */
  private nodeLabelForType(type: string): string {
    const labels: Record<string, string> = {
      start: "开始",
      end: "结束",
      llm: "LLM 处理",
      code: "代码处理",
      condition: "条件判断",
      http: "HTTP 请求",
      database_query: "数据库查询",
    };
    return labels[type] ?? type;
  }
}
