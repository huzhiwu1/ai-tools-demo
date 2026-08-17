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
 * - 后端输出自定义 Data Stream（0:/d:/e:），useChat 自定义 fetch 仅将 d: 事件
 *   适配为 AI SDK 标准 2: data 事件；0: 文本行直通 useChat 原生累积，
 *   不再手动分段——彻底消除了 useChat 快照重置覆盖前端 setMessages 的根因
 * - 请求体通过 experimental_prepareRequestBody 改写为后端期望的
 *   { sessionId, message } 格式（useChat 默认发 messages 数组）
 * - resume 走手写 fetch + parseDataStream（方案 A），流式追加 AI 回复
 * - reasoning 内容从 useChat data 数组派生，注入 messages 末尾渲染思考气泡
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

  // step → 段文本内容：reasoning_delta 按 step 累积，供段气泡/正文气泡渲染取用。
  // 不写进 messages（@ai-sdk/react 1.0.13 的 onUpdate 会用请求时快照
  // mutate 重置整个 messages，setMessages 插入的段消息会被覆盖）；
  // 段气泡锚点消息（step_text_start/final_answer）由 useChat 自行累积的
  // role:"data" 消息承担，不在覆盖范围内
  const [stepContents, setStepContents] = useState<Record<number, string>>({});

  const busy = isLoading || resuming;

  // ============================================
  // data 事件处理
  // ============================================

  /**
   * 处理单个 d: 事件（session/tool_start/tool_end/interrupt/done/error/
   * step_text_start/reasoning_delta/final_answer）
   *
   * source：chat = useChat 主流（step 锚点消息由 useChat 自动累积，不 setMessages）；
   * resume = 手写 fetch 流（不走 useChat，需手动把锚点消息插入 messages）
   *
   * 使用函数式 setState，回调内无外部依赖。
   */
  const handleDataEvent = useCallback(
    (event: DataStreamEvent, source: "chat" | "resume") => {
      switch (event.type) {
        case "session": {
          if (typeof event.sessionId === "string") {
            setSessionId(event.sessionId);
          }
          // 新 driver 开始：旧 step 号作废，清空段内容（已渲染的旧段保留）
          setStepContents({});
          break;
        }

        case "step_text_start": {
          // 新 step 文本段开始：登记空内容；resume 流手动插入锚点消息
          // （chat 流的锚点由 useChat 从 2: data 事件自行累积，无需手动插入）
          const step = event.step ?? 0;
          if (step <= 0) break;
          setStepContents((prev) => ({ ...prev, [step]: prev[step] ?? "" }));
          if (source === "resume") {
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "data",
                content: "",
                data: { type: "step_text_start", step },
              },
            ]);
          }
          break;
        }

        case "reasoning_delta": {
          // LLM 文本/思考增量：按 step 累积到段内容（过程气泡流式打字）
          const step = event.step ?? 0;
          const delta = event.content ?? "";
          if (step <= 0 || !delta) break;
          setStepContents((prev) => ({
            ...prev,
            [step]: (prev[step] ?? "") + delta,
          }));
          break;
        }

        case "final_answer": {
          // 该 step 是最终回复：resume 流手动插入正文锚点消息，
          // 渲染时按 step 取 stepContents 展示为正文气泡
          const step = event.step ?? 0;
          if (step <= 0) break;
          if (source === "resume") {
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "data",
                content: "",
                data: { type: "final_answer", step },
              },
            ]);
          }
          break;
        }

        case "tool_start": {
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
          setReplyMode(true);
          // 把问题固化到消息流（回答后仍保留，不会消失）
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content: "",
              data: { type: "question", question, context: context ?? null },
            },
          ]);
          break;
        }

        case "done": {
          // 一次对话完成。最终回复已由 final_answer 事件升级为正文气泡，
          // 中间步骤叙述已按段渲染为过程气泡，无需在此重建消息。
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
        handleDataEvent(item as unknown as DataStreamEvent, "chat");
      }
    }
  }, [data, handleDataEvent]);

  // 正在流式打字的 step 段：扫描 messages 中 step_text_start/final_answer
  // 锚点，最后一个尚未 final_answer 的段即为当前打字段（流结束为 null）
  const streamingStep = useMemo(() => {
    if (!busy) return null;
    let lastStep: number | null = null;
    for (const m of messages) {
      const anchor = (m.data as { type?: string; step?: number } | undefined);
      if (m.role === "data" && anchor?.type === "step_text_start") {
        lastStep = typeof anchor.step === "number" ? anchor.step : null;
      } else if (
        m.role === "data" &&
        anchor?.type === "final_answer" &&
        lastStep === anchor.step
      ) {
        lastStep = null;
      }
    }
    return lastStep;
  }, [messages, busy]);

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
    // 先把当前 step 段内容固化到锚点消息（打断/流结束后 setMessages 不再被
    // useChat 覆盖，渲染时优先取锚点自带 content，stepContents 清空后旧段
    // 气泡文字不丢失）
    const frozen = { ...stepContents };
    if (Object.keys(frozen).length > 0) {
      setMessages((prev) =>
        prev.map((m) => {
          const d = m.data as
            | { type?: string; step?: number }
            | undefined;
          if (
            m.role === "data" &&
            (d?.type === "step_text_start" || d?.type === "final_answer") &&
            d.step != null &&
            frozen[d.step]
          ) {
            return { ...m, data: { ...d, content: frozen[d.step] } };
          }
          return m;
        }),
      );
    }

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
    // 新一轮对话：旧 step 段内容作废（打断后残留 reasoning_delta 不落到新段）
    setStepContents({});
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

      // resume 流：文本/段事件统一走 handleDataEvent（后端不再发 0: 文本，
      // 全部文本经 reasoning_delta/final_answer 按 step 分段渲染）
      await parseDataStream(response, {
        onEvent: (event) => handleDataEvent(event, "resume"),
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
            stepContents={stepContents}
            streamingStep={streamingStep}
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
