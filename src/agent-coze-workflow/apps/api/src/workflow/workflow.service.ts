/**
 * WorkflowService —— 工作流业务服务
 *
 * 职责：
 * - 封装工作流相关的 mock 业务逻辑
 * - 供 WorkflowController 调用
 * - 后续接 Agent 模块时替换为真实逻辑
 *
 * TODO: 后续接入 AgentsModule、McpModule 实现真实 Agent 编排
 */
import { Injectable } from "@nestjs/common";
import { createApiResponse, generateId } from "@coze-workflow/shared";
import type {
  WorkflowPlan,
  WorkflowSchema,
  ValidationResult,
  WorkflowRunResult,
} from "@coze-workflow/shared";

@Injectable()
export class WorkflowService {
  /**
   * 规划工作流
   *
   * POST /workflow/plan
   *
   * 输入：用户自然语言需求描述
   * 输出：WorkflowPlan（规划步骤、节点类型、预估复杂度）
   *
   * TODO: 后续接入 WorkflowPlanner Agent 实现真实规划
   */
  plan(requirement: { description: string; constraints?: string[] }): unknown {
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
   * 生成工作流
   *
   * POST /workflow/generate
   *
   * 输入：WorkflowPlan 规划结果
   * 输出：WorkflowSchema（完整节点 + 连线）
   *
   * TODO: 后续接入 WorkflowGenerator Agent 实现真实生成
   */
  generate(plan: WorkflowPlan): unknown {
    const schema: WorkflowSchema = {
      meta: {
        name: plan.name,
        description: plan.description,
        version: "1.0.0",
      },
      nodes: [
        {
          id: generateId(),
          type: "start",
          label: "开始",
          description: "接收用户输入",
          config: {
            inputVariables: [
              { name: "user_input", type: "string", required: true },
            ],
          },
        },
        {
          id: generateId(),
          type: "llm",
          label: "LLM 处理",
          description: "调用大模型处理用户输入",
          config: {
            model: "gpt-4o",
            temperature: 0.7,
            maxTokens: 2048,
            systemPrompt: "你是一个有用的助手",
            userPrompt: "{{user_input}}",
          },
        },
        {
          id: generateId(),
          type: "end",
          label: "结束",
          description: "返回最终结果",
          config: {
            outputVariables: [{ name: "result", type: "string", value: "" }],
          },
        },
      ],
      edges: [
        { id: generateId(), sourceNodeId: "TODO", targetNodeId: "TODO" },
        { id: generateId(), sourceNodeId: "TODO", targetNodeId: "TODO" },
      ],
    };

    return createApiResponse(schema);
  }

  /**
   * 校验工作流
   *
   * POST /workflow/validate
   *
   * 输入：工作流 JSON 字符串或对象
   * 输出：ValidationResult（valid + errors + warnings）
   *
   * TODO: 后续接入 validator 包的真实校验逻辑
   */
  validate(workflow: unknown): unknown {
    const result: ValidationResult = {
      valid: true,
      errors: [],
      warnings: [
        {
          code: "MOCK_VALIDATION",
          message: "当前为 mock 校验，所有输入均返回通过",
        },
      ],
    };

    return createApiResponse(result);
  }

  /**
   * 创建工作流（提交到 Coze 平台）
   *
   * POST /workflow/create
   *
   * 输入：WorkflowSchema
   * 输出：{ workflowId: string, status: string }
   *
   * TODO: 后续接入 CozeClient（McpModule）实现真实创建
   */
  create(schema: WorkflowSchema): unknown {
    return createApiResponse({
      workflowId: `wf_${generateId()}`,
      status: "created",
      message: "[Mock] 工作流已创建（实际需接入 Coze API）",
      createdAt: new Date().toISOString(),
    });
  }

  /**
   * 保存工作流
   *
   * POST /workflow/save
   *
   * 输入：WorkflowSchema + workflowId（可选，用于更新已有工作流）
   * 输出：{ workflowId: string, version: string }
   *
   * TODO: 后续接入 CozeClient 实现真实保存
   */
  save(schema: WorkflowSchema, workflowId?: string): unknown {
    return createApiResponse({
      workflowId: workflowId ?? `wf_${generateId()}`,
      version: "1.0.1",
      message: "[Mock] 工作流已保存（实际需接入 Coze API）",
      savedAt: new Date().toISOString(),
    });
  }

  /**
   * 测试运行工作流
   *
   * POST /workflow/test-run
   *
   * 输入：{ workflowId: string, inputData: Record<string, unknown> }
   * 输出：WorkflowRunResult
   *
   * TODO: 后续接入 CozeClient 实现真实测试运行
   */
  testRun(params: {
    workflowId: string;
    inputData: Record<string, unknown>;
  }): unknown {
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
}
