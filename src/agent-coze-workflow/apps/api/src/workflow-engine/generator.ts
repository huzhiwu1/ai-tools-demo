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
  if (node.type === "end") return "output";
  // 读取节点自身的 outputs 声明（start 的 inputVariables / llm/code 的 outputs），取第一个
  if (node.type === "start") {
    const vars = (node as unknown as { inputVariables?: Array<{ name?: string }> })
      ?.inputVariables;
    if (vars && vars.length > 0 && vars[0]?.name) return vars[0].name;
    return "input";
  }
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

    if (source.type === "start") {
      // start 多输入：把所有入口参数都映射给下游
      const vars = (source as unknown as {
        inputVariables?: Array<{ name?: string }>;
      })?.inputVariables;
      const names: string[] =
        vars && vars.length > 0
          ? vars.map((v) => v.name).filter((n): n is string => !!n)
          : [sourceOutput];
      const existing = mapping.get(target.id) ?? {};
      for (const name of names) {
        existing[name] = `${edge.sourceNodeId}.${name}`;
      }
      mapping.set(target.id, existing);
      continue;
    }

    // 其余节点 → input
    const paramName = "input";

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
/**
 * 为 LLM 节点添加 default + branch_error 两条出边
 *
 * 平台约定（2026-08-14 平台样本实测）：
 * - 大模型节点（type=3）必须有两根出边：
 *   - "default" → 下游处理节点（正常输出）
 *   - "branch_error" → 错误处理节点或 end 节点（异常分支）
 * - 代码节点（type=5）出边不写 sourcePortID
 *
 * 参考：docs/coze-platform/coze-node-fields-guide.md
 * 样本 LLM 节点 200101：default→200102(代码), branch_error→1287269(文本处理)
 *
 * @param endNodeId - 汇聚的 end 节点 ID，branch_error 指向此
 */
