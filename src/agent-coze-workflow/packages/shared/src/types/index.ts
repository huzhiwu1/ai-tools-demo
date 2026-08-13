// @coze-workflow/shared - 跨模块共享的类型定义

// ============================================
// Agent 状态定义（预留，后续接 Agent 核心）
// ============================================

/** Agent 运行状态枚举 */
export type AgentStatus = "idle" | "running" | "completed" | "failed";

/** Agent 单步执行记录 */
export interface AgentStep {
  /** 步骤序号 */
  index: number;
  /** 步骤类型：思考 / 工具调用 / 观察 */
  type: "thought" | "action" | "observation";
  /** 步骤内容 */
  content: string;
  /** 执行耗时（毫秒） */
  durationMs: number;
  /** 时间戳 */
  timestamp: string;
}

/** Agent 运行状态快照 */
export interface AgentState {
  /** 当前任务描述 */
  task: string;
  /** 执行步骤历史 */
  history: AgentStep[];
  /** 当前步骤序号 */
  currentStep: number;
  /** 最大步骤限制 */
  maxSteps: number;
  /** 运行状态 */
  status: AgentStatus;
  /** 最终结果 */
  finalAnswer?: string;
}

// ============================================
// 通用 API 响应类型
// ============================================

/** 统一 API 响应格式 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
}

// ============================================
// 工作流核心类型（前后端共用）
// ============================================

/** 用户需求输入 */
export interface UserRequirement {
  /** 需求描述 */
  description: string;
  /** 可选：参考示例 */
  examples?: string[];
  /** 可选：约束条件 */
  constraints?: string[];
}

/** 工作流规划结果（Agent 规划阶段产出） */
export interface WorkflowPlan {
  /** 工作流名称 */
  name: string;
  /** 整体描述 */
  description: string;
  /** 规划步骤列表 */
  steps: PlanStep[];
  /** 涉及的工具/模块 */
  modules: string[];
  /** 预估复杂度 */
  estimatedComplexity: "simple" | "medium" | "complex";
}

/** 规划步骤 */
export interface PlanStep {
  /** 步骤序号 */
  order: number;
  /** 步骤描述 */
  description: string;
  /** 该步骤产出的节点类型 */
  nodeType: WorkflowNodeType;
  /** 依赖的前置步骤 */
  dependencies: number[];
  /**
   * 数据契约（LLM 确定，代码按此组装节点）
   *
   * LLM 只输出节点类型 + 连接 + 数据契约（变量名/输入结构/输出结构/单批处理），
   * 完整节点 JSON 由代码组装。
   */
  contract?: {
    /** 输入变量：该节点接收哪些参数（名称 + 来源说明） */
    inputs?: Array<{ name: string; source: string }>;
    /** 输出变量：该节点输出哪些字段（名称 + 类型） */
    outputs?: Array<{
      name: string;
      type: "string" | "object" | "list" | "integer" | "number" | "boolean";
    }>;
    /** 单处理还是批处理 */
    batchMode?: "single" | "batch";
  };
  /** @deprecated 节点业务配置（LLM 生成），推荐用 contract 替代 */
  nodeConfig?: {
    /** LLM 节点：模型名（平台可用模型）+ 提示词 */
    llm?: { model: string; userPrompt: string; systemPrompt?: string };
    /** 代码节点：业务逻辑描述（LLM 生成真实 Python 代码用） */
    code?: { logicDescription: string; inputs?: string[] };
    /** 条件节点：分支条件描述 */
    condition?: { branches: Array<{ label: string; condition: string }> };
    /** 数据库节点：连接标识 + 查询描述（无真实连接时不要生成该节点） */
    database?: { connectionId: string; queryDescription: string };
    /** HTTP 节点：方法/URL/描述 */
    http?: { method: string; url: string; description: string };
  };
}

/** 工作流节点类型枚举 */
export type WorkflowNodeType =
  | "start"
  | "end"
  | "llm"
  | "code"
  | "condition"
  | "http"
  | "database_query"
  | "text"
  | "merge";

