// @coze-workflow/workflow-schema - 节点模板工厂
//
// 设计思想：
// - 每种节点类型提供一个 createXxxNode() 工厂函数
// - 返回带默认字段的节点对象，调用方只需覆盖业务字段
// - 后续 Agent 生成节点时调用这些工厂，保证结构合规

import { generateId } from "@coze-workflow/shared";
import type {
  CozeWorkflow,
  CozeEdge,
  StartNode,
  EndNode,
  LLMNode,
  CodeNode,
  ConditionNode,
  HttpNode,
  DatabaseQueryNode,
  TextNode,
  MergeNode,
} from "../types/index";

// ============================================
// 节点模板工厂
// ============================================

/** 创建开始节点 */
export function createStartNode(
  inputs?: StartNode["inputVariables"],
): StartNode {
  return {
    id: generateId(),
    type: "start",
    title: "开始",
    desc: "接收用户输入，作为工作流的入口",
    inputVariables: inputs ?? [
      { name: "user_input", type: "string", required: true },
    ],
    _temp: {
      bounds: { x: 80, y: 80, width: 160, height: 80 },
      externalData: {},
    },
  };
}

/** 创建结束节点 */
export function createEndNode(outputs?: EndNode["outputVariables"]): EndNode {
  return {
    id: generateId(),
    type: "end",
    title: "结束",
    desc: "返回最终结果",
    outputVariables: outputs ?? [],
    _temp: {
      bounds: { x: 80, y: 260, width: 160, height: 80 },
      externalData: {},
    },
  };
}

/**
 * 创建 LLM 节点
 *
 * 默认模型 Doubao-Seed-2.0-Lite（modelType=201）：模型必须来自
 * docs/coze-platform/platform-facts.md 的 25 个模型列表，
 * 音频/视频任务需选 audio_understanding=true 的模型。
 */
export function createLLMNode(
  overrides: Partial<
    Pick<
      LLMNode,
      "title" | "desc" | "userPrompt" | "systemPrompt" | "config" | "outputs"
    >
  > = {},
): LLMNode {
  return {
    id: generateId(),
    type: "llm",
    title: overrides.title ?? "LLM 处理",
    desc: overrides.desc ?? "调用大模型处理数据",
    config: {
      model: "Doubao-Seed-2.0-Lite",
      temperature: 0.7,
      maxTokens: 2048,
      ...overrides.config,
    },
    userPrompt: overrides.userPrompt ?? "{{input}}",
    systemPrompt: overrides.systemPrompt,
    inputMapping: {},
    // 平台要求 LLM 节点必须有 outputs 声明，缺失导致保存失败
    outputs: overrides.outputs ?? [
      { type: "string", name: "output", schema: {} },
    ],
    _temp: {
      bounds: { x: 360, y: 80, width: 180, height: 90 },
      externalData: {},
    },
  };
}

/** 创建代码节点 */
export function createCodeNode(
  overrides: Partial<
    Pick<CodeNode, "title" | "desc" | "code" | "language" | "outputs">
  > = {},
): CodeNode {
  return {
    id: generateId(),
    type: "code",
    title: overrides.title ?? "代码处理",
    desc: overrides.desc ?? "执行自定义代码逻辑",
    code: overrides.code ?? "// TODO: 填充代码逻辑",
    language: overrides.language ?? "javascript",
    outputs: overrides.outputs ?? [
      { type: "object", name: "output", schema: {} },
    ],
    inputMapping: {},
    _temp: {
      bounds: { x: 360, y: 80, width: 180, height: 90 },
      externalData: {},
    },
  };
}

/** 创建条件分支节点 */
export function createConditionNode(
  overrides: Partial<
    Pick<ConditionNode, "title" | "desc" | "branches" | "defaultBranch">
  > = {},
): ConditionNode {
  return {
    id: generateId(),
    type: "condition",
    title: overrides.title ?? "条件判断",
    desc: overrides.desc ?? "根据条件选择不同分支",
    branches: overrides.branches ?? [
      { expression: "条件 A", targetNodeId: "TODO" },
      { expression: "条件 B", targetNodeId: "TODO" },
    ],
    defaultBranch: overrides.defaultBranch,
    _temp: {
      bounds: { x: 360, y: 80, width: 180, height: 90 },
      externalData: {},
    },
  };
}

/** 创建 HTTP 请求节点 */
export function createHttpNode(
  overrides: Partial<
    Pick<
      HttpNode,
      "title" | "desc" | "method" | "url" | "headers" | "body" | "outputs"
    >
  > = {},
): HttpNode {
  return {
    id: generateId(),
    type: "http",
    title: overrides.title ?? "HTTP 请求",
    desc: overrides.desc ?? "调用外部 API 接口",
    method: overrides.method ?? "GET",
    url: overrides.url ?? "https://api.example.com",
    headers: overrides.headers,
    body: overrides.body,
    inputMapping: {},
    // 平台 HTTP 节点固定输出：body/statusCode/headers（schema-converter 同步）
    outputs: overrides.outputs ?? [
      { type: "string", name: "body" },
      { type: "integer", name: "statusCode" },
      { type: "string", name: "headers" },
    ],
    _temp: {
      bounds: { x: 360, y: 80, width: 180, height: 90 },
      externalData: {},
    },
  };
}

