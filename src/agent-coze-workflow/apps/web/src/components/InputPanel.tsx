/**
 * InputPanel 组件 —— 左侧输入面板
 *
 * 职责：接收用户自然语言需求输入
 *
 * TODO: 后续接入后端 API，提交需求并触发工作流生成
 */
export function InputPanel() {
  return (
    <div className="input-panel">
      <h2 className="panel-title">需求输入</h2>
      <textarea
        className="input-textarea"
        placeholder="请用自然语言描述你的工作流需求...&#10;&#10;例如：&#10;我需要一个工作流，先接收用户问题，然后调用 GPT-4 分析问题，最后根据分析结果给出建议。"
        rows={10}
      />
      <button className="btn btn-primary" disabled>
        生成工作流
      </button>
      <p className="hint-text">TODO: 后续接入 LLM 规划和工作流生成</p>
    </div>
  );
}
