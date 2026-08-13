/**
 * WorkflowGenerator - 工作流生成器
 *
 * 职责：
 * 将 WorkflowPlan 映射为 WorkflowSketch（草图）和 CozeWorkflow（最终 JSON）
 *
 * LLM 只做这些事：
 * 1. 从需求中梳理出需要用什么节点（节点类型序列）
 * 2. 梳理出节点怎么连接（依赖关系/边）
 * 3. 确定每个节点的数据契约（变量名、输入结构、输出结构、单批处理）
 *
 * 其余一切由代码完成：
 * - 节点顺序按 dependencies 拓扑排序（不是 LLM 输出的 order）
 * - inputMapping 根据 edges 自动生成（数据流接线，不靠 LLM）
 * - 条件分支 targetNodeId 由 edges 自动回填（没有 TODO）
 * - 代码节点代码由 CodeGenerator 生成（或兜底模板）
 * - 模型选择按任务类型从平台事实匹配
 * - prompt 文本基于节点 description 模板化生成
 *
 * 流程：
 * 1. topoSortSteps(plan.steps) — 拓扑排序依赖
 * 2. 第 1 遍遍历：createNodeForStep → 生成节点骨架 + 记录 code 节点
 * 3. 按 dependencies 创建 edges
 * 4. buildInputMapping — 自动生成所有节点的 inputMapping
 * 5. 第 2 遍遍历 code 节点：用真实 inputNames + logicDescription 生成代码
 * 6. createConditionEdges — 为条件节点创建所有分支边 + else 边（带正确的 sourcePortID）
 *
 * 关键细节：
 * - LLM 生成代码失败时降级为可运行模板（CodeGenerator.buildFallbackCode）
 * - database 节点无有效 connectionId 时跳过该节点
 * - 未传入 CodeGenerator 时（旧链路），代码节点用兜底模板
 * - CozeNode 是对象引用，第 2 遍直接修改 node.code，第 1 遍的引用自动更新
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

/**
 * 按 dependencies 拓扑排序 steps
 *
 * LLM 输出的 order 可能错误（如 code 在 llm 之前），代码必须保证
 * start → ... → end 的正确依赖顺序。
 */
function topoSortSteps(steps: PlanStep[]): PlanStep[] {
  const result: PlanStep[] = [];
  const visited = new Set<number>();
  const orderMap = new Map(steps.map((s) => [s.order, s]));

  const visit = (order: number): void => {
    if (visited.has(order)) return;
    visited.add(order);
    const step = orderMap.get(order);
    if (!step) return;
    for (const dep of step.dependencies) visit(dep);
    result.push(step);
  };

  for (const step of steps) visit(step.order);
  return result;
}

/**
 * 获取节点默认输出名称
 *
 * start → "input", llm/code/condition/http/database_query/text/merge → "output"
 */
function outputNameForNode(node: CozeNode): string {
  if (node.type === "start") return "input";
  if (node.type === "end") return "output";
  // 读取节点自身的 outputs 声明，取第一个输出字段名
  const outputs = (node as unknown as Record<string, unknown>)?.outputs as
    | Array<{ name?: string }>
    | undefined;
  if (outputs && outputs.length > 0 && outputs[0]?.name) {
    return outputs[0].name;
  }
  return "output";
}

/**
 * 自动生成节点 inputMapping
 *
 * 规则：对于每条边 source→target，若 target 是 llm/code 节点，
 * 把 source 节点的输出名映射为 target 节点的输入参数名：
 * - start 的输出 → user_input
 * - llm/code 的输出 → input
 *
 * 命名约定由代码控制，不是 LLM。
 *
 * @param nodes - 已生成的所有节点
 * @param edges - 已生成的所有连线
 * @returns targetNodeId → { 参数名: "sourceNodeId.outputName" }
 */
function buildInputMapping(
  nodes: CozeNode[],
  edges: CozeEdge[],
): Map<string, Record<string, string>> {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const mapping = new Map<string, Record<string, string>>();

  for (const edge of edges) {
    const source = nodeById.get(edge.sourceNodeId);
    const target = nodeById.get(edge.targetNodeId);
    if (!source || !target) continue;
    // 只对 llm/code/text/http/database_query 节点生成 inputMapping
    if (
      target.type !== "llm" &&
      target.type !== "code" &&
      target.type !== "text" &&
      target.type !== "http" &&
      target.type !== "database_query"
    ) {
      continue;
    }

    const sourceOutput = outputNameForNode(source);
    // start 的输出 → user_input，其余 → input
    const paramName = source.type === "start" ? "user_input" : "input";

    const existing = mapping.get(target.id) ?? {};
    // 同一 source 可能有多个输出？当前只映射第一个输出
    existing[paramName] = `${edge.sourceNodeId}.${sourceOutput}`;
    mapping.set(target.id, existing);
  }

  return mapping;
}