/** 创建数据库查询节点 */
export function createDatabaseQueryNode(
  overrides: Partial<
    Pick<
      DatabaseQueryNode,
      "title" | "desc" | "query" | "connection" | "params"
    >
  > = {},
): DatabaseQueryNode {
  return {
    id: generateId(),
    type: "database_query",
    title: overrides.title ?? "数据库查询",
    desc: overrides.desc ?? "执行数据库查询操作",
    query: overrides.query ?? "SELECT 1",
    connection: overrides.connection ?? "default",
    params: overrides.params ?? [],
    inputMapping: {},
    _temp: {
      bounds: { x: 360, y: 80, width: 180, height: 90 },
      externalData: {},
    },
  };
}

/** 创建文本处理节点（平台 type=15） */
export function createTextNode(
  overrides: Partial<
    Pick<TextNode, "title" | "desc" | "method" | "concatParams">
  > = {},
): TextNode {
  return {
    id: generateId(),
    type: "text",
    title: overrides.title ?? "文本处理",
    desc: overrides.desc ?? "拼接/处理文本内容",
    method: overrides.method ?? "concat",
    concatParams: overrides.concatParams ?? [
      { name: "String1", value: "{{String1}}" },
    ],
    inputMapping: {},
    _temp: {
      bounds: { x: 360, y: 80, width: 180, height: 90 },
      externalData: {},
    },
  };
}

/** 创建变量聚合节点（平台 type=32） */
export function createMergeNode(
  overrides: Partial<Pick<MergeNode, "title" | "desc" | "mergeGroups">> = {},
): MergeNode {
  return {
    id: generateId(),
    type: "merge",
    title: overrides.title ?? "变量聚合",
    desc: overrides.desc ?? "聚合多个分支的输出变量",
    mergeGroups: overrides.mergeGroups ?? [{ name: "Group1", variables: [] }],
    inputMapping: {},
    _temp: {
      bounds: { x: 360, y: 80, width: 180, height: 90 },
      externalData: {},
    },
  };
}

// ============================================
// 预置工作流模板
// ============================================

/**
 * 简单问答模板：
 * 开始 → LLM → 结束
 */
export function createSimpleQATemplate(name: string): CozeWorkflow {
  const startNode = createStartNode();
  const llmNode = createLLMNode({
    title: "LLM 回答",
    userPrompt: "{{user_input}}",
    systemPrompt: "你是一个有用的助手。",
  });
  const endNode = createEndNode([
    { name: "result", type: "string", value: `${llmNode.id}.output` },
  ]);

  const edges: CozeEdge[] = [
    {
      id: generateId(),
      sourceNodeId: startNode.id,
      targetNodeId: llmNode.id,
    },
    {
      id: generateId(),
      sourceNodeId: llmNode.id,
      targetNodeId: endNode.id,
    },
  ];

  return {
    meta: { name, description: "简单问答工作流模板", version: "1.0.0" },
    nodes: [startNode, llmNode, endNode],
    edges,
    _temp: {
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      externalData: {},
    },
  };
}

/**
 * 条件分支模板：
 * 开始 → 条件判断 → [分支 A: LLM, 分支 B: 代码] → 结束
 */
export function createBranchTemplate(name: string): CozeWorkflow {
  const startNode = createStartNode();
  const conditionNode = createConditionNode({
    title: "路由判断",
  });
  const llmNode = createLLMNode({ title: "分支 A - LLM 处理" });
  const codeNode = createCodeNode({ title: "分支 B - 代码处理" });
  const endNode = createEndNode();

  const edges: CozeEdge[] = [
    {
      id: generateId(),
      sourceNodeId: startNode.id,
      targetNodeId: conditionNode.id,
    },
    {
      id: generateId(),
      sourceNodeId: conditionNode.id,
      targetNodeId: llmNode.id,
      sourcePort: "branch_0",
    },
    {
      id: generateId(),
      sourceNodeId: conditionNode.id,
      targetNodeId: codeNode.id,
      sourcePort: "branch_1",
    },
    {
      id: generateId(),
      sourceNodeId: llmNode.id,
      targetNodeId: endNode.id,
    },
    {
      id: generateId(),
      sourceNodeId: codeNode.id,
      targetNodeId: endNode.id,
    },
  ];

  return {
    meta: { name, description: "条件分支工作流模板", version: "1.0.0" },
    nodes: [startNode, conditionNode, llmNode, codeNode, endNode],
    edges,
    _temp: {
      bounds: { x: 0, y: 0, width: 1000, height: 800 },
      externalData: {},
    },
  };
}

// TODO: 后续补充更多模板
// - 数据管道模板（HTTP → 代码 → 数据库 → LLM → 结束）
// - 多 Agent 协作模板
// - RAG 问答模板
