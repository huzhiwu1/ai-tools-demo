/**
 * Header 组件 —— 顶部标题栏
 *
 * 职责：展示项目标题和当前状态
 */
interface Props {
  /** Agent 运行状态：running 运行中 / idle 就绪 */
  status?: "idle" | "running";
}

export function Header({ status = "idle" }: Props) {
  return (
    <header className="header">
      <h1 className="header-title">Coze 工作流自动生成 Agent</h1>
      <div className="header-status">
        <span className={`status-dot status-${status}`} />
        <span className="status-text">
          {status === "running" ? "运行中" : "就绪"}
        </span>
      </div>
    </header>
  );
}
