/**
 * Header 组件 —— 顶部标题栏
 *
 * 职责：展示项目标题和当前状态
 *
 * TODO: 后续添加状态指示器（如 Agent 运行状态、连接状态）
 */
export function Header() {
  return (
    <header className="header">
      <h1 className="header-title">Coze 工作流自动生成 Agent</h1>
      <div className="header-status">
        <span className="status-dot status-idle" />
        <span className="status-text">就绪</span>
      </div>
    </header>
  );
}
