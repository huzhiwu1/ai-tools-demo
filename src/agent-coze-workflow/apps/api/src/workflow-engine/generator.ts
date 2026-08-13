/**
 * WorkflowGenerator - 工作流生成器
 *
 * 职责：
 * 将 WorkflowPlan 映射为 WorkflowSketch（草图）和 CozeWorkflow（最终 JSON）
 *
 * 流程：
 * 1. 接收 WorkflowPlan（含 steps、modules、complexity）
 * 2. 按 steps 顺序创建 Coze 节点（按 nodeConfig 组装真实业务逻辑）
 * 3. 代码节点由 CodeGenerator（LLM）生成真实 Python 代码
 * 4. 按 dependencies 创建连线
 * 5. 组装 CozeWorkflow 最终结构
 *
 * 关键细节：
 * - nodeConfig 由规划阶段 LLM 生成，generator 按此组装节点业务内容：
 *   llm 节点用 nodeConfig.llm 的模型+提示词，code 节点用 LLM 生成真实代码
 * - LLM 生成代码失败时降级为可运行模板（CodeGenerator.buildFallbackCode）
 * - database 节点无有效 connectionId 时跳过该节点（避免空 databaseInfoID）
 * - 未传入 CodeGenerator 时（旧链路），代码节点用兜底模板（纯同步模板）
 */
import { generateId } from "@coze-workflow/shared";
import type {
  WorkflowPlan,
  WorkflowSketch,
  PlanStep,
} from "@coze-workflow/shared";
import { Logger } from "@nestjs/common";
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
  createTextNode,
  createMergeNode,
} from "@coze-workflow/workflow-schema";
import { CodeGenerator } from "./code-generator";

export class WorkflowGenerator {
  private readonly logger = new Logger("WorkflowGenerator");

  constructor(private readonly codeGenerator?: CodeGenerator) {}
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
   * 供 graph.ts 的 generate_node 单独调用，避免重复计算。
   * 代码节点需要 LLM 生成真实业务代码，因此是异步方法。
   */
  async generateWorkflow(plan: WorkflowPlan): Promise<CozeWorkflow> {
    return this.buildWorkflow(plan);
  }

  /**
   * 从 WorkflowPlan 生成草图 + Coze 工作流（组合调用）
   *
   * @param plan - 规划结果
   * @returns sketch（中间产物）和 workflow（最终 JSON）
   */
  async generate(plan: WorkflowPlan): Promise<{
    sketch: WorkflowSketch;
    workflow: CozeWorkflow;
  }> {
    return {
      sketch: this.generateSketch(plan),
      workflow: await this.generateWorkflow(plan),
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
  private async buildWorkflow(plan: WorkflowPlan): Promise<CozeWorkflow> {
    const cozeNodes: CozeNode[] = [];
    // order → nodeId 映射，供 edges 引用
    const orderToId = new Map<number, string>();

    let positionY = 80;

    for (const step of plan.steps) {
      // database 节点无有效连接时跳过（空 databaseInfoID 会导致平台报错）
      if (
        step.nodeType === "database_query" &&
        !step.nodeConfig?.database?.connectionId
      ) {
        this.logger.warn(
          `[WorkflowGenerator] 跳过无连接的数据库节点 (step ${step.order}): ${step.description}`,
        );
        continue;
      }

      const node = await this.createNodeForStep(step, positionY);
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
   *
   * 按 nodeConfig 组装真实业务逻辑（不再纯模板占位）：
   * - llm：nodeConfig.llm 的模型 + 提示词
   * - code：CodeGenerator 按 logicDescription 生成真实 Python 代码
   * - condition：nodeConfig.condition 的真实分支条件
   * - database_query：nodeConfig.database 的真实连接 + 查询描述
   */
  private async createNodeForStep(
    step: PlanStep,
    y: number,
  ): Promise<CozeNode> {
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
      case "llm": {
        const cfg = step.nodeConfig?.llm;
        return createLLMNode({
          ...baseOverrides,
          userPrompt: cfg?.userPrompt ?? "{{input}}",
          systemPrompt: cfg?.systemPrompt,
          config: {
            // 平台可用模型（权威依据 platform-facts.md），Doubao-Seed-2.0-Lite 为兜底默认
            model: cfg?.model ?? "Doubao-Seed-2.0-Lite",
            temperature: 0.2,
            maxTokens: 4096,
          },
        });
      }
      case "code": {
        const cfg = step.nodeConfig?.code;
        // 有 LLM 代码生成器时按业务逻辑生成真实 Python 代码，否则用可运行兜底模板
        let code: string;
        if (this.codeGenerator && cfg?.logicDescription) {
          code = await this.codeGenerator.generateCode(
            cfg.logicDescription,
            cfg.inputs,
          );
        } else {
          code = CodeGenerator.buildFallbackCode(cfg?.inputs);
        }
        return createCodeNode({
          ...baseOverrides,
          code,
          language: "python",
        });
      }
      case "condition": {
        const cfg = step.nodeConfig?.condition;
        return createConditionNode({
          ...baseOverrides,
          branches: cfg?.branches?.map((b) => ({
            expression: b.condition,
            targetNodeId: "TODO",
          })),
        });
      }
      case "http": {
        const cfg = step.nodeConfig?.http;
        return createHttpNode({
          ...baseOverrides,
          method: (cfg?.method as "GET" | "POST" | "PUT" | "DELETE") ?? "GET",
          url: cfg?.url,
        });
      }
      case "database_query": {
        const cfg = step.nodeConfig?.database;
        return createDatabaseQueryNode({
          ...baseOverrides,
          connection: cfg?.connectionId ?? "",
          query: cfg?.queryDescription ?? "SELECT 1",
        });
      }
      case "text":
        return createTextNode(baseOverrides);
      case "merge":
        return createMergeNode(baseOverrides);
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
      text: "文本处理",
      merge: "变量聚合",
    };
    return labels[type] ?? type;
  }
}
