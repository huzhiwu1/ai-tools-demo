/**
 * ChatMessageList 组件 —— 对话消息列表
 *
 * 职责：渲染消息气泡（用户/AI）、工具调用卡片、AI 提问卡片（插槽）
 *
 * 关键细节：
 * - AI 消息流式打字：最后一条 assistant 消息在 isLoading 时显示光标
 * - role:"data" 消息按 data.type 渲染对应卡片（tool_start/tool_end/error）
 * - 提问卡片通过 pendingQuestion prop 渲染在列表末尾
 */

import type { DataStreamEvent } from "../api/data-stream.js";

/** useChat messages 的消息类型（宽松定义，兼容 role:"data" 消息） */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "data" | "system";
  content: string;
  data?: unknown;
}

interface Props {
  messages: ChatMessage[];
  isLoading: boolean;
  pendingQuestion: { question: string; context?: string } | null;
}

/** 工具卡片：按 data 事件类型渲染 */
function ToolCard({ event }: { event: DataStreamEvent }) {
  if (event.type === "tool_start") {
    return (
      <div className="msg-tool-card tool-running">
        <span className="tool-icon">🔧</span>
        <span className="tool-name">{event.name ?? "unknown"}</span>
        <span className="tool-status">运行中…</span>
      </div>
    );
  }
  if (event.type === "tool_end") {
    const failed = (event.output ?? "").includes("失败");
    return (
      <div
        className={`msg-tool-card ${failed ? "tool-failed" : "tool-done"}`}
        title={event.output}
      >
        <span className="tool-icon">{failed ? "⚠️" : "✓"}</span>
        <span className="tool-name">{event.name ?? "unknown"}</span>
        <span className="tool-status">{failed ? "失败" : "完成"}</span>
      </div>
    );
  }
  if (event.type === "error") {
    return (
      <div className="msg-tool-card tool-failed">
        <span className="tool-icon">❌</span>
        <span className="tool-name">{event.message ?? "错误"}</span>
      </div>
    );
  }
  return null;
}

export function ChatMessageList({
  messages,
  isLoading,
  pendingQuestion,
}: Props) {
  return (
    <div className="chat-messages">
      {messages.map((msg, index) => {
        // data 消息：渲染工具卡片（session/done/interrupt 事件不渲染）
        if (msg.role === "data") {
          const event = msg.data as DataStreamEvent | undefined;
          if (
            event &&
            (event.type === "tool_start" ||
              event.type === "tool_end" ||
              event.type === "error")
          ) {
            return <ToolCard key={msg.id} event={event} />;
          }
          return null;
        }

        const isLast = index === messages.length - 1;
        const streaming = isLast && msg.role === "assistant" && isLoading;

        return (
          <div
            key={msg.id}
            className={`msg-row ${msg.role === "user" ? "msg-user" : "msg-ai"}`}
          >
            <div className="msg-bubble">
              {msg.role === "assistant" && (
                <div className="msg-avatar">AI</div>
              )}
              <div className="msg-content">
                {msg.content}
                {streaming && <span className="cursor-blink" />}
              </div>
            </div>
          </div>
        );
      })}

      {/* AI 提问卡片：渲染在消息流末尾 */}
      {pendingQuestion && (
        <div className="msg-row msg-ai">
          <div className="question-card">
            <div className="question-card-header">
              <span className="question-icon">🤔</span>
              <span>AI 需要确认</span>
            </div>
            <p className="question-text">{pendingQuestion.question}</p>
            {pendingQuestion.context && (
              <p className="question-context">{pendingQuestion.context}</p>
            )}
            <p className="question-hint">请在下方输入框回复 AI 的问题</p>
          </div>
        </div>
      )}

      {messages.length === 0 && !pendingQuestion && (
        <div className="chat-empty">
          <span className="empty-icon">💬</span>
          <p>描述你的工作流需求，例如：</p>
          <p className="empty-example">
            "帮我做一个输入问题、由大模型直接回答的问答工作流"
          </p>
        </div>
      )}
    </div>
  );
}