/**
 * 确定条件节点第 index 个分支的端口名
 *
 * 端口命名规则（validate_tree 报错实测 + platform 源码 branch_schema.go 确认）：
 * - 条件分支：true（第1个），true_1（第2个），true_2（第3个），...
 * - 否则/else：false（自动生成，需连到 end 节点）
 * - 异常分支：branch_error（一般不使用）
 *
 * 参考：https://github.com/coze-dev/coze-studio/blob/main/backend/domain/workflow/internal/schema/branch_schema.go
 */
function conditionBranchPort(index: number): string {
  if (index === 0) return "true";
  return `true_${index}`;
}

/**
 * 为条件节点创建所有分支边 + else 边
 *
 * 问题：依赖树只生成 1 条边（condition → end），但平台要求每个分支
 * 都有自己的边（带 sourcePortID），否则 validate_tree 报端口未连接。
 *
 * 规则：
 * - 为每个条件分支创建一条边，端口为 "true", "true_1", "true_2", ...
 * - 为 else/default 创建一条边，端口为 "false"，指向 end 节点
 * - 所有边汇聚到同一个 end 节点（平台只允许一个 end）
 *
 * 区别于 fillConditionTargets(旧)：旧函数只在 branches 上设置 targetNodeId
 * 但不创建边。新函数直接创建带端口的边，让 validate_tree 通过。
 *
 * @param endNodeId - 所有分支汇聚的 end 节点 ID
 */
