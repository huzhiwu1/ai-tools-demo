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
  isToolOutputFailed,
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
 * 用分段累积文本重建 AI 气泡（done/interrupt 补偿）
 *
 * 背景：useChat 每收到一个 data 事件，都会用「发送时的消息快照 + 它自己累积的
 * assistant 消息」重置 messages。本应用把所有 0: 文本行都转成了 2: data 事件，
 * useChat 自己累积的消息恒为空 → 每次重置都会覆盖掉 text_delta 期间 setMessages
 * 添加的 AI 气泡（前端表现为 AI 回复完全不可见）。done/interrupt 是流的最后
 * 一个 data 事件，此时重建不会再被覆盖。
 *
 * 泛型 T 兼容 AI SDK 的 Message 与本地 ChatMessage 两种消息形态。
 *
 * @param prev - 当前消息列表
 * @param segments - 本轮累积的文本分段（每个分段 = 一个气泡）
 * @returns 重建后的消息列表
 */
function rebuildAssistantSegments<T extends { id: string; content: string }>(
  prev: T[],
  segments: Array<{ id: string; content: string }>,
): T[] {
  let next = prev;
  for (const seg of segments) {
    const idx = next.findIndex((m) => m.id === seg.id);
    if (idx === -1) {
      // 气泡被快照重置覆盖 → 重建
      next = [
        ...next,
        { id: seg.id, role: "assistant", content: seg.content } as unknown as T,
      ];
    } else if (next[idx].content !== seg.content) {
      // 部分残留（覆盖竞态中间态）→ 补齐完整文本
      next = next.map((m) =>
        m.id === seg.id ? { ...m, content: seg.content } : m,
      );
    }
  }
  return next;
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
    stop,
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
        const lastUser = [...msgs].reverse().find((m) => m.role === "user");
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
    // useChat 内部错误兜底：前端未解构 error 状态，这里至少打进 console 便于定位
    onError: (e) => console.error("[useChat error]", e),
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

  // 打断能力：resume 请求的 AbortController（发送新消息时中断正在进行的 resume）
  const resumeAbortRef = useRef<AbortController | null>(null);

  // data 数组已处理位置（发送新消息时归零，配合 setData(undefined) 使用）
  const processedDataCount = useRef(0);

  /** 当前正在累积文本的 assistant 消息 id（null = 没有开放的分段） */
  const currentAssistantIdRef = useRef<string | null>(null);
  /** 当前正在累积的思考段落消息 id（reasoning_delta 流式写入，工具调用/正式输出时封存） */
  const currentReasoningIdRef = useRef<string | null>(null);
  /**
   * 本轮文本分段累积（每个分段 = 一个 AI 气泡的完整文本）
   *
   * 用于 done/interrupt 时的覆盖竞态补偿重建（详见 rebuildAssistantSegments）。
   * 分段边界（tool_start/tool_end/interrupt）不截断数组，只切新分段。
   */
  const textSegmentsRef = useRef<Array<{ id: string; content: string }>>([]);

  const busy = isLoading || resuming;

  // ============================================
  // data 事件处理
  // ============================================

  /**
   * 处理单个 d: 事件（session/tool_start/tool_end/interrupt/done/error）
   *
   * 使用函数式 setState，回调内无外部依赖。
   */
  const handleDataEvent = useCallback(
    (event: DataStreamEvent) => {
      switch (event.type) {
        case "session": {
          if (typeof event.sessionId === "string") {
            setSessionId(event.sessionId);
          }
          break;
        }

        case "text_delta": {
          const content = event.content ?? "";
          if (!content) break;

          // 正式输出开始 → 思考段落封存（固化到消息流，不再累积）
          currentReasoningIdRef.current = null;

          // 分段累积（done 补偿重建用）
          const segments = textSegmentsRef.current;
          const lastSeg = segments[segments.length - 1];
          const openId = currentAssistantIdRef.current;

          if (!openId || lastSeg?.id !== openId) {
            // 没有开放分段 → 新建分段 + assistant 消息
            const newId = crypto.randomUUID();
            currentAssistantIdRef.current = newId;
            segments.push({ id: newId, content });
            setMessages((prev) => [
              ...prev,
              { id: newId, role: "assistant", content },
            ]);
            break;
          }

          // 有开放分段 → 追加文本
          lastSeg.content += content;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === openId ? { ...m, content: m.content + content } : m,
            ),
          );
          break;
        }

        case "reasoning_delta": {
          // LLM 思考内容增量（DeepSeek reasoning_content）
          // 固化到消息流（data.type="reasoning"），让用户看到完整决策过程
          // （遇到什么问题、为什么这么做、准备怎么处理）
          const content = event.content ?? "";
          if (!content) break;
          setMessages((prev) => {
            // 没有开放的思考段落 → 新建一条 reasoning 消息
            if (!currentReasoningIdRef.current) {
              const newId = crypto.randomUUID();
              currentReasoningIdRef.current = newId;
              return [
                ...prev,
                {
                  id: newId,
                  role: "assistant",
                  content: "",
                  data: { type: "reasoning", content },
                },
              ];
            }
            // 有开放段落 → 追加内容
            return prev.map((m) => {
              if (m.id !== currentReasoningIdRef.current) return m;
              const cur =
                (m.data as { content?: string } | undefined)?.content ?? "";
              return {
                ...m,
                data: { type: "reasoning", content: cur + content },
              };
            });
          });
          break;
        }

        case "tool_start": {
          // 分段边界：封存当前文本分段，后续文本进新气泡
          currentAssistantIdRef.current = null;
          // 工具调用前的思考段落封存（固化到消息流，用户能看到为什么调这个工具）
          currentReasoningIdRef.current = null;

          const name = event.name ?? "unknown";
          // 渲染 key 用随机 UUID：不能用自增序号——打断发送新消息时旧流
          // 残留事件会重放（processedDataCount 已归零），HMR 时 ref 会随组件
          // 重执行归零而 useState 保留，自增 id 会与旧记录撞 key（React 警告）
          setToolCalls((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              name,
              status: "running",
              time: nowTime(),
            },
          ]);
          break;
        }

        case "tool_end": {
          // 工具结束后 AI 若继续说话 → 新气泡
          currentAssistantIdRef.current = null;

          const name = event.name ?? "unknown";
          const output = event.output ?? "";
          // 判断工具是否真正失败（靠输出格式 + 错误前缀，不靠 contains "失败"）
          const failed = isToolOutputFailed(output);
          setToolCalls((prev) => {
            // 从后往前匹配最近的同名 running 记录
            for (let i = prev.length - 1; i >= 0; i--) {
              if (prev[i].name === name && prev[i].status === "running") {
                return prev.map((t, idx) =>
                  idx === i ? { ...t, status: failed ? "error" : "done" } : t,
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
          const question = event.question ?? "请补充信息";
          const context = event.context;
          setPendingQuestion({ question, context });
          // 封存思考段落
          currentReasoningIdRef.current = null;
          // 底部输入框切换为回复模式
          setReplyMode(true);
          // interrupt 是流结束前最后一个 data 事件：先重建被覆盖的文本气泡，
          // 再把问题固化到消息流（回答后仍保留，不会消失）
          // 渲染时通过 data.type==="question" 显示提问卡片
          const segments = textSegmentsRef.current;
          setMessages((prev) => {
            const base =
              segments.length > 0
                ? rebuildAssistantSegments(prev, segments)
                : prev;
            return [
              ...base,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: "",
                data: { type: "question", question, context: context ?? null },
              },
            ];
          });
          textSegmentsRef.current = [];
          // 分段边界：封存当前文本分段
          currentAssistantIdRef.current = null;
          break;
        }

        case "done": {
          // 一次对话完成。done 是流的最后一个 data 事件，此处用分段累积文本
          // 重建被 useChat 快照重置覆盖的 AI 气泡（此后流结束，不再有覆盖）
          const segments = textSegmentsRef.current;
          if (segments.length > 0) {
            setMessages((prev) => rebuildAssistantSegments(prev, segments));
          }
          textSegmentsRef.current = [];
          // 关闭当前分段
          currentAssistantIdRef.current = null;
          currentReasoningIdRef.current = null;
          break;
        }

        case "error": {
          setGlobalError(event.message ?? "发生错误");
          break;
        }
      }
    },
    [setMessages],
  );

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
    // LLM 思考/工具运行中 → 打断当前思考，立即发送新消息
    if (busy) {
      interruptCurrent();
    }

    sendNewMessage(text);
  }

  /** 打断当前 AI 思考/工具执行（useChat 流 + resume 请求都中断） */
  function interruptCurrent() {
    // 中断 useChat 当前流（AI SDK v3 的 stop）
    try {
      stop();
    } catch {
      // stop 内部异常忽略（可能已结束）
    }
    // 中断正在进行的 resume 请求
    resumeAbortRef.current?.abort();
    resumeAbortRef.current = null;
  }

  /** 真正发送一条消息（重置上一轮状态） */
  function sendNewMessage(text: string) {
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
    // 发新消息时重置分段状态
    currentAssistantIdRef.current = null;
    currentReasoningIdRef.current = null;
    textSegmentsRef.current = [];
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

    // 恢复对话前关闭当前分段，确保回答后的文本从新气泡开始
    currentAssistantIdRef.current = null;

    setMessages((prev) => [
      ...prev,
      // 纯文件上传（无文字回答）时显示兜底文案
      {
        id: crypto.randomUUID(),
        role: "user",
        content: answer || "[仅上传文件]",
      },
    ]);

    setResuming(true);
    const controller = new AbortController();
    resumeAbortRef.current = controller;
    try {
      const response = await fetch("/api/agent/chat/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, answer, fileIds }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // 复用 handleDataEvent 的 text_delta 分段逻辑
      await parseDataStream(response, {
        onText: (delta) => {
          handleDataEvent({
            type: "text_delta",
            content: delta,
          } as DataStreamEvent);
        },
        onEvent: (event) => handleDataEvent(event),
      });
    } catch (e) {
      // 主动打断（用户发送新消息）不算错误，不弹提示
      if (!controller.signal.aborted) {
        const msg = e instanceof Error ? e.message : String(e);
        setGlobalError(msg);
      }
    } finally {
      setResuming(false);
      if (resumeAbortRef.current === controller) {
        resumeAbortRef.current = null;
      }
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
