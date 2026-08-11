/**
 * JsonPreview 组件 —— 右侧 JSON 输出预览
 *
 * 职责：展示生成的 Coze 工作流 JSON
 *
 * TODO: 后续接入真实数据，支持语法高亮和格式化
 */
export function JsonPreview() {
  return (
    <div className="json-preview">
      <h2 className="panel-title">JSON 输出</h2>
      <pre className="json-content">
        <code>{`{
  "meta": {
    "name": "示例工作流",
    "description": "这是一个示例",
    "version": "1.0.0"
  },
  "nodes": [...],
  "edges": [...]
}`}</code>
      </pre>
      <p className="hint-text">TODO: 后续展示真实生成的 Coze 工作流 JSON</p>
    </div>
  );
}
