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
import { useState } from "react";

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
  // step → 段文本内容（reasoning_delta 在 App 里按 step 累积，
  // 段锚点消息只存 step 号，渲染时从这里取完整文本）
  stepContents: Record<number, string>;
  // 正在流式打字的 step（null = 当前无打字段）
  streamingStep: number | null;
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

/**
 * 过程气泡（单个 step 的 LLM 叙述段）
 *
 * 流式累积打字；流结束后可点击头部折叠/展开（默认展开）。
 * 最终回复段由 final_answer 事件升级为正文气泡，不经过本组件。
 */
function ThinkingBubble({
  content,
  isStreaming,
}: {
  content: string;
  isStreaming: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  // 流式中的段强制展开（打字过程必须可见），结束后才允许折叠
  const effectiveCollapsed = collapsed && !isStreaming;

  return (
    <div className="msg-row msg-ai">
      <div className="msg-bubble thinking-bubble">
        <div className="msg-avatar">AI</div>
        <div className="msg-content">
          <button
            type="button"
            className="thinking-toggle"
            onClick={() => setCollapsed((c) => !c)}
            title={effectiveCollapsed ? "展开过程" : "折叠过程"}
            disabled={isStreaming}
          >
            <span className="thinking-label">
              {isStreaming ? "🧠 处理中" : "🧠 过程"}
            </span>
            <span className="thinking-toggle-icon">
              {effectiveCollapsed ? "▸" : "▾"}
            </span>
          </button>
          {effectiveCollapsed ? (
            <span className="thinking-collapsed-hint">
              已折叠（{content.length} 字）
            </span>
          ) : (
            <>
              <div className="thinking-content">{content}</div>
              {isStreaming && <span className="cursor-blink" />}
            </>
          )}
        </div>
      </div>
    </div>
  );
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
  stepContents,
  streamingStep,
}: Props) {
  return (
    <div className="chat-messages">
      {messages.map((msg, index) => {
        // data 消息：渲染段气泡（step_text_start/final_answer）或工具卡片
        if (msg.role === "data") {
          const event = msg.data as DataStreamEvent | undefined;
          // 段开始锚点：过程气泡（流式打字，结束后可折叠）；
          // content 优先取锚点固化值（打断/新一轮时 stepContents 已清空），
          // 流式期间锚点无 content，回退到 stepContents 累积值
          if (event?.type === "step_text_start") {
            const step = event.step ?? 0;
            return (
              <ThinkingBubble
                key={msg.id}
                content={event.content || (stepContents[step] ?? "")}
                isStreaming={streamingStep === step}
              />
            );
          }
          // 最终回复锚点：升级为正式正文气泡（内容取该 step 累积文本）
          if (event?.type === "final_answer") {
            const step = event.step ?? 0;
            return (
              <div key={msg.id} className="msg-row msg-ai">
                <div className="msg-bubble">
                  <div className="msg-avatar">AI</div>
                  <div className="msg-content">
                    {event.content || (stepContents[step] ?? "")}
                  </div>
                </div>
              </div>
            );
          }
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

        // 跳过空正文气泡：后端不再发 0: 文本（打字效果由过程气泡承担），
        // useChat 内部仍会留一条空 assistant 占位消息，始终不渲染
        if (msg.role === "assistant" && msg.content === "") {
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

      {/* LLM 处理中：无流式文本/段气泡/工具卡片/提问卡片时显示 */}
      {isLoading &&
        !pendingQuestion &&
        !(messages[messages.length - 1]?.role === "data") &&
        !(
          messages[messages.length - 1]?.role === "assistant" &&
          messages[messages.length - 1]?.content !== ""
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
                <span className="thinking-text">处理中</span>
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
