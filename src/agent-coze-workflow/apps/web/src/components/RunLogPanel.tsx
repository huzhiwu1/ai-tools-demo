/**
 * RunLogPanel 组件 —— 右侧执行日志面板
 *
 * 职责：展示 Agent 执行日志、步骤记录、状态面板
 *
 * TODO: 后续接入 Agent 实时状态流
 */
export function RunLogPanel() {
  return (
    <div className="run-log-panel">
      <h2 className="panel-title">执行日志</h2>
      <div className="log-content">
        <div className="log-entry log-info">
          <span className="log-time">--:--:--</span>
          <span className="log-msg">等待用户输入需求...</span>
        </div>
      </div>
      <p className="hint-text">TODO: 后续展示 Agent 执行步骤和状态</p>
    </div>
  );
}