function createLLMEdges(
  nodes: CozeNode[],
  edges: CozeEdge[],
  endNodeId: string,
): void {
  for (const node of nodes) {
    if (node.type !== "llm") continue;

    // 找到 LLM 节点已有的出边（指向下一个处理节点）
    const existingEdge = edges.find((e) => e.sourceNodeId === node.id);
    if (existingEdge) {
      // 给主边加上 default 端口（平台要求大模型出边带端口标记）
      existingEdge.sourcePort = "default";
    }

    // 检查是否已有 branch_error 边（避免重复添加）
    const hasBranchError = edges.some(
      (e) => e.sourceNodeId === node.id && e.sourcePort === "branch_error",
    );
    if (!hasBranchError) {
      // 添加 branch_error 边指向 end 节点（异常时走这里）
      edges.push({
        id: generateId(),
        sourceNodeId: node.id,
        targetNodeId: endNodeId,
        sourcePort: "branch_error",
      });
    }
  }
}

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
      // ⚠️ 同步回填 branches[].targetNodeId（2026-08-16）：
      // 之前只解析进 edges，branches 里仍是 "TODO"，generate 输出暴露给 LLM 后
      // 被误判为"工作流坏了"，触发反复重新设计。回填后输出完全干净。
      branches[i].targetNodeId = resolvedTarget;
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

    // 为 LLM 节点添加 default + branch_error 端口边（平台要求 LLM 节点两条出边）
    // 大模型节点必须同时有正常输出和异常分支两根出线，否则 validate_tree 报端口未连接
    const endNode = cozeNodes.find((n) => n.type === "end");
    const endNodeId = endNode?.id ?? "900001";
    createLLMEdges(cozeNodes, edges, endNodeId);

    // 为条件节点创建所有分支边 + else 边（带正确的 sourcePortID，避免 validate_tree 报端口未连接）
    createConditionEdges(cozeNodes, edges, endNodeId);

    // ⚠️ 修复（2026-08-16）：结束节点 outputVariables 的 value 引用回填。
    // schema-converter 优先读 outputVariables[0].value（"nodeId.outputName"），
    // 没有才 fallback 找上游（可能误接 LLM）。
    // 优先级：
    //   1. end step 的 contract.outputs[].source 显式声明（LLM 决定接谁，如 source="result"）
    //   2. 匹配不到时 fallback 最后一个业务节点（兜底）
    if (endNode) {
      const endVars = (endNode as unknown as {
        outputVariables?: Array<{ name?: string; value?: string }>;
      })?.outputVariables;
      // 找 end step 的 contract（LLM 声明的输出来源）
      const endStep = plan.steps.find((s) => s.nodeType === "end");
      const endContractOutputs =
        (endStep as unknown as {
          contract?: {
            outputs?: Array<{ name?: string; source?: string }>;
          };
        })?.contract?.outputs ?? [];

      if (endVars && endVars.length > 0) {
        const businessNodes = cozeNodes.filter(
          (n) => n.type !== "start" && n.type !== "end",
        );
        const lastBusiness = businessNodes[businessNodes.length - 1];

        for (let i = 0; i < endVars.length; i++) {
          const v = endVars[i];
          if (!v.name || v.value) continue;

          // 1) 优先按 source 匹配：source 是上游输出变量名（如 "result"）
          const declaredSource = endContractOutputs[i]?.source;
          let targetNode: CozeNode | undefined;
          let targetOutput = "output";
          if (declaredSource) {
            targetNode = businessNodes.find((n) => {
              const outs = (n as unknown as {
                outputs?: Array<{ name?: string }>;
              })?.outputs;
              return outs?.some((o) => o.name === declaredSource);
            });
            targetOutput = declaredSource;
          }

          // 2) fallback：最后一个业务节点（无 source 或匹配不到）
          if (!targetNode && lastBusiness) {
            targetNode = lastBusiness;
            targetOutput =
              (lastBusiness as unknown as {
                outputs?: Array<{ name?: string }>;
              })?.outputs?.[0]?.name ?? "output";
          }

          if (targetNode) {
            v.value = `${targetNode.id}.${targetOutput}`;
          }
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
        // 多输入支持：start 的输入变量从 contract.outputs 生成（LLM 的 startInputs）
        return createStartNode(
          step.contract?.outputs?.map((o) => ({
            name: o.name,
            type: o.type ?? "string",
            required: true,
            default: (o as { default?: string }).default,
          })),
        );
      case "end":
        // 结束节点输出变量 = plan 的 contract.outputs（LLM 规划的数据契约）。
        // ⚠️ 修复（2026-08-16）：之前 createEndNode() 空参导致 outputVariables=[]，
        // schema-converter 正向转换时结束节点 inputParameters 落到默认引用（第一个上游/LLM 输出），
        // 表现为"结束节点 output 接的是 LLM 的 output 而不是代码节点的 result"。
        // 必须从 contract 生成，结束节点才能真正输出业务节点（如代码节点）的结果。
        return createEndNode(
          step.contract?.outputs?.map((o) => ({
            name: o.name,
            type: o.type ?? "string",
            value: "", // 引用表达式由 buildInputMapping / schema-converter 回填
          })),
        );
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
          // 从 contract.inputs 提取变量名，拼成 {{name}} 引用
          // 平台要求 prompt 模板中用 {{变量名}} 引用上游输出，否则大模型拿不到变量值
          const inputRefs =
            contract.inputs && contract.inputs.length > 0
              ? contract.inputs.map((i) => `{{${i.name}}}`).join("、")
              : "{{input}}";
          // prompt 模板：基于 description 生成，带上变量引用（不靠 LLM 写全文）
          const userPrompt = `你是一个工作流助手。任务：${desc}\n输入：${inputRefs}\n请根据上述输入完成任务，输出 JSON 格式结果。`;
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
      case "text": {
        const cfg = step.nodeConfig?.text;
        const contract = step.contract;
        // 拼接模板：优先 nodeConfig.text.concatResult（LLM 输出，如 "姓名：{{name}}，年龄：{{age}}"）
        // 否则从 contract.inputs 推断（{{name}}+{{age}}）
        let template = cfg?.concatResult;
        if (!template && contract?.inputs && contract.inputs.length > 0) {
          template = contract.inputs.map((i) => `{{${i.name}}}`).join("+");
        }
        return createTextNode({
          ...baseOverrides,
          concatParams: template
            ? [{ name: "concatResult", value: template }]
            : undefined,
        });
      }
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
