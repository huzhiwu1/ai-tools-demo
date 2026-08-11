// @coze-workflow/workflow-schema - 预置工作流模板

import type {
  CozeWorkflow,
  StartNode,
  LLMNode,
  EndNode,
  CozeEdge,
} from "../types/index";

// ============================================
// 预置工作流模板
//
// 设计思想：
// - 模板是常见工作流模式的"骨架"
// - LLM 生成工作流时，可以先选择模板，再填充细节
// - 模板减少 LLM 幻觉，保证输出结构正确
// ============================================

/**
 * 简单问答模板：
 * 开始 → LLM → 结束
 */
export function createSimpleQATemplate(name: string): CozeWorkflow {
  const startNode: StartNode = {
    id: "start",
    type: "start",
    title: "开始",
    desc: "接收用户输入",
    inputVariables: [{ name: "user_input", type: "string", required: true }],
  };

  const llmNode: LLMNode = {
    id: "llm_1",
    type: "llm",
    title: "LLM 处理",
    desc: "调用大模型处理用户输入",
    config: { model: "gpt-4o", temperature: 0.7 },
    userPrompt: "{{user_input}}",
    systemPrompt: "你是一个有用的助手。",
    inputMapping: { user_input: "start.user_input" },
  };

  const endNode: EndNode = {
    id: "end",
    type: "end",
    title: "结束",
    desc: "返回结果",
    outputVariables: [
      { name: "result", type: "string", value: "llm_1.output" },
    ],
  };

  const edges: CozeEdge[] = [
    { id: "e_start_llm", sourceNodeId: "start", targetNodeId: "llm_1" },
    { id: "e_llm_end", sourceNodeId: "llm_1", targetNodeId: "end" },
  ];

  return {
    meta: { name, description: "简单问答模板", version: "1.0.0" },
    nodes: [startNode, llmNode, endNode],
    edges,
  };
}

// TODO: 后续补充更多模板
// - 多轮对话模板
// - 条件分支模板
// - 多 Agent 协作模板
// - 数据管道模板
