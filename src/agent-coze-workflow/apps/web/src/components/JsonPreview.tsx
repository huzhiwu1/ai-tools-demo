/**
 * JsonPreview 组件 —— 右侧 JSON 输出预览
 *
 * 职责：展示生成的工作流 JSON 结构
 *
 * TODO: 后续接入真实生成数据，支持语法高亮
 */

const MOCK_WORKFLOW_JSON = `{
  "meta": {
    "name": "示例工作流",
    "description": "简单的 QA 问答工作流",
    "version": "1.0.0"
  },
  "nodes": [
    {
      "id": "start",
      "type": "start",
      "title": "开始",
      "desc": "接收用户输入",
      "inputVariables": [
        { "name": "user_input", "type": "string" }
      ]
    },
    {
      "id": "llm_1",
      "type": "llm",
      "title": "LLM 处理",
      "desc": "调用大模型处理用户输入",
      "config": {
        "model": "gpt-4o",
        "temperature": 0.7,
        "maxTokens": 2048
      },
      "userPrompt": "{{user_input}}",
      "systemPrompt": "你是一个有用的助手"
    },
    {
      "id": "end",
      "type": "end",
      "title": "结束",
      "desc": "返回结果",
      "outputVariables": [
        { "name": "result", "type": "string" }
      ]
    }
  ],
  "edges": [
    { "id": "e_1", "sourceNodeId": "start", "targetNodeId": "llm_1" },
    { "id": "e_2", "sourceNodeId": "llm_1", "targetNodeId": "end" }
  ]
}`;

export function JsonPreview() {
  return (
    <div className="json-preview">
      <h2 className="panel-title">JSON 输出</h2>
      <pre className="json-content">
        <code>{MOCK_WORKFLOW_JSON}</code>
      </pre>
      <p className="hint-text">TODO: 后续展示真实生成的工作流 JSON</p>
    </div>
  );
}
