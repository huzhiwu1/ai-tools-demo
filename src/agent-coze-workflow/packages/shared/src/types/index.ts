// @coze-workflow/shared - 跨模块共享的类型定义

// ============================================
// Agent 状态定义
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
// 工作流生成相关类型
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

/** 工作流草稿（LLM 规划阶段产出） */
export interface WorkflowDraft {
  /** 工作流名称 */
  name: string;
  /** 工作流描述 */
  description: string;
  /** 节点列表 */
  nodes: WorkflowDraftNode[];
  /** 连接关系 */
  edges: Array<{ from: string; to: string }>;
}

/** 工作流草稿节点 */
export interface WorkflowDraftNode {
  /** 节点 ID */
  id: string;
  /** 节点类型 */
  type: "start" | "llm" | "code" | "condition" | "http" | "end";
  /** 节点名称 */
  label: string;
  /** 节点描述 */
  description: string;
  /** 输入参数 */
  inputs?: Record<string, unknown>;
  /** 输出参数 */
  outputs?: Record<string, unknown>;
}
