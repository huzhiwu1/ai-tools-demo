/**
 * MCP 层 - Coze 平台调用客户端
 *
 * 职责：
 * 封装对 Coze 平台 API 的调用，包括工作流创建、保存、试运行等
 *
 * 设计思想：
 * - 作为 Agent 的工具层，与 LLM 逻辑完全分离
 * - 所有 API 调用都通过此客户端，便于 mock 和测试
 * - 统一处理认证、错误、重试
 *
 * 流程：
 * 1. 初始化时配置 API 地址和密钥
 * 2. Agent 通过工具接口调用客户端方法
 * 3. 客户端处理 HTTP 请求、认证、超时
 * 4. 返回标准化结果
 *
 * 关键细节：
 * - 所有方法必须设置超时（默认 30s）
 * - API 调用失败时返回结构化错误，不抛出异常
 * - 后续可扩展为通过 MCP 协议调用（而非直接 HTTP）
 *
 * TODO: 完整实现
 * - 实现真实的 HTTP 调用（当前为 mock）
 * - 添加请求重试机制
 * - 添加请求日志
 * - 添加错误码映射
 */
import type {
  McpClientConfig,
  CozeCreateWorkflowRequest,
  CozeCreateWorkflowResponse,
  CozeRunWorkflowRequest,
  CozeRunWorkflowResponse,
} from "./types";

export class CozeClient {
  private config: McpClientConfig;

  constructor(config: McpClientConfig) {
    this.config = config;
  }

  /**
   * 创建工作流
   *
   * TODO: 实现真实 API 调用
   * 当前为 mock 实现，返回模拟数据
   */
  async createWorkflow(
    req: CozeCreateWorkflowRequest,
  ): Promise<CozeCreateWorkflowResponse> {
    // TODO: 替换为真实 HTTP 调用
    console.log("[CozeClient] createWorkflow (mock)", req.name);
    return {
      success: true,
      workflowId: `wf_mock_${Date.now()}`,
    };
  }

  /**
   * 试运行工作流
   *
   * TODO: 实现真实 API 调用
   */
  async runWorkflow(
    req: CozeRunWorkflowRequest,
  ): Promise<CozeRunWorkflowResponse> {
    // TODO: 替换为真实 HTTP 调用
    console.log("[CozeClient] runWorkflow (mock)", req.workflowId);
    return {
      success: true,
      result: { output: "mock result" },
      logs: ["[mock] 工作流执行成功"],
    };
  }

  /**
   * 获取工作流详情
   *
   * TODO: 实现真实 API 调用
   */
  async getWorkflow(workflowId: string): Promise<unknown> {
    // TODO: 替换为真实 HTTP 调用
    console.log("[CozeClient] getWorkflow (mock)", workflowId);
    return { id: workflowId, status: "active" };
  }
}
