/**
 * RunLogPanel 组件 —— 右侧执行日志面板
 *
 * 职责：展示 Agent 执行步骤和运行状态
 *
 * TODO: 后续接入 Agent 实时状态流（SSE / WebSocket）
 */

interface LogEntry {
  time: string;
  level: string;
  msg: string;
}

interface Props {
  logs: LogEntry[];
}

export function RunLogPanel({ logs }: Props) {
  return (
    <div className="run-log-panel">
      <h2 className="panel-title">执行日志</h2>
      <div className="log-content">
        {logs.length === 0 ? (
          <div className="log-entry log-info">
            <span className="log-time">--:--:--</span>
            <span className="log-msg">等待生成...</span>
          </div>
        ) : (
          logs.map((log, i) => (
            <div key={i} className={`log-entry log-${log.level}`}>
              <span className="log-time">{log.time}</span>
              <span className="log-msg">{log.msg}</span>
            </div>
          ))
        )}
      </div>
      <p className="hint-text">TODO: 后续展示 Agent 实时执行步骤</p>
    </div>
  );
}