function createConditionEdges(
  nodes: CozeNode[],
  edges: CozeEdge[],
  endNodeId: string,
): void {
  for (const node of nodes) {
    if (node.type !== "condition") continue;
    const branches =
      (node as CozeNode & { branches?: Array<{ targetNodeId?: string }> })
        .branches ?? [];

    // 删除旧的依赖树边（condition → end），因为我们要重新创建
    const oldEdges = edges.filter((e) => e.sourceNodeId === node.id);
    for (const old of oldEdges) {
      const idx = edges.indexOf(old);
      if (idx >= 0) edges.splice(idx, 1);
    }

    // 为每个条件分支创建一条边
    for (let i = 0; i < branches.length; i++) {
      const target = branches[i].targetNodeId;
      // targetNodeId 可能是 "TODO" 占位符，视为未设置，汇聚到 end
      const resolvedTarget =
        target && target !== "TODO" ? target : endNodeId;
      edges.push({
        id: generateId(),
        sourceNodeId: node.id,
        targetNodeId: resolvedTarget,
        sourcePort: conditionBranchPort(i),
      });
    }

    // 为 else/default 创建一条边，指向 end
    edges.push({
      id: generateId(),
      sourceNodeId: node.id,
      targetNodeId: endNodeId,
      sourcePort: "false",
    });
  }
}

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
   *
   * @param plan - 规划结果
   * @param referenceData - 用户参考数据（如歌词库），代码生成时传入 LLM 防止幻觉
   */
  async generateWorkflow(
    plan: WorkflowPlan,
    referenceData?: Record<string, string>,
  ): Promise<CozeWorkflow> {
    return this.buildWorkflow(plan, referenceData);
  }

  /**
   * 从 WorkflowPlan 生成草图 + Coze 工作流（组合调用）
   *
   * @param plan - 规划结果
   * @returns sketch（中间产物）和 workflow（最终 JSON）
   */
  async generate(
    plan: WorkflowPlan,
    referenceData?: Record<string, string>,
  ): Promise<{
    sketch: WorkflowSketch;
    workflow: CozeWorkflow;
  }> {
    return {
      sketch: this.generateSketch(plan),
      workflow: await this.generateWorkflow(plan, referenceData),
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
   *
   * 两遍遍历设计：
   * - 第 1 遍：创建所有节点骨架（获取 orderToId + code 节点引用）
   * - 生成 edges
   * - buildInputMapping + 填充 inputMapping
   * - 第 2 遍：为 code 节点用真实 inputNames 重新生成代码
   * - createConditionEdges（为条件节点创建所有分支边 + else 边）
   */
  private async buildWorkflow(
    plan: WorkflowPlan,
    referenceData?: Record<string, string>,
  ): Promise<CozeWorkflow> {
    // 0. 拓扑排序（保证 start → ... → end 的正确顺序）
    const sortedSteps = topoSortSteps(plan.steps);

    const cozeNodes: CozeNode[] = [];
    const orderToId = new Map<number, string>();
    /** 第 1 遍创建的 code 节点，第 2 遍重新生成 code */
    const codeEntries: Array<{ step: PlanStep; node: CozeNode }> = [];

    let positionY = 80;

    // 第 1 遍：创建所有节点骨架
    for (const step of sortedSteps) {
      // database 节点无有效连接时跳过
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

      if (step.nodeType === "code") {
        codeEntries.push({ step, node });
      }

      positionY += 120;
    }

    // 按 dependencies 创建连线
    const edges: CozeEdge[] = [];
    for (const step of sortedSteps) {
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

    // 自动生成 inputMapping（数据流接线，不靠 LLM）
    const inputMapping = buildInputMapping(cozeNodes, edges);
    for (const [nodeId, map] of inputMapping) {
      const node = cozeNodes.find((n) => n.id === nodeId);
      if (node) {
        (node as unknown as Record<string, unknown>).inputMapping = map;
      }
    }

    // 第 2 遍：根据 inputMapping 重新生成 code 节点的代码
    for (const { step, node } of codeEntries) {
      const cfg = step.nodeConfig?.code;
      // 从 inputMapping 取真实输入变量名（第 1 遍用的 cfg.inputs 可能不准确）
      const inputNames = inputMapping.has(node.id)
        ? Object.keys(inputMapping.get(node.id)!)
        : (cfg?.inputs ?? ["input"]);

      let code: string;
      if (this.codeGenerator && cfg?.logicDescription) {
        code = await this.codeGenerator.generateCode(
          cfg.logicDescription,
          inputNames,
          referenceData,
        );
      } else {
        code = CodeGenerator.buildFallbackCode(inputNames);
      }
      (node as unknown as Record<string, unknown>).code = code;
      (node as unknown as Record<string, unknown>).language = "python";
    }

    // 为条件节点创建所有分支边 + else 边（带正确的 sourcePortID，避免 validate_tree 报端口未连接）
    const endNode = cozeNodes.find((n) => n.type === "end");
    const endNodeId = endNode?.id ?? "900001";
    createConditionEdges(cozeNodes, edges, endNodeId);

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
   * 根据 PlanStep 创建对应类型的 Coze 节点（第 1 遍骨架创建）
   *
   * code 节点在第 2 遍用真实 inputNames + CodeGenerator 重新生成代码，
   * 第 1 遍仅创建骨架（code 用兜底占位），确保 orderToId 可映射。
   *
   * condition 节点 branches 的 targetNodeId 由 createConditionEdges 回填。
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
        const contract = step.contract;

        // 优先用 contract.outputs 作为输出声明（LLM 规划的数据契约）
        const outputs = contract?.outputs?.map((o) => ({
          type: o.type,
          name: o.name,
          schema: {},
        }));

        // 当 contract 存在且无 nodeConfig 时，基于 description 代码式生成（LLM 不输出业务细节）
        if (contract && !cfg) {
          const desc = step.description;
          // 模型选择：根据 description 判断任务类型（音频/视频任务选 audio=true 模型）
          const isAudioTask =
            /音频|视频|识别|语音|audio|video|recognize|理解/i.test(desc);
          const model = isAudioTask
            ? "Doubao-Seed-2.0-Lite"
            : "Doubao-Seed-2.0-Lite";
          // prompt 模板：基于 description 生成（不靠 LLM 写全文）
          const userPrompt = `你是一个工作流助手。任务：${desc}。请根据输入完成任务，输出 JSON 格式结果。`;
          return createLLMNode({
            ...baseOverrides,
            userPrompt,
            config: { model, temperature: 0.2, maxTokens: 4096 },
            outputs,
          });
        }

        // 原有逻辑（nodeConfig 优先级更高）
        return createLLMNode({
          ...baseOverrides,
          userPrompt: cfg?.userPrompt ?? "{{input}}",
          systemPrompt: cfg?.systemPrompt,
          config: {
            model: cfg?.model ?? "Doubao-Seed-2.0-Lite",
            temperature: 0.2,
            maxTokens: 4096,
          },
          outputs,
        });
      }
      case "code": {
        const cfg = step.nodeConfig?.code;
        const contract = step.contract;
        // 优先用 contract.inputs 作为输入变量名
        const inputNames = contract?.inputs?.map((i) => i.name) ??
          cfg?.inputs ?? ["input"];
        // 优先用 contract.outputs 作为输出声明
        const outputs = contract?.outputs?.map((o) => ({
          type: o.type,
          name: o.name,
          schema: {},
        })) ?? [{ type: "object" as const, name: "output", schema: {} }];
        // 第 1 遍：先用 inputNames 生成兜底代码
        // 第 2 遍 buildWorkflow 会重新生成
        const code = CodeGenerator.buildFallbackCode(inputNames);
        return createCodeNode({
          ...baseOverrides,
          code,
          language: "python",
          outputs,
        });
      }
      case "condition": {
        const cfg = step.nodeConfig?.condition;
        const contract = step.contract;

        // 当无 nodeConfig 但有 contract 时，基于 description 自动生成分支结构
        if (!cfg && contract) {
          const desc = step.description;
          // 按描述语义生成默认分支（成功/失败）
          const branches = [
            { expression: `${desc} 条件满足`, targetNodeId: "TODO" as const },
            { expression: `${desc} 条件不满足`, targetNodeId: "TODO" as const },
          ];
          return createConditionNode({ ...baseOverrides, branches });
        }

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
