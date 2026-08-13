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

import { isToolOutputFailed } from "../api/data-stream.js";
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

/** 工具名 → 中文显示名（让用户看懂 AI 正在做什么） */
const TOOL_LABELS: Record<string, string> = {
  clarify_question: "询问补充信息",
  read_file: "读取文件",
  plan_workflow: "规划工作流",
  generate_workflow: "生成工作流",
  save_to_coze: "保存到平台",
  test_run_workflow: "试运行工作流",
  batch_validate: "批量验证",
  update_workflow: "更新工作流",
  rename_workflow: "重命名工作流",
};

/** 工具名 → 中文显示名（未知工具回退原名） */
function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

/** 工具卡片：按 data 事件类型渲染 */
function ToolCard({ event }: { event: DataStreamEvent }) {
  if (event.type === "tool_start") {
    return (
      <div className="msg-tool-card tool-running">
        <span className="tool-icon">🔧</span>
        <span className="tool-name">{toolLabel(event.name ?? "unknown")}</span>
        <span className="tool-status">运行中…</span>
      </div>
    );
  }
  if (event.type === "tool_end") {
    const failed = isToolOutputFailed(event.output);
    const outputText =
      typeof event.output === "string"
        ? event.output
        : String(event.output ?? "");
    return (
      <div className={`msg-tool-card ${failed ? "tool-failed" : "tool-done"}`}>
        <span className="tool-icon">{failed ? "⚠️" : "✓"}</span>
        <span className="tool-name">{toolLabel(event.name ?? "unknown")}</span>
        <span className="tool-status">{failed ? "失败" : "完成"}</span>
        {/* 失败时直接展示错误内容（不再只放在 title 悬停里） */}
        {failed && outputText && (
          <div className="tool-error-detail">{outputText}</div>
        )}
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

        // 固化的提问卡片：AI 咨询过的问题（回答后仍保留在消息流）
        const msgData = msg.data as
          | {
              type?: string;
              question?: string;
              context?: string;
              content?: string;
            }
          | undefined;
        if (msgData?.type === "question") {
          return (
            <div key={msg.id} className="msg-row msg-ai">
              <div className="question-card">
                <div className="question-card-header">
                  <span className="question-icon">🤔</span>
                  <span>AI 需要确认</span>
                </div>
                <p className="question-text">{msgData.question}</p>
                {msgData.context && (
                  <p className="question-context">{msgData.context}</p>
                )}
              </div>
            </div>
          );
        }

        // 固化的思考段落：LLM 的推理过程（遇到什么问题、为什么这么做、准备怎么处理）
        // 流式累积，工具调用/正式输出时封存，保留在消息流里可回看
        if (msgData?.type === "reasoning") {
          const isStreamingReasoning =
            index === messages.length - 1 && isLoading;
          return (
            <div key={msg.id} className="msg-row msg-ai">
              <div className="msg-bubble thinking-bubble">
                <div className="msg-avatar">AI</div>
                <div className="msg-content">
                  <div className="thinking-label">🧠 思考中</div>
                  <div className="thinking-content">
                    {msgData.content ?? ""}
                  </div>
                  {isStreamingReasoning && <span className="cursor-blink" />}
                </div>
              </div>
            </div>
          );
        }

        const isLast = index === messages.length - 1;
        const streaming = isLast && msg.role === "assistant" && isLoading;

        // 跳过空气泡：非最后一条且内容为空的 assistant 消息
        if (msg.role === "assistant" && msg.content === "" && !streaming) {
          return null;
        }

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

      {/* LLM 思考中：没有流式文本、没有 reasoning 段落、没有提问卡片时显示 */}
      {isLoading &&
        !pendingQuestion &&
        !messages.some(
          (m) =>
            m.role === "assistant" &&
            m.content !== "" &&
            m.id === messages[messages.length - 1]?.id,
        ) &&
        !messages.some(
          (m) =>
            (m.data as { type?: string } | undefined)?.type === "reasoning" &&
            m.id === messages[messages.length - 1]?.id,
        ) && (
          <div className="msg-row msg-ai">
            <div className="msg-bubble thinking-bubble">
              <div className="msg-avatar">AI</div>
              <div className="msg-content">
                <span className="thinking-dots">
                  <span className="dot" />
                  <span className="dot" />
                  <span className="dot" />
                </span>
                <span className="thinking-text">思考中</span>
              </div>
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
