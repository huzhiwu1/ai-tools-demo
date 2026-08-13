/**
 * App 根组件 —— 类 ChatGPT 对话界面
 *
 * 职责：
 * - 使用 useChat（Vercel AI SDK）实现流式对话
 * - 处理 data 事件（session/tool_start/tool_end/interrupt/done/error）
 * - AI 提问（interrupt）时渲染提问卡片，回答后调用 resume 接口继续
 * - 右侧面板展示：工具调用链 / 工作流草图 / JSON 输出 / 校验结果 / 保存按钮
 *
 * 关键细节：
 * - 后端输出自定义 Data Stream（0:/d:/e:），useChat 自定义 fetch 适配为
 *   AI SDK 标准协议（0:/2:[...]/3:），d: 事件进入 data 数组
 * - 请求体通过 experimental_prepareRequestBody 改写为后端期望的
 *   { sessionId, message } 格式（useChat 默认发 messages 数组）
 * - resume 走手写 fetch + parseDataStream（方案 A），流式追加 AI 回复
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import type {
  WorkflowPlan,
  WorkflowSketch,
  ValidationResult,
} from "@coze-workflow/shared";
import { Header } from "./components/Header.js";
import { ChatMessageList } from "./components/chat-message-list.js";
import type { ChatMessage } from "./components/chat-message-list.js";
import { ChatInput } from "./components/chat-input.js";
import { ToolCallPanel } from "./components/tool-call-panel.js";
import type { ToolCallItem } from "./components/tool-call-panel.js";
import { WorkflowCanvas } from "./components/WorkflowCanvas.js";
import { JsonPreview } from "./components/JsonPreview.js";
import {
  parseDataStream,
  transformToDataProtocolStream,
} from "./api/data-stream.js";
import type { DataStreamEvent } from "./api/data-stream.js";
import { workflowApi } from "./api/workflow.js";
import type { CozeWorkflow, CozeSaveResult } from "./api/workflow.js";

/** AI 提问内容（来自 interrupt 事件） */
interface PendingQuestion {
  question: string;
  context?: string;
}

/**
 * 把 WorkflowPlan 映射为 WorkflowSketch 形态（供 WorkflowCanvas 展示）
 *
 * Agent 的 plan_workflow 产出 WorkflowPlan（步骤列表），旧 UI 的草图组件
 * 期望 WorkflowSketch（节点列表），此处做结构映射以复用展示逻辑。
 */
function planToSketch(plan: WorkflowPlan): WorkflowSketch {
  return {
    name: plan.name,
    description: plan.description,
    nodes: plan.steps.map((s) => ({
      id: `step-${s.order}`,
      type: s.nodeType,
      label: s.nodeType,
      purpose: s.description,
    })),
    edges: plan.steps.flatMap((s) =>
      s.dependencies.map((dep) => ({
        from: `step-${dep}`,
        to: `step-${s.order}`,
      })),
    ),
  };
}

/**
 * 解析 generate_workflow 工具输出（JSON 文本），提取 workflow 与校验结果
 */
function parseGenerateOutput(output: string): {
  workflow: CozeWorkflow | null;
  validation: ValidationResult | null;
} {
  try {
    const parsed = JSON.parse(output) as {
      workflow?: CozeWorkflow;
      validation?: ValidationResult;
    };
    return {
      workflow: parsed.workflow ?? null,
      validation: parsed.validation ?? null,
    };
  } catch {
    return { workflow: null, validation: null };
  }
}

/** 当前时间 HH:MM:SS（工具链时间戳） */
function nowTime(): string {
  return new Date().toTimeString().slice(0, 8);
}

