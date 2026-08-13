// @coze-workflow/workflow-schema - Coze 工作流节点类型定义

import { NODE_TYPES } from "@coze-workflow/shared";

// ============================================
// Coze 工作流 JSON 结构定义
// （对应 Coze 平台工作流导出格式）
// ============================================

/**
 * Coze 工作流完整定义
 *
 * 设计说明：
 * - 这个结构对应 Coze 平台的工作流 JSON 导出格式
 * - 后续生成 Coze 工作流节点 JSON 时，以此为输出目标
 * - 与 WorkflowSketch（LLM 规划阶段产出）不同，这是最终可执行的结构
 */
export interface CozeWorkflow {
  /** 工作流基本信息 */
  meta: WorkflowMeta;
  /** 节点列表 */
  nodes: CozeNode[];
  /** 连线列表 */
  edges: CozeEdge[];
  /** Coze 兼容元信息 */
  _temp?: {
    bounds?: { x: number; y: number; width: number; height: number };
    externalData?: Record<string, unknown>;
  };
}

/** 工作流元信息 */
export interface WorkflowMeta {
  /** 工作流唯一标识（创建时由 Coze 分配） */
  id?: string;
  /** 工作流名称 */
  name: string;
  /** 工作流描述 */
  description: string;
  /** 版本号 */
  version: string;
  /** 工作空间 ID */
  workspaceId?: string;
}

/**
 * 基础节点 —— 所有 Coze 节点的通用字段
 */
export interface CozeNodeBase {
  /** 节点唯一 ID */
  id: string;
  /** 节点类型 */
  type: (typeof NODE_TYPES)[number];
  /** 节点名称（展示用） */
  title: string;
  /** 节点描述 */
  desc?: string;
  /** 画布位置（前端展示用） */
  position?: { x: number; y: number };
  /** Coze 兼容元信息 */
  _temp?: {
    bounds?: { x: number; y: number; width: number; height: number };
    externalData?: Record<string, unknown>;
  };
}

/** 开始节点 */
export interface StartNode extends CozeNodeBase {
  type: "start";
  /** 输入变量定义 */
  inputVariables?: Array<{
    name: string;
    type: string;
    required: boolean;
    default?: string;
  }>;
}

/** LLM 节点 */
export interface LLMNode extends CozeNodeBase {
  type: "llm";
  /**
   * 模型配置
   *
   * model 必须来自 docs/coze-platform/platform-facts.md 的 25 个模型列表
   * （音频/视频任务选 audio_understanding=true 的），
   * 默认 Doubao-Seed-2.0-Lite（modelType=201）。
   */
  config: {
    /** 模型名（platform-facts.md models 列表，禁止 gpt-4o 等平台不存在模型） */
    model: string;
    temperature?: number;
    maxTokens?: number;
  };
  /** 用户提示词 */
  userPrompt: string;
  /** 系统提示词 */
  systemPrompt?: string;
  /** 输入变量映射 */
  inputMapping?: Record<string, string>;
  /**
   * 输出变量声明（平台要求，缺失会导致保存失败/SetOutputTypesForNodeSchema panic）
   * 每个元素声明一个输出字段的名称与类型。
   */
  outputs?: Array<{
    type: "string" | "object" | "list" | "integer" | "number" | "boolean";
    name: string;
    schema?: unknown;
  }>;
}

/** 代码节点 */
export interface CodeNode extends CozeNodeBase {
  type: "code";
  /** 代码内容 */
  code: string;
  /** 运行时语言 */
  language: "javascript" | "python";
  /** 输入变量映射 */
  inputMapping?: Record<string, string>;
  /**
   * 输出变量声明（平台要求，缺失会导致 SetOutputTypesForNodeSchema panic）
   * 每个元素声明一个输出字段的名称与类型。
   */
  outputs?: Array<{
    type: "string" | "object" | "list" | "integer" | "number" | "boolean";
    name: string;
    schema?: unknown;
  }>;
}

/** 条件判断节点 */
export interface ConditionNode extends CozeNodeBase {
  type: "condition";
  /** 条件分支列表 */
  branches: Array<{
    /** 条件表达式 */
    expression: string;
    /** 满足条件时跳转的节点 ID */
    targetNodeId: string;
  }>;
  /** 默认分支 */
  defaultBranch?: string;
}

/** HTTP 请求节点 */
export interface HttpNode extends CozeNodeBase {
  type: "http";
  /** 请求方法 */
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** 请求 URL */
  url: string;
  /** 请求头 */
  headers?: Record<string, string>;
  /** 请求体 */
  body?: Record<string, unknown>;
  /** 输入变量映射 */
  inputMapping?: Record<string, string>;
}

/** 数据库查询节点 */
export interface DatabaseQueryNode extends CozeNodeBase {
  type: "database_query";
  /** SQL 查询语句 */
  query: string;
  /** 数据库连接标识 */
  connection: string;
  /** 查询参数 */
  params?: Array<string | number>;
  /** 输入变量映射 */
  inputMapping?: Record<string, string>;
}

/** 文本处理节点（平台 type=15，concat 拼接等） */
export interface TextNode extends CozeNodeBase {
  type: "text";
  /** 处理方法：concat 拼接等 */
  method: "concat";
  /** 拼接参数（模板语法 {{String1}} 引用 inputParameters） */
  concatParams?: Array<{
    name: string;
    value: string;
  }>;
  /** 输入变量映射 */
  inputMapping?: Record<string, string>;
}

/** 变量聚合节点（平台 type=32，多分支输出聚合） */
export interface MergeNode extends CozeNodeBase {
  type: "merge";
  /** 聚合分组：group name → 上游变量引用 */
  mergeGroups?: Array<{
    name: string;
    variables: string[];
  }>;
  /** 输入变量映射 */
  inputMapping?: Record<string, string>;
}

/** 结束节点 */
export interface EndNode extends CozeNodeBase {
  type: "end";
  /** 输出变量定义 */
  outputVariables?: Array<{
    name: string;
    type: string;
    value: string;
  }>;
}

/** Coze 节点联合类型 */
export type CozeNode =
  | StartNode
  | LLMNode
  | CodeNode
  | ConditionNode
  | HttpNode
  | DatabaseQueryNode
  | TextNode
  | MergeNode
  | EndNode;

/** 工作流连线 */
export interface CozeEdge {
  /** 连线 ID */
  id: string;
  /** 源节点 ID */
  sourceNodeId: string;
  /** 目标节点 ID */
  targetNodeId: string;
  /** 源节点输出端口（条件节点用） */
  sourcePort?: string;
}
