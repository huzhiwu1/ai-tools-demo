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
 * - 与 WorkflowDraft（LLM 规划阶段产出）不同，这是最终可执行的结构
 */
export interface CozeWorkflow {
  /** 工作流基本信息 */
  meta: WorkflowMeta;
  /** 节点列表 */
  nodes: CozeNode[];
  /** 连线列表 */
  edges: CozeEdge[];
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
 *
 * 关键细节：
 * - id 在工作流内唯一，用于 edges 引用
 * - type 决定了该节点的具体配置结构
 * - position 仅用于前端画布展示，不影响执行逻辑
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
  /** 模型配置 */
  config: {
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