/** 工作流节点（中间态，供前端展示和编辑） */
export interface WorkflowNode {
  /** 节点唯一 ID */
  id: string;
  /** 节点类型 */
  type: WorkflowNodeType;
  /** 节点名称 */
  label: string;
  /** 节点描述 */
  description: string;
  /** 画布位置 */
  position?: { x: number; y: number };
  /** 节点配置数据 */
  config: Record<string, unknown>;
  /** 输入参数 */
  inputs?: Record<string, unknown>;
  /** 输出参数 */
  outputs?: Record<string, unknown>;
  /** Coze 兼容元信息（保留扩展位） */
  _temp?: {
    bounds?: { x: number; y: number; width: number; height: number };
    externalData?: Record<string, unknown>;
  };
}

/** 工作流连线 */
export interface WorkflowEdge {
  /** 连线 ID */
  id: string;
  /** 源节点 ID */
  sourceNodeId: string;
  /** 目标节点 ID */
  targetNodeId: string;
  /** 源节点输出端口（条件节点多分支用） */
  sourcePort?: string;
}

/** 工作流完整 schema */
export interface WorkflowSchema {
  /** 元信息 */
  meta: {
    name: string;
    description: string;
    version: string;
    workspaceId?: string;
  };
  /** 节点列表 */
  nodes: WorkflowNode[];
  /** 连线列表 */
  edges: WorkflowEdge[];
  /** Coze 兼容元信息（保留扩展位） */
  _temp?: {
    bounds?: { x: number; y: number; width: number; height: number };
    externalData?: Record<string, unknown>;
  };
}

/** 工作流草图（LLM 规划阶段产出） */
export interface WorkflowSketch {
  name: string;
  description: string;
  nodes: Array<{
    id: string;
    type: WorkflowNodeType;
    label: string;
    purpose: string;
  }>;
  edges: Array<{
    from: string;
    to: string;
    sourcePort?: string;
  }>;
  notes?: string[];
}

/** 校验结果 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

/** 校验错误 */
export interface ValidationError {
  /** 错误代码 */
  code: string;
  /** 错误描述 */
  message: string;
  /** 关联的节点 ID（可选） */
  nodeId?: string;
  /** 关联的边 ID（可选） */
  edgeId?: string;
}

/** 校验警告 */
export interface ValidationWarning {
  /** 警告代码 */
  code: string;
  /** 警告描述 */
  message: string;
  /** 关联的节点 ID（可选） */
  nodeId?: string;
}

// ============================================
// MCP 客户端类型（预留，后续接 Coze API）
// ============================================

/** MCP 工具调用请求 */
export interface McpRequest {
  /** 工具名称 */
  tool: string;
  /** 工具参数 */
  params: Record<string, unknown>;
}

/** MCP 工具调用响应 */
export interface McpResponse<T = unknown> {
  /** 是否成功 */
  success: boolean;
  /** 响应数据 */
  data?: T;
  /** 错误信息 */
  error?: string;
  /** 耗时（毫秒） */
  durationMs: number;
  /** 时间戳 */
  timestamp: string;
}

// ============================================
// 工作流执行结果类型
// ============================================

/** 工作流执行结果 */
export interface WorkflowRunResult {
  /** 运行 ID */
  runId: string;
  /** 工作流 ID */
  workflowId: string;
  /** 运行状态 */
  status: "success" | "failed" | "running";
  /** 各节点输出 */
  nodeOutputs: Record<string, NodeRunOutput>;
  /** 总耗时（毫秒） */
  totalDurationMs: number;
  /** 错误信息 */
  error?: string;
  /** 时间戳 */
  timestamp: string;
}

/** 单个节点运行输出 */
export interface NodeRunOutput {
  /** 节点 ID */
  nodeId: string;
  /** 节点类型 */
  nodeType: string;
  /** 运行状态 */
  status: "success" | "failed";
  /** 输出数据 */
  output: unknown;
  /** 耗时（毫秒） */
  durationMs: number;
  /** 错误信息 */
  error?: string;
}

// ============================================
// 兼容别名
// 后续迁移到新类型后删除
// ============================================

/** @deprecated 使用 WorkflowSchema 替代 */
export interface WorkflowDraft {
  name: string;
  description: string;
  nodes: WorkflowDraftNode[];
  edges: Array<{ from: string; to: string }>;
}

/** @deprecated 使用 WorkflowNode 替代 */
export interface WorkflowDraftNode {
  id: string;
  type: "start" | "llm" | "code" | "condition" | "http" | "end";
  label: string;
  description: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
}
