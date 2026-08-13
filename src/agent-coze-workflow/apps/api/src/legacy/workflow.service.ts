/**
 * WorkflowService —— 工作流业务服务
 *
 * 职责：
 * - 封装工作流相关的 mock 业务逻辑
 * - 供 WorkflowController 调用
 * - 后续接 Agent 模块时替换为真实逻辑
 */
import { Injectable, Inject, Logger } from "@nestjs/common";
import { createApiResponse, generateId } from "@coze-workflow/shared";
import type {
  WorkflowPlan,
  ValidationResult,
  WorkflowRunResult,
  WorkflowSketch,
} from "@coze-workflow/shared";
import type { CozeWorkflow } from "@coze-workflow/workflow-schema";
import {
  validateWorkflow,
  validateWorkflowJson,
  createStartNode,
  createLLMNode,
  createEndNode,
} from "@coze-workflow/workflow-schema";
import { WorkflowPlanner } from "../workflow-engine/planner";
import type { WorkflowAgentStateType } from "./graph";
import { CozeClient } from "../coze/coze.client";
import { convertToPlatformSchema } from "../coze/schema-converter";

/** LangGraph 编译后的图类型（StateGraph 编译产物） */
interface CompiledGraph {
  invoke(
    state: Partial<WorkflowAgentStateType>,
  ): Promise<WorkflowAgentStateType>;
}

@Injectable()
export class WorkflowService {
  private readonly logger = new Logger("WorkflowService");

  constructor(
    private readonly planner: WorkflowPlanner,
    @Inject("WORKFLOW_GRAPH") private readonly graph: CompiledGraph,
    private readonly cozeClient: CozeClient,
  ) {}
  /**
   * 规划工作流
   *
   * 输入：用户自然语言需求描述
   * 输出：WorkflowPlan（规划步骤、节点类型、预估复杂度）
   *
   * 降级策略：LLM 调用失败时返回 mock 计划，接口不挂、前端不白屏
   */
  async plan(requirement: {
    description: string;
    constraints?: string[];
  }): Promise<unknown> {
    try {
      const plan = await this.planner.plan(requirement);
      return createApiResponse(plan);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn("[WorkflowPlanner] LLM 规划失败，降级 mock:", msg);
    }

    // 降级分支：返回 mock 计划
    const plan: WorkflowPlan = {
      name: "示例工作流",
      description: requirement.description,
      steps: [
        {
          order: 1,
          description: "接收用户输入",
          nodeType: "start",
          dependencies: [],
        },
        {
          order: 2,
          description: "使用 LLM 分析需求",
          nodeType: "llm",
          dependencies: [1],
        },
        {
          order: 3,
          description: "根据分析结果返回响应",
          nodeType: "end",
          dependencies: [2],
        },
      ],
      modules: ["start", "llm", "end"],
      estimatedComplexity: "simple",
    };

    return createApiResponse(plan);
  }

  /**
   * 生成工作流草图
   *
   * 输出：WorkflowSketch（节点草图 + 连线）
   *
   * 这里先保留一层草图，是因为：
   * 1. 便于人类审查
   * 2. 便于做结构校验
   * 3. 便于 LLM 先规划，再落到 Coze JSON
   */
  sketch(requirement: {
    description: string;
    constraints?: string[];
  }): unknown {
    const sketch: WorkflowSketch = {
      name: "需求草图",
      description: requirement.description,
      nodes: [
        {
          id: "start",
          type: "start",
          label: "开始",
          purpose: "接收用户输入",
        },
        {
          id: "llm_1",
          type: "llm",
          label: "LLM 处理",
          purpose: "分析用户需求并生成响应",
        },
        {
          id: "end",
          type: "end",
          label: "结束",
          purpose: "返回最终结果",
        },
      ],
      edges: [
        { from: "start", to: "llm_1" },
        { from: "llm_1", to: "end" },
      ],
      notes: ["先草图，再转为 Coze JSON"],
    };

    return createApiResponse(sketch);
  }

  /**
   * 生成工作流
   *
   * 输入：WorkflowPlan 规划结果
   * 输出：WorkflowSchema（完整节点 + 连线）
   */
  generate(plan: WorkflowPlan): unknown {
    // 先生成节点，拿到真实 ID，再连线
    // （不能先写死 TODO 再连，边必须引用真实存在的节点）
    const start = createStartNode();
    const llm = createLLMNode({
      title: "LLM 处理",
      systemPrompt: "你是一个有用的助手",
      userPrompt: "{{user_input}}",
    });
    const end = createEndNode([
      { name: "result", type: "string", value: `${llm.id}.output` },
    ]);

    const schema: CozeWorkflow = {
      meta: {
        name: plan.name,
        description: plan.description,
        version: "1.0.0",
      },
      nodes: [start, llm, end],
      edges: [
        { id: generateId(), sourceNodeId: start.id, targetNodeId: llm.id },
        { id: generateId(), sourceNodeId: llm.id, targetNodeId: end.id },
      ],
      _temp: {
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        externalData: {},
      },
    };

    return createApiResponse(schema);
  }

