/**
 * RunLogPanel 组件 —— 右侧执行日志面板
 *
 * 职责：展示 Agent 执行步骤和运行状态
 *
 * TODO: 后续接入 Agent 实时状态流（SSE / WebSocket）
 */

const MOCK_LOGS = [
  {
    time: "12:00:01",
    level: "info",
    msg: '收到用户需求："简单的问答工作流"',
  },
  {
    time: "12:00:02",
    level: "info",
    msg: "WorkflowPlanner: 规划完成，共 3 个步骤",
  },
  { time: "12:00:03", level: "info", msg: "步骤 1/3: 创建开始节点" },
  { time: "12:00:03", level: "info", msg: "步骤 2/3: 创建 LLM 节点" },
  { time: "12:00:04", level: "info", msg: "步骤 3/3: 创建结束节点" },
  {
    time: "12:00:05",
    level: "success",
    msg: "WorkflowGenerator: 生成完成，共 3 个节点、2 条连线",
  },
  {
    time: "12:00:05",
    level: "info",
    msg: "本地校验: 通过（2 条警告: MISSING_TEMP, CODE_NODE_SOURCE_PORT）",
  },
  {
    time: "12:00:06",
    level: "info",
    msg: "工作流已就绪，等待用户确认或修改",
  },
];

export function RunLogPanel() {
  return (
    <div className="run-log-panel">
      <h2 className="panel-title">执行日志</h2>
      <div className="log-content">
        {MOCK_LOGS.map((log, i) => (
          <div key={i} className={`log-entry log-${log.level}`}>
            <span className="log-time">{log.time}</span>
            <span className="log-msg">{log.msg}</span>
          </div>
        ))}
      </div>
      <p className="hint-text">TODO: 后续展示 Agent 实时执行步骤</p>
    </div>
  );
}
