/**
 * MCP 层 - Coze 平台调用类型定义
 *
 * 设计思想：
 * - MCP（Model Context Protocol）用于 AI Agent 与外部平台通信
 * - 这里定义 Coze 平台的 API 调用接口类型
 * - 后续通过 MCP client 调用 Coze 内部 API
 */

/** Coze 工作流创建请求 */
export interface CozeCreateWorkflowRequest {
  /** 工作空间 ID */
  workspaceId: string;
  /** 工作流名称 */
  name: string;
  /** 工作流描述 */
  description: string;
  /** 工作流 JSON 内容 */
  workflowJson: string;
}

/** Coze 工作流创建响应 */
export interface CozeCreateWorkflowResponse {
  /** 是否成功 */
  success: boolean;
  /** 工作流 ID */
  workflowId?: string;
  /** 错误信息 */
  error?: string;
}

/** Coze 工作流试运行请求 */
export interface CozeRunWorkflowRequest {
  /** 工作流 ID */
  workflowId: string;
  /** 输入参数 */
  inputs: Record<string, unknown>;
}

/** Coze 工作流试运行响应 */
export interface CozeRunWorkflowResponse {
  /** 是否成功 */
  success: boolean;
  /** 执行结果 */
  result?: Record<string, unknown>;
  /** 执行日志 */
  logs?: string[];
  /** 错误信息 */
  error?: string;
}

/** MCP Client 配置 */
export interface McpClientConfig {
  /** Coze API 地址 */
  baseUrl: string;
  /** API Key */
  apiKey: string;
  /** 请求超时（毫秒） */
  timeout: number;
}