  /**
   * 校验工作流
   */
  validate(workflow: unknown): unknown {
    // 字符串入参：用 validateWorkflowJson，解析失败也会返回结构化错误，不会抛 500
    if (typeof workflow === "string") {
      return createApiResponse(validateWorkflowJson(workflow));
    }

    if (workflow && typeof workflow === "object" && "nodes" in workflow) {
      return createApiResponse(validateWorkflow(workflow as CozeWorkflow));
    }

    const result: ValidationResult = {
      valid: false,
      errors: [
        {
          code: "INVALID_INPUT",
          message: "校验输入必须是工作流 JSON 字符串或包含 nodes 的对象",
        },
      ],
      warnings: [],
    };

    return createApiResponse(result);
  }

  /**
   * 创建工作流（提交到 Coze 平台）
   *
   * 流程：cozeClient.createWorkflow → convertToPlatformSchema → saveWorkflow。
   * 降级策略：CozeClient 调用失败时 console.warn + 返回 mock 结果，接口不挂。
   */
  async create(schema: CozeWorkflow): Promise<unknown> {
    try {
      const workflowId = await this.cozeClient.createWorkflow(
        schema.meta.name,
        schema.meta.description,
      );
      const platformSchema = convertToPlatformSchema(schema);
      await this.cozeClient.saveWorkflow(workflowId, platformSchema);
      return createApiResponse({
        workflowId,
        status: "created",
        saved: true,
        createdAt: new Date().toISOString(),
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(
        "[WorkflowService] CozeClient 创建失败，降级 mock:",
        msg,
      );
    }

    // 降级分支：返回 mock 结果
    return createApiResponse({
      workflowId: `wf_${generateId()}`,
      status: "created",
      message: "[Mock] 工作流已创建（实际需接入 Coze API）",
      createdAt: new Date().toISOString(),
      schema,
    });
  }

  /**
   * 保存工作流
   *
   * 流程：convertToPlatformSchema → cozeClient.saveWorkflow。
   * 降级策略：CozeClient 调用失败时 console.warn + 返回 mock 结果。
   */
  async save(schema: CozeWorkflow, workflowId?: string): Promise<unknown> {
    const id = workflowId ?? `wf_${generateId()}`;
    try {
      const platformSchema = convertToPlatformSchema(schema);
      await this.cozeClient.saveWorkflow(id, platformSchema);
      return createApiResponse({
        workflowId: id,
        version: "1.0.1",
        saved: true,
        savedAt: new Date().toISOString(),
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(
        "[WorkflowService] CozeClient 保存失败，降级 mock:",
        msg,
      );
    }

    // 降级分支：返回 mock 结果
    return createApiResponse({
      workflowId: id,
      version: "1.0.1",
      message: "[Mock] 工作流已保存（实际需接入 Coze API）",
      savedAt: new Date().toISOString(),
      schema,
    });
  }

  /**
   * 测试运行工作流
   *
   * 降级策略：CozeClient 调用失败时 console.warn + 返回 mock 结果。
   */
  async testRun(params: {
    workflowId: string;
    inputData: Record<string, unknown>;
  }): Promise<unknown> {
    try {
      const executeId = await this.cozeClient.testRun(
        params.workflowId,
        params.inputData,
      );
      const result: WorkflowRunResult = {
        runId: executeId,
        workflowId: params.workflowId,
        status: "running",
        nodeOutputs: {},
        totalDurationMs: 0,
        timestamp: new Date().toISOString(),
      };
      return createApiResponse(result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(
        "[WorkflowService] CozeClient 试运行失败，降级 mock:",
        msg,
      );
    }

    // 降级分支：返回 mock 结果
    const result: WorkflowRunResult = {
      runId: `run_${generateId()}`,
      workflowId: params.workflowId,
      status: "success",
      nodeOutputs: {
        start: {
          nodeId: "start",
          nodeType: "start",
          status: "success",
          output: params.inputData,
          durationMs: 5,
        },
        llm_1: {
          nodeId: "llm_1",
          nodeType: "llm",
          status: "success",
          output: "[Mock] LLM 响应内容",
          durationMs: 200,
        },
        end: {
          nodeId: "end",
          nodeType: "end",
          status: "success",
          output: { result: "[Mock] 最终结果" },
          durationMs: 3,
        },
      },
      totalDurationMs: 208,
      timestamp: new Date().toISOString(),
    };

    return createApiResponse(result);
  }

  /**
   * 运行完整 LangGraph Agent 流程
   *
   * 节点链：plan → sketch → generate → validate → (条件) repair → validate
   *
   * 返回完整的 state（含 plan/sketch/workflow/validation/errors/repairCount），
   * 便于前端展示每个阶段的中间产物和日志。
   */
  async run(requirement: {
    description: string;
    constraints?: string[];
  }): Promise<unknown> {
    const startTime = Date.now();

    const initialState: Partial<WorkflowAgentStateType> = {
      requirement: {
        description: requirement.description,
        constraints: requirement.constraints,
      },
      plan: null,
      sketch: null,
      workflow: null,
      validation: null,
      errors: [],
      repairCount: 0,
    };

    try {
      const finalState = await this.graph.invoke(initialState);
      const durationMs = Date.now() - startTime;
      return createApiResponse({
        ...finalState,
        durationMs,
        startedAt: new Date(startTime).toISOString(),
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error("[WorkflowGraph] 执行异常:", msg);
      return createApiResponse({
        ...initialState,
        errors: [`图执行异常: ${msg}`],
        durationMs: Date.now() - startTime,
        startedAt: new Date(startTime).toISOString(),
      });
    }
  }
}