export default function App() {
  // 会话 ID：首次 d:session 事件返回后写入，后续请求携带实现多轮记忆
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);

  // ============================================
  // useChat 集成
  // ============================================
  const {
    messages,
    input,
    setInput,
    data,
    setData,
    append,
    setMessages,
    isLoading,
  } = useChat({
    api: "/api/agent/chat",
    body: { sessionId },
    // 后端期望 { sessionId, message }，useChat 默认发 { messages: [...] }，
    // 这里改写请求体：取最后一条 user 消息作为 message
    experimental_prepareRequestBody: useCallback(
      ({
        messages: msgs,
      }: {
        messages: Array<{ role: string; content: unknown }>;
      }) => {
        const lastUser = [...msgs]
          .reverse()
          .find((m) => m.role === "user");
        return {
          // JSONValue 不允许 undefined，无会话时用 null 占位
          sessionId: sessionId ?? null,
          message:
            lastUser && typeof lastUser.content === "string"
              ? lastUser.content
              : "",
        };
      },
      [sessionId],
    ),
    // 自定义 fetch：把后端 Data Stream（0:/d:/e:）适配为 AI SDK 标准协议
    fetch: useCallback(
      async (url: RequestInfo | URL, options?: RequestInit) => {
        const upstream = await globalThis.fetch(url, options);
        if (!upstream.ok || !upstream.body) return upstream;
        return new Response(transformToDataProtocolStream(upstream.body), {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: upstream.headers,
        });
      },
      [],
    ),
  });

  // ============================================
  // 本地状态
  // ============================================
  const [pendingQuestion, setPendingQuestion] =
    useState<PendingQuestion | null>(null);
  /** 是否处于回复 AI 问题模式（底部输入框切换为回复模式） */
  const [replyMode, setReplyMode] = useState(false);
  const [toolCalls, setToolCalls] = useState<ToolCallItem[]>([]);
  const [workflow, setWorkflow] = useState<CozeWorkflow | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [sketch, setSketch] = useState<WorkflowSketch | null>(null);
  const [savedResult, setSavedResult] = useState<CozeSaveResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);

  // 工具调用序号（tool_start 时递增）与 data 数组已处理位置
  const toolIdRef = useRef(0);
  const processedDataCount = useRef(0);

  const busy = isLoading || resuming;

  // ============================================
  // data 事件处理
  // ============================================

  /**
   * 处理单个 d: 事件（session/tool_start/tool_end/interrupt/done/error）
   *
   * 使用函数式 setState，回调内无外部依赖。
   */
  const handleDataEvent = useCallback((event: DataStreamEvent) => {
    switch (event.type) {
      case "session": {
        if (typeof event.sessionId === "string") {
          setSessionId(event.sessionId);
        }
        break;
      }

      case "tool_start": {
        const name = event.name ?? "unknown";
        toolIdRef.current += 1;
        setToolCalls((prev) => [
          ...prev,
          { id: toolIdRef.current, name, status: "running", time: nowTime() },
        ]);
        break;
      }

      case "tool_end": {
        const name = event.name ?? "unknown";
        const output = event.output ?? "";
        // 输出包含"失败"视为错误（与后端工具的失败文案约定一致）
        const failed = output.includes("失败");
        setToolCalls((prev) => {
          // 从后往前匹配最近的同名 running 记录
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].name === name && prev[i].status === "running") {
              return prev.map((t, idx) =>
                idx === i
                  ? { ...t, status: failed ? "error" : "done" }
                  : t,
              );
            }
          }
          return prev;
        });

        // generate_workflow 输出 → 工作流 JSON / 校验结果（右侧面板）
        if (name === "generate_workflow") {
          const parsed = parseGenerateOutput(output);
          if (parsed.workflow) setWorkflow(parsed.workflow);
          if (parsed.validation) setValidation(parsed.validation);
        }

        // plan_workflow 输出 → 工作流草图（右侧面板）
        if (name === "plan_workflow") {
          try {
            const plan = JSON.parse(output) as WorkflowPlan;
            if (plan && Array.isArray(plan.steps)) {
              setSketch(planToSketch(plan));
            }
          } catch {
            // 解析失败忽略（非关键路径）
          }
        }
        break;
      }

      case "interrupt": {
        setPendingQuestion({
          question: event.question ?? "请补充信息",
          context: event.context,
        });
        // 底部输入框切换为回复模式
        setReplyMode(true);
        break;
      }

      case "done": {
        // final 文本已通过 0: 流式展示，此处无需重复追加
        break;
      }

      case "error": {
        setGlobalError(event.message ?? "发生错误");
        break;
      }
    }
  }, []);

  // data 数组变化时增量处理新事件（避免重复处理已消费的事件）
  useEffect(() => {
    const events = data ?? [];
    if (events.length <= processedDataCount.current) return;

    const fresh = events.slice(processedDataCount.current);
    processedDataCount.current = events.length;

    for (const item of fresh) {
      if (item && typeof item === "object") {
        handleDataEvent(item as unknown as DataStreamEvent);
      }
    }
  }, [data, handleDataEvent]);

  // ============================================
  // 发送消息
  // ============================================

  /** 发送用户消息（文本已含文件引用），清空上一轮状态 */
  function handleSend(text: string) {
    setInput("");
    setGlobalError(null);
    setPendingQuestion(null);
    setReplyMode(false);
    setWorkflow(null);
    setValidation(null);
    setSketch(null);
    setSavedResult(null);
    setToolCalls([]);
    processedDataCount.current = 0;
    setData(undefined);
    append({ role: "user", content: text });
  }

  /**
   * 提交 AI 提问的回答（resume 流程，方案 A）
   *
   * 1. 回答作为 user 消息追加到 messages
   * 2. 手写 fetch 调用 /api/agent/chat/resume（带 fileIds）
   * 3. parseDataStream 解析返回流，增量追加 AI 回复
   */
  async function handleAnswer(answer: string, fileIds: string[] = []) {
    if (!sessionId) return;

    setInput("");
    setPendingQuestion(null);
    setReplyMode(false);
    setGlobalError(null);

    const assistantId = crypto.randomUUID();
    setMessages((prev) => [
      ...prev,
      // 纯文件上传（无文字回答）时显示兜底文案
      { id: crypto.randomUUID(), role: "user", content: answer || "[仅上传文件]" },
      { id: assistantId, role: "assistant", content: "" },
    ]);

    setResuming(true);
    try {
      const response = await fetch("/api/agent/chat/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, answer, fileIds }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      await parseDataStream(response, {
        onText: (delta) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, content: m.content + delta } : m,
            ),
          );
        },
        onEvent: (event) => handleDataEvent(event),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setGlobalError(msg);
    } finally {
      setResuming(false);
    }
  }

  // ============================================
  // 保存到 Coze
  // ============================================

  async function handleSaveToCoze() {
    if (!workflow || saving) return;

    setSaving(true);
    setGlobalError(null);

    try {
      const res = await workflowApi.create(workflow);
      setSavedResult(res);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setGlobalError(`保存失败: ${msg}`);
    } finally {
      setSaving(false);
    }
  }

  // ============================================
  // 渲染
  // ============================================

  return (
    <div className="app">
      <Header status={busy ? "running" : "idle"} />

      <main className="chat-layout">
        {/* 对话主区 */}
        <section className="chat-main">
          {globalError && (
            <div className="chat-error">
              <span>⚠️ {globalError}</span>
              <button
                type="button"
                className="chat-error-close"
                onClick={() => setGlobalError(null)}
                title="关闭"
              >
                ×
              </button>
            </div>
          )}

          <ChatMessageList
            messages={messages as ChatMessage[]}
            isLoading={busy}
            pendingQuestion={pendingQuestion}
          />

          <ChatInput
            input={input}
            onInputChange={setInput}
            onSend={handleSend}
            onAnswer={handleAnswer}
            mode={replyMode ? "reply" : "normal"}
            pendingQuestionText={pendingQuestion?.question}
            loading={busy}
          />
        </section>

        {/* 右侧面板：工具链 / 草图 / JSON / 校验 / 保存 */}
        <aside className="chat-sidebar">
          <ToolCallPanel toolCalls={toolCalls} />
          <WorkflowCanvas sketch={sketch} />
          <JsonPreview workflow={workflow} validation={validation} />

          {/* 保存到 Coze 按钮：仅在校验通过且工作流存在时显示 */}
          {workflow && validation?.valid && (
            <div className="save-section">
              {savedResult ? (
                <div className="save-result">
                  <p className="hint-text">
                    已保存：workflow_id = {savedResult.workflowId}
                  </p>
                  <a
                    href={`https://coze.dev1.dachensky.com/work_flow?workflow_id=${savedResult.workflowId}&space_id=7560621359533916160`}
                    target="_blank"
                    rel="noreferrer"
                    className="save-link"
                  >
                    在平台查看
                  </a>
                </div>
              ) : (
                <button
                  className="btn btn-primary"
                  disabled={saving}
                  onClick={handleSaveToCoze}
                  style={{ width: "100%" }}
                >
                  {saving ? "保存中..." : "保存到 Coze"}
                </button>
              )}
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}
