/**
 * ToolCallPanel 组件 —— 右侧工具调用链面板
 *
 * 职责：以时间线形式展示 Agent 的工具调用过程
 * （plan_workflow → generate_workflow → save_to_coze → test_run_workflow）
 *
 * 关键细节：
 * - 状态色：running 蓝色 / done 绿色 / error 红色
 * - tool_end 按 name 匹配最近的 running 记录，更新为 done/error
 */

export interface ToolCallItem {
  /** 渲染 key 用，必须是全局唯一值（随机 UUID），不能用自增序号（HMR/重放会撞 key） */
  id: string;
  name: string;
  status: "running" | "done" | "error";
  time: string;
}

interface Props {
  toolCalls: ToolCallItem[];
}

/** 工具名友好显示映射 */
const TOOL_LABELS: Record<string, string> = {
  clarify_question: "需求澄清",
  plan_workflow: "工作流规划",
  generate_workflow: "工作流生成",
  save_to_coze: "保存到 Coze",
  test_run_workflow: "试运行",
};

export function ToolCallPanel({ toolCalls }: Props) {
  return (
    <div className="tool-call-panel">
      <h2 className="panel-title">工具调用链</h2>

      {toolCalls.length === 0 ? (
        <p className="hint-text">暂无工具调用</p>
      ) : (
        <ol className="tool-timeline">
          {toolCalls.map((call) => (
            <li key={call.id} className="tool-timeline-item">
              <span
                className={`tool-dot tool-dot-${call.status}`}
                title={call.status}
              />
              <div className="tool-timeline-info">
                <span className="tool-timeline-name">
                  {TOOL_LABELS[call.name] ?? call.name}
                  <span className="tool-timeline-raw">({call.name})</span>
                </span>
                <span className="tool-timeline-time">{call.time}</span>
              </div>
              <span className={`tool-state tool-state-${call.status}`}>
                {call.status === "running"
                  ? "运行中"
                  : call.status === "done"
                    ? "✓"
                    : "✗"}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
