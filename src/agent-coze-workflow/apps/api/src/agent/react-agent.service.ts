/**
 * ReactAgentService - ReAct Agent 核心服务（对齐 DeepSeek Harness 架构）
 *
 * 职责：
 * 自建 kick → turn → step 双层主循环，彻底移除 LangGraph 编排：
 * - LLM 直连 ChatOpenAI.stream（bindTools），工具结果以 ToolMessage 写回 history
 * - abort 信号只在自建循环内传递：每个 promise 都由本服务创建并捕获，
 *   不再经过 LangGraph combineAbortSignals 的同步转发链（「思考中打断必崩」的根因）
 * - clarify_question 通过 __clarify 标记 + 服务层挂起实现（替代 LangGraph interrupt）
 *
 * 流程：
 * 1. handleChat：打断旧 driver → 消息入 inbox.nextTurn → 启动新 driver
 * 2. driver = 本次 HTTP 请求的生命周期：claim 用户消息 → step 循环 → SSE 收尾
 * 3. handleResume：回答写回占位 ToolMessage → 重启 driver 继续原 turn
 *
 * 输出协议：Vercel AI SDK Data Stream Protocol
 * - d:{...}    → 结构化数据（session/tool_start/tool_end/interrupt/done/error/aborted）
 * - e:{...}    → 流结束标记
 *
 * 文本分段协议（每个 step 的 LLM 文本独立成段，前端按段渲染气泡）：
 * - d:{"type":"step_text_start", step} → 新段开始（前端开新气泡）
 * - d:{"type":"reasoning_delta", content, step} → 文本/思考增量（过程气泡流式打字）
 * - d:{"type":"final_answer", step} → 该段是最终回复（前端升级为正文气泡）
 *   中间步骤叙述走过程气泡（可折叠），最终回复单独正文气泡，不再混在一个气泡
 *
 * 关键细节：
 * - driver 收敛用 identity guard（finally 里 session.phase === phase 才收敛），
 *   超时未收敛的旧 driver 不会破坏新 driver 的 phase
 * - 打断时 AI 半截输出不落 history；已落 history 的半截 tool_calls 序列
 *   由 buildMessages 自愈补全（对齐 Harness appendSkippedToolCall）
 * - max_tokens 粘性（Harness 语义）：曾截断的 turn 不被后续正常 step 降级
 */

import { ChatOpenAI } from "@langchain/openai";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  isAIMessage,
  isToolMessage,
} from "@langchain/core/messages";
import type { AIMessageChunk, BaseMessage } from "@langchain/core/messages";
import { Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { ALL_TOOLS } from "./tools";
import {
  sessionStore,
  type AgentEvent,
  type Phase,
  type Session,
  type TurnEndReason,
} from "./session.store";
import { uploadPathStore } from "./upload-store";

/**
 * SSE 响应最小接口（避免引入 @types/express 依赖）
 *
 * 只声明写 SSE 流所需的方法，与 NestJS/Express 的 Response 兼容。
 */
interface SSEResponse {
  setHeader(name: string, value: string): void;
  flushHeaders(): void;
  write(chunk: string): boolean;
  end(): void;
  destroyed: boolean;
  on(event: "close", listener: () => void): unknown;
  removeListener(event: "close", listener: () => void): unknown;
}

// ============================================
// 系统提示词
// ============================================

const SYSTEM_PROMPT = `你是 Coze 工作流构建助手。根据用户需求完成工作流的设计、生成、部署与交付；只有用户明确要求验证时才进行批量验证。

## 可用工具
1. clarify_question: 当用户需求信息不完整时调用（缺少数据源、格式约定、输出要求等），暂停等待用户回答
2. read_file: 通用文件读取，返回文件原始内容。文件的具体用途、列含义、数据如何参与工作流，由你（LLM）根据用户需求判断
3. plan_workflow: 将用户需求分析为结构化工作流规划（WorkflowPlan）
4. generate_workflow: 将规划结果映射为 Coze 平台可部署的工作流 JSON（plan 参数可选，优先传 planId 句柄，不背完整 plan）
5. save_to_coze: 将工作流部署到 Coze 平台（workflow JSON 参数可选，优先用 workflowId / workflowHandle 句柄）
6. test_run_workflow: 试运行已部署的工作流
7. batch_validate: 批量试运行已部署的工作流，对照期望值验证准确性，返回准确率 + 错误明细 + 归因分组
8. update_workflow: 根据归因分析结果修改工作流节点（阈值/代码/逻辑/prompt/提示词/数据/常量），只接受 operations 结构化操作数组
9. rename_workflow: 修改已创建工作流的名称/描述（不走 save，不影响工作流内容）
10. list_workflows: 搜索平台已有工作流（按名称关键词），返回摘要列表（workflowId/name/desc）
11. read_workflow: 读取平台已有工作流，输出人类可读说明书（拓扑图/节点清单/数据流/配置详情）

## 交付优先（最重要，必须遵守）
- **保存成功即交付**：save_to_coze 返回 saved: true 后，立即向用户总结交付（含 workflowId），停止一切验证与修改
- 除非用户明确要求验证（如「验证一下/测一下/看准确率」），不要调用 batch_validate / test_run_workflow
- 用户要求验证后：若 accuracy < 100%，最多修复 1 次（update_workflow → save_to_coze），然后无论结果如何都必须向用户汇报（准确率 + 失败分析 + 建议），不得自动进入第二轮修复
- 收到「已达迭代上限」错误：必须停止，向用户汇报当前结果，不要尝试绕过或继续修改
- 收到「[系统拦截]」提示：说明任务已完成或不应继续当前操作，请遵守提示直接总结交付

## 使用规则
- 先分析需求是否完整，缺信息时优先调用 clarify_question
- 规划→生成→部署→交付，按顺序执行；用户要求验证时才追加验证步骤
- 工具调用失败时，将错误信息告知用户
- **读工作流规则**：
  - 用户没给 workflowId 时，先 list_workflows 按名称搜索拿 ID
  - 用户问「工作流长什么样/为什么错」、或准备修改线上已有工作流时，先 read_workflow 读说明书（读后写入服务端缓存）
  - read_workflow 默认 scope=overview（概览+节点清单+数据流，省 token）；需要完整配置与验证报告时用 scope=full
- **save_to_coze 规则（重要）**：
  - **首次保存**：不传 workflowId，创建新工作流（generate_workflow 返回 workflowHandle 时直接传它，不背大 JSON）
  - **修复迭代**（校验失败/试运行失败/批量验证失败后 update_workflow 修改过）：
    重新 save_to_coze 时**必须带上原 workflowId**，在原工作流上更新，不要新建！
  - 只有第一次创建工作流本身失败时才重新创建
  - save_to_coze 提示"工作流名称已存在"时：工具会自动加后缀重试；若仍需指定名称，用 rename_workflow 改名后重新保存
- rename_workflow 只改名称/描述，不影响工作流内容
- **句柄化（重要）**：
  - update_workflow 只传 workflowId + operations（结构化操作数组，主路径），不要传大 JSON、不要用自然语言修改指令
  - update_workflow 只改服务端缓存不落平台，**修改后必须 save_to_coze（传 workflowId）保存，保存成功才生效**
  - update_workflow 返回「线上工作流已被修改，已重新拉取」时，说明平台侧有人工修改，需基于最新版本重新描述修改指令
- **plan 句柄化**：plan_workflow 返回 planId 后，generate_workflow 只传 planId 即可（不传完整 plan JSON）
- **不要重复规划**：plan_workflow 返回 planningComplete=true 后，直接进入 generate_workflow（传 planId）。除非规划结果与用户需求明显不符（如漏了关键步骤/选错模型），否则不要再次调用 plan_workflow
- **线上工作流找回**：如果用户提到"之前的工作流/已经保存的/改一下刚才那个"，但当前上下文没有 workflowId，先 list_workflows 按名称搜索找回，不要重新创建

## 系统级约束（由代码强制，收到错误时遵守）
- batch_validate / update_workflow 有系统级迭代上限（3 轮），达到后工具会返回"已达迭代上限"错误，此时必须停止并汇报结果，不要尝试绕过或继续修改
- save_to_coze 返回"authentication failed" / "access denied" → 这是平台凭证问题，不是工作流问题！不要修改工作流、不要反复保存，直接告知用户"COZE_SESSION_KEY 可能过期，请检查 .env 后重试"

## 文件与验证流程（当用户上传文件或要求验证时）
1. 用户上传文件 → 消息里会附「本地路径」，用 read_file 读该路径（通用读取，不做业务假设）
2. 根据用户需求 + 文件内容，判断：
   - 文件是干什么的？（数据源？期望结果？参考文档？）
   - 信息是否完整？是否还缺关键信息（如判断标准、字段含义、输出格式）？
   - 不确定 → 调用 clarify_question 向用户询问
3. 完全理解需求后，再 plan_workflow 设计工作流
4. generate_workflow 生成 → 检查 validation。⚠️ 若文件内容是需要内嵌到工作流的参考数据（如歌词库、歌曲列表、常量表），必须将文件内容作为 referenceData 参数传入 generate_workflow（格式：{歌名/键: 内容}），禁止编造或省略——否则代码节点会凭空生成错误数据
5. save_to_coze 保存 → 拿 workflowId → **向用户交付（默认流程到此结束）**
6. 仅当用户明确要求验证时：batch_validate 批量试运行（cases 由 LLM 根据文件内容构造）→ 看 accuracy
7. 若 accuracy < 100%：最多 1 次 update_workflow（传 operations）→ save_to_coze（传 workflowId）→ 然后无论结果如何都向用户汇报（准确率 + 失败分析 + 建议），不再自动重复验证
8. 若收到"已达迭代上限"错误：停止迭代，向用户汇报当前结果（准确率 + 失败分析）

## 输出格式
- 思考过程：用自然语言解释当前步骤
- 工具调用：按需调用对应工具
- 最终答案：完成后总结整个流程（含 workflowId 等关键信息）`;

// ============================================
// LLM 实例（模块级单例，所有会话共享）
// ============================================

/** 共享 LLM 实例：ChatOpenAI 内部有连接池，无需每个会话 new */
// 优先用 dachensky 网关（LLM_*，支持思考+工具调用），fallback 官方 DeepSeek（DEEPSEEK_*）
const llm = new ChatOpenAI({
  model: process.env.LLM_MODEL ?? process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
  apiKey: process.env.LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY,
  configuration: {
    baseURL:
      process.env.LLM_BASE_URL ??
      process.env.DEEPSEEK_BASE_URL ??
      "https://api.deepseek.com/v1",
  },
  temperature: 0.2,
  // 思考模型（deepseek-v4-flash）的 reasoning 与正文共用 completion tokens，
  // 官网默认 4K 上限会把含工具调用参数的输出截断，导致工具参数解析失败后
  // 错误反馈给 LLM 反复重试（观感死循环）。实测官网接受 8192，显式放大。
  // 注意：若模型切回 deepseek-chat 等非思考模型，此值同样安全。
  // 2026-08-16 修复：主 LLM 漏了关思考配置（DeepSeekClient 已关，主 Agent 循环没关）——
  // plan_workflow 输出大 JSON 后，主 LLM 下一步要重新背诵 plan 作为工具参数，
  // reasoning 吃掉 8192 大半预算 → 正文截断 → 无 tool_calls → Agent 静默 done。
  // 2026-08-16 尝试恢复思考（去掉 disabled），实测：打断并发送后前端仍不显示 reasoning，
  // 且思考吃预算导致长工具参数截断风险。结论：关闭思考保稳定（前端已用"处理中"文案兜底）。
  maxTokens: 16384,
  modelKwargs: { thinking: { type: "disabled" } },
  // 显式限制超时与重试：默认 maxRetries=6 会把单次失败放大为
  // 6 次静默重试（每次等满超时），前端表现为长时间无事件、一直转圈
  timeout: 60_000,
  maxRetries: 1,
});

/** 绑定工具后的模型（模块级单例：工具 schema 不变，无需每次重建） */
const modelWithTools = llm.bindTools([...ALL_TOOLS]);

// ============================================
// 常量
// ============================================

/** 每 turn 最多 LLM 步数（死循环保护上限；交付优先策略下 15 步足够覆盖创建 + 1 轮验证修复） */
const MAX_STEPS_PER_TURN = 15;
/** 发给 LLM 的历史消息滑动窗口上限 */
const MAX_HISTORY_MESSAGES = 40;
/** 等待旧 driver 收敛的超时（ms），超时后强制接管（identity guard 保证安全） */
const DRIVER_CONVERGE_TIMEOUT_MS = 5_000;
/** 事件日志上限（超出淘汰最旧） */
const MAX_EVENTS = 1000;
/** 同一工具同一参数连续调用达到该值判定死循环（第 4 次拦截，不执行） */
const LOOP_REPEAT_LIMIT = 3;
/** 截断工具调用的补位结果文本（对齐 Harness appendSkippedToolCall） */
const TOOL_ABORTED_TEXT = "Error: tool call aborted before dispatch";
/** 同一工具连续失败达到该值拦截（第 3 次失败停止重试，防止失败重试循环） */
const FAIL_REPEAT_LIMIT = 3;
/** 本 turn 最多允许的 plan_workflow 调用次数（超出拦截，防重复规划） */
const PLAN_CALL_LIMIT = 2;
/** save 成功后默认拦截的迭代工具（交付优先：保存成功即停） */
const DELIVERY_BLOCK_TOOLS = new Set([
  "plan_workflow",
  "generate_workflow",
  "batch_validate",
  "update_workflow",
]);
/** 用户明确要求验证时，save 后仅拦截重复规划/生成（验证修复由迭代计数器兜底） */
const DELIVERY_BLOCK_TOOLS_VALIDATION = new Set([
  "plan_workflow",
  "generate_workflow",
]);

// ============================================
// 类型定义
// ============================================

/** clarify_question 返回的挂起标记（自建主循环协议，替代 LangGraph interrupt） */
interface ClarifyMarker {
  __clarify: true;
  question: string;
  context?: string;
}

/** 死循环检测状态（turn 内局部，跨 step 连续跟踪） */
interface LoopGuard {
  lastToolName: string;
  lastToolInput: string;
  repeatCount: number;
  /** 上一轮同工具是否执行失败（连续失败拦截用） */
  lastFailed: boolean;
  /** 同一工具连续失败次数 */
  failStreak: number;
}

/** turn 级交付守卫状态（跨 step 共享，save 成功后拦截迭代工具） */
interface TurnGuardState {
  /** 本 turn 是否已有工作流保存成功（交付信号） */
  saveSucceeded: boolean;
  /** save 成功后拦截迭代工具的累计次数（第 2 次拦截强制收尾） */
  iterationBlockCount: number;
  /** 本 turn 的 plan_workflow 调用次数 */
  planCallCount: number;
  /** 用户是否明确要求验证（决定 save 后拦截范围） */
  validationRequested: boolean;
}

/** 模型顺序提交的工具调用（参数为原始 JSON 字符串） */
interface PlannedCall {
  id: string;
  name: string;
  args: string;
}

/** 单步 LLM 调用的结果（null = 工具执行完毕，继续下一步） */
type StepOutcome =
  | { kind: "completed" }
  | { kind: "max_tokens" }
  | { kind: "loop_detected"; name: string; input: unknown }
  | { kind: "repeat_failure"; name: string; input: unknown }
  | { kind: "forced_delivery" }
  | { kind: "clarify"; question: string; context?: string }
  | null;

// ============================================
// 模块级辅助函数
// ============================================

/**
 * 解析工具参数：JSON 字符串 → 对象；解析失败保文本（对齐 Harness parseArguments）
 *
 * 防御解包：模型可能模仿 OpenAI 请求格式输出 {"arguments": "<json>"}
 * 包装（历史上下文污染时尤甚），单键 arguments 且内层可解析为对象时
 * 还原为真实参数对象，避免 zod schema 校验失败。
 *
 * @param raw - LLM 输出的原始参数（流式组装后为完整 JSON 字符串）
 * @returns 参数对象；非法 JSON 时以 _invalid_json 键保文本，供工具感知解析失败
 */
function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return raw as Record<string, unknown>;
  try {
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof parsed.arguments === "string" &&
      Object.keys(parsed).length === 1
    ) {
      try {
        const inner = JSON.parse(parsed.arguments);
        if (inner && typeof inner === "object" && !Array.isArray(inner)) {
          return inner;
        }
      } catch {
        // 内层不是 JSON（合法业务参数），保留原样
      }
    }
    return parsed;
  } catch {
    return { _invalid_json: raw };
  }
}

/**
 * 提取消息内容的纯文本（兼容 string 与 content blocks 数组两种形态）
 *
 * @param content - AIMessage 的 content 字段
 * @returns 纯文本内容
 */
function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === "object" &&
        block !== null &&
        "text" in block &&
        typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
          : "",
      )
      .join("");
  }
  return "";
}

/** 工具出参转字符串：对象序列化为 JSON（避免 [object Object]） */
function stringifyToolOutput(result: unknown): string {
  return typeof result === "object" && result !== null
    ? JSON.stringify(result)
    : String(result);
}

/**
 * 错误链文本：沿 cause 链拼接（避免只看到最外层包装错误）
 *
 * @param error - 任意错误对象
 * @returns 完整错误描述
 */
function errorChainText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.length > 0 ? parts.join(" → ") : String(error);
}

/** clarify 挂起标记判定（类型守卫） */
function isClarifyMarker(value: unknown): value is ClarifyMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __clarify?: unknown }).__clarify === true &&
    typeof (value as { question?: unknown }).question === "string"
  );
}

/** history 中最后一条有文本的 AI 消息内容（done 事件的 final 取值） */
function lastAssistantText(session: Session): string {
  for (let i = session.history.length - 1; i >= 0; i--) {
    const msg = session.history[i];
    if (isAIMessage(msg)) {
      const text = extractTextContent(msg.content);
      if (text) return text;
    }
  }
  return "处理完成";
}

// ============================================
// 服务类
// ============================================

export class ReactAgentService {
  private readonly logger = new Logger("Agent");

  // ============================================
  // 对外入口
  // ============================================

  /**
   * 处理聊天请求（SSE 流）
   *
   * 打断语义（对齐 Harness followup + cancel）：若旧 driver 正在运行，
   * 先 abort 并等待收敛，再入队新消息、启动新 driver。旧 turn 的半截
   * 输出不落 history，已落的部分由 buildMessages 自愈。
   *
   * @param sessionId - 会话 ID（可选，首次自动生成）
   * @param message - 用户消息
   * @param res - Express Response 对象
   */
  async handleChat(
    sessionId: string | undefined,
    message: string,
    res: SSEResponse,
  ): Promise<void> {
    // 入口日志：info 级别，记 session + 消息前 100 字符
    this.logger.log(
      `[Agent] chat session=${sessionId ?? "new"} msg=${message.slice(0, 100)}`,
    );

    // 1. 获取或创建会话
    let session = sessionId ? sessionStore.get(sessionId) : undefined;
    if (!session) {
      session = sessionStore.create(sessionId);
    }

    // 2. 打断旧 driver 并等其收敛（Harness cancel + whenIdle 语义）
    const wasInterrupted = session.phase.kind === "running";
    if (wasInterrupted) {
      this.logger.log(`[Agent] 打断旧 driver (session=${session.id})`);
      await this.abortAndAwait(session, "user-interrupt");
    }

    // 3. 新消息作废挂起中的 clarify 问题：
    //    删除占位 ToolMessage（buildMessages 自愈补 aborted 结果），清空挂起状态
    if (session.pendingClarify) {
      const last = session.history[session.history.length - 1];
      if (last && isToolMessage(last)) session.history.pop();
      session.pendingClarify = null;
    }

    // 4. 消息入队 → 启动 driver（两行之间无 await，phase 不会被并发请求抢占）
    session.inbox.nextTurn.push(message);
    await this.runDriver(session, res, { interrupted: wasInterrupted });
  }

  /**
   * 处理 resume 请求（SSE 流，从 clarify 挂起处继续）
   *
   * 回答写回挂起时留下的占位 ToolMessage（clarify_question 的工具结果
   * 即「用户回答: xxx」），随后重启 driver 继续原 turn。
   *
   * @param sessionId - 会话 ID
   * @param answer - 用户回答
   * @param fileIds - 可选的文件 ID 列表（回答时附带的上传文件引用）
   * @param res - Express Response 对象
   */
  async handleResume(
    sessionId: string,
    answer: string,
    fileIds: string[] | undefined,
    res: SSEResponse,
  ): Promise<void> {
    // 入口日志：info 级别，记 session + 回答前 100 字符
    this.logger.log(
      `[Agent] resume session=${sessionId} answer=${(answer ?? "").slice(0, 100)}`,
    );

    const session = sessionStore.get(sessionId);
    if (!session) {
      this.failImmediately(res, "会话不存在或已过期");
      return;
    }
    if (!session.pendingClarify) {
      this.failImmediately(res, "当前没有待回答的问题");
      return;
    }

    // 打断旧 driver（用户在等待回答期间触发了其他操作）
    if (session.phase.kind === "running") {
      await this.abortAndAwait(session, "user-interrupt");
    }

    // 若有 fileIds，还原文件名与磁盘路径拼入 answer 文本让 LLM 感知文件并
    // 用 read_file 直接读取；纯文件上传时不以空文本开头
    const fileRefs = fileIds?.length
      ? `[用户上传了文件]\n${fileIds
          .map((id) => {
            const record = uploadPathStore.get(id);
            if (!record) {
              return `- (fileId: ${id})`;
            }
            return `- ${record.name} (fileId: ${id}, 本地路径: ${record.path})`;
          })
          .join("\n")}`
      : "";
    const resumeText = answer
      ? fileRefs
        ? `${answer}\n\n${fileRefs}`
        : answer
      : fileRefs || answer;

    // 回答写回占位 ToolMessage：LLM 继续时看到 clarify_question 的
    // 工具结果为「用户回答: ...」（与原 LangGraph interrupt 语义一致）
    const last = session.history[session.history.length - 1];
    if (last && isToolMessage(last)) {
      session.history[session.history.length - 1] = new ToolMessage({
        content: `用户回答: ${resumeText}`,
        tool_call_id: last.tool_call_id,
        name: last.name,
      });
    } else {
      // 占位丢失（异常场景）：把回答作为新用户消息，走正常 turn 兜底
      session.inbox.nextTurn.push(resumeText);
    }
    session.pendingClarify = null;

    await this.runDriver(session, res, { resume: true });
  }

  // ============================================
  // Driver 生命周期（对齐 Harness wakeDriver/kick）
  // ============================================

  /**
   * 打断旧 driver 并等待收敛
   *
   * abort 在自建循环内安全：所有受影响的 promise（LLM 流、工具调用）
   * 都由本服务创建并在 turn 层捕获，不会产生无消费者的 rejection。
   * 超时后强制接管：旧 driver 的 finally 有 identity guard，不会破坏新 phase。
   *
   * @param session - 会话
   * @param reason - 打断原因（user-interrupt / client-disconnect）
   */
  private async abortAndAwait(session: Session, reason: string): Promise<void> {
    const phase = session.phase;
    if (phase.kind !== "running") return;
    phase.abort.abort(reason);
    const done = session.driverDone;
    try {
      await Promise.race([
        done,
        new Promise<void>((resolve) =>
          setTimeout(resolve, DRIVER_CONVERGE_TIMEOUT_MS),
        ),
      ]);
    } catch {
      // 旧 driver 可能带错退出（driver 边界已包含），这里忽略
    }
  }

  /**
   * 启动一个 driver（= 本次 HTTP 请求的生命周期）
   *
   * 调用方保证 phase 必是 idle。finally 统一收敛：移除 close 监听、
   * 结束 SSE 流、identity guard 下把 phase 收回 idle、resolve driverDone。
   *
   * @param session - 会话
   * @param res - SSE 响应
   * @param options - interrupted: 是否打断旧 driver 而来（发 aborted 提示）；
   *                   resume: 是否 resume 模式（继续原 turn）
   */
  private async runDriver(
    session: Session,
    res: SSEResponse,
    options: { interrupted?: boolean; resume?: boolean } = {},
  ): Promise<void> {
    const phase: Phase = {
      kind: "running",
      abort: new AbortController(),
      turn: (session.phase as { kind: "idle"; lastTurn: number }).lastTurn,
      step: 0,
      wakeRequested: false,
    };
    session.phase = phase;
    // 初始空实现兜底：executor 同步执行保证 resolve 被赋值，但 TS 无法
    // 追踪 Promise 构造器的同步性，这里给初值避免「赋值前使用」误报
    let resolveDriver: () => void = () => {};
    session.driverDone = new Promise<void>((resolve) => {
      resolveDriver = resolve;
    });

    this.setSSEHeaders(res);
    // close 兑底：用户直接关浏览器标签页时没有新请求补发 abort，
    // close 事件由事件循环立即触发，这里补发信号让 LLM 流尽快退出
    const onClose = () => {
      if (!phase.abort.signal.aborted) phase.abort.abort("client-disconnect");
    };
    res.on("close", onClose);

    if (!options.resume) {
      // 会话创建后把 sessionId 告知前端（d: 结构化事件）
      this.sseEvent(res, { type: "session", sessionId: session.id });
      // 打断场景：告知前端上一轮任务已被打断，正在处理新消息
      if (options.interrupted) {
        this.sseEvent(res, {
          type: "aborted",
          message: "已打断上一轮任务，正在处理新消息...",
        });
      }
    }

    try {
      await this.kick(session, phase, res, options.resume ?? false);
    } finally {
      // driver 边界收敛：identity guard 防止超时未收敛的旧 driver
      // 在更晚时刻把新 driver 的 phase 误收为 idle
      res.removeListener("close", onClose);
      if (!res.destroyed) res.end();
      if (session.phase === phase) {
        session.phase = { kind: "idle", lastTurn: phase.turn };
      }
      resolveDriver();
      this.logger.log(`[Agent] phase: running → idle (turn=${phase.turn})`);
    }
  }

  /**
   * driver 主循环（对齐 Harness kick）：执行一个 turn，
   * 一切失败在 turn 内分类上报后由本边界包含（不向外抛，避免未处理 rejection）
   */
  private async kick(
    session: Session,
    phase: Extract<Phase, { kind: "running" }>,
    res: SSEResponse,
    resume: boolean,
  ): Promise<void> {
    try {
      await this.turn(session, phase, res, resume);
    } catch (error) {
      // turn 已分类上报所有失败（aborted/error），driver 边界只负责包含
      this.logger.warn(`[Agent] driver 异常退出: ${errorChainText(error)}`);
    }
  }

  // ============================================
  // Turn / Step 双层循环（对齐 Harness turn/step）
  // ============================================

  /**
   * 执行一个 turn：claim 用户消息 → step 循环 → SSE 收尾
   *
   * @param session - 会话
   * @param phase - 本 driver 的 running phase
   * @param res - SSE 响应
   * @param resume - resume 模式（继续原 turn，不 claim 新消息）
   */
  private async turn(
    session: Session,
    phase: Extract<Phase, { kind: "running" }>,
    res: SSEResponse,
    resume: boolean,
  ): Promise<void> {
    const signal = phase.abort.signal;
    signal.throwIfAborted();

    let turn: number;
    let validationRequested = false;
    if (resume) {
      // resume 继续原 turn（回答已写回 ToolMessage），不递增 turn 计数
      turn = phase.turn;
    } else {
      const claimed = session.inbox.claimTurn();
      if (claimed.length === 0) return; // 队列空（异常边缘），driver 直接退出
      // 用户是否明确要求验证：决定 save 后拦截范围（要求验证时放行 batch_validate/update_workflow，由迭代计数器兜底）
      validationRequested = claimed.some((m) =>
        /验证|校验|准确率|测一下|测测|对一下|检查一下|跑一下用例/.test(m),
      );
      turn = phase.turn + 1;
      phase.turn = turn;
      phase.step = 0;

      // 注入上轮系统警告（死循环拦截等），以 SystemMessage 形式不污染对话序列
      const injected = session.inbox.claimStep();
      if (injected.length > 0) {
        session.history.push(
          new SystemMessage(`【系统记录】${injected.join("\n")}`),
        );
      }
      for (const msg of claimed) {
        session.history.push(new HumanMessage(msg));
      }

      this.logger.log(`[Agent] phase: idle → running (turn=${turn}, step=0)`);
      // turn 开始事件（前端可展示「第 N 轮对话」）
      this.sseEvent(res, { type: "turn_start", turn });
      this.appendEvent(session, "turn_start", { turn });
    }

    let turnEnd: TurnEndReason | null = null;
    // max_tokens 粘性（Harness 语义）：一旦命中，后续正常 step 不能降级
    let stickyMaxTokens = false;
    let maxTokensStreak = 0;
    // 死循环检测状态：turn 内局部，跨 step 连续跟踪
    const loopGuard: LoopGuard = {
      lastToolName: "",
      lastToolInput: "",
      repeatCount: 0,
      lastFailed: false,
      failStreak: 0,
    };
    // 交付守卫：save 成功后拦截迭代工具（防止"修到满意为止"式无限循环）
    const guardState: TurnGuardState = {
      saveSucceeded: false,
      iterationBlockCount: 0,
      planCallCount: 0,
      validationRequested,
    };

    try {
      while (true) {
        signal.throwIfAborted();
        // 步数上限（死循环保护）
        if (phase.step >= MAX_STEPS_PER_TURN) {
          turnEnd = { kind: "step_limit", maxSteps: MAX_STEPS_PER_TURN };
          break;
        }
        const outcome = await this.step(
          session,
          phase,
          res,
          loopGuard,
          guardState,
        );
        if (outcome === null) continue; // 工具执行完，继续下一步

        switch (outcome.kind) {
          case "completed":
            turnEnd = stickyMaxTokens
              ? {
                  kind: "max_tokens",
                  message: "输出可能因达到 token 上限被截断",
                }
              : { kind: "completed" };
            break;
          case "max_tokens":
            // 粘性标记 + 连续截断计数（连续 2 步截断 → 终止）
            stickyMaxTokens = true;
            maxTokensStreak += 1;
            this.logger.warn(
              `[Agent] turn=${turn} step=${phase.step} max_tokens (finish_reason=length)`,
            );
            if (maxTokensStreak >= 2) {
              turnEnd = {
                kind: "max_tokens",
                message:
                  "连续两次输出达到模型 token 上限（内容可能被截断）。请简化需求或拆分为更小的步骤。",
              };
            }
            break;
          case "loop_detected":
            turnEnd = {
              kind: "error",
              code: "loop_detected",
              message: `检测到工具 ${outcome.name} 连续 4 次以相同参数被调用（疑似死循环），已停止执行。请简化需求或提供更明确的信息后重试。`,
            };
            break;
          case "repeat_failure":
            turnEnd = {
              kind: "error",
              code: "repeat_failure",
              message: `工具 ${outcome.name} 连续失败 ${FAIL_REPEAT_LIMIT} 次，已停止重试。请向用户说明错误情况并等待用户指示。`,
            };
            break;
          case "forced_delivery":
            // 保存成功后模型仍尝试继续验证/修改：强制收尾交付
            this.logger.warn(
              `[Agent] turn=${turn} 强制交付（save 成功后拦截 ${guardState.iterationBlockCount} 次迭代尝试）`,
            );
            turnEnd = { kind: "completed" };
            break;
          case "clarify":
            // 挂起：interrupt 事件已在 step 内发送，turn 不记结束、不发收尾事件
            return;
        }
        if (turnEnd) break;
      }
    } catch (error) {
      // 结构化错误分类：AbortError → aborted；其余 → error+code
      if (signal.aborted) {
        turnEnd = {
          kind: "aborted",
          reason: String(signal.reason ?? "aborted"),
        };
      } else {
        turnEnd = {
          kind: "error",
          code: "llm_error",
          message: errorChainText(error),
        };
      }
    }

    // 结构化 turn 结束记录（clarify 挂起时 turnEnd 为 null，不记录）
    if (turnEnd) {
      this.appendEvent(session, "turn_end", { turn, reason: turnEnd });
      this.logger.log(`[Agent] turn=${turn} ended kind=${turnEnd.kind}`);
    }

    // SSE 收尾事件（aborted 时旧连接通常已被前端放弃，sseEvent 内部有防御）
    switch (turnEnd?.kind) {
      case "completed":
        this.sseEvent(res, { type: "done", final: lastAssistantText(session) });
        this.sseLine(res, `e:${JSON.stringify({ type: "finish" })}`);
        break;
      case "max_tokens":
        if (maxTokensStreak >= 2) {
          // 连续截断终止：error 事件（不发 e:finish，与旧实现一致）
          this.sseEvent(res, {
            type: "error",
            code: "max_tokens",
            message: turnEnd.message,
          });
        } else {
          // 粘性完成：done + warning 让前端提示用户
          this.sseEvent(res, {
            type: "done",
            final: lastAssistantText(session),
            warning:
              "部分输出可能因达到 token 上限被截断，如需完整结果请简化需求。",
          });
          this.sseLine(res, `e:${JSON.stringify({ type: "finish" })}`);
        }
        break;
      case "step_limit": {
        const msg = `Agent 单轮执行超过 ${turnEnd.maxSteps} 步，已停止。请简化需求或提供更明确的信息后重试。`;
        this.sseEvent(res, {
          type: "step_limit",
          maxSteps: turnEnd.maxSteps,
          message: msg,
        });
        this.sseEvent(res, { type: "error", code: "step_limit", message: msg });
        break;
      }
      case "error": {
        if (turnEnd.code === "loop_detected") {
          this.sseEvent(res, {
            type: "loop_detected",
            message: turnEnd.message,
          });
        }
        this.sseEvent(res, {
          type: "error",
          code: turnEnd.code,
          message: turnEnd.message,
        });
        break;
      }
      case "aborted":
        this.sseEvent(res, { type: "aborted" });
        break;
      case undefined:
        break; // clarify 挂起：interrupt 事件已发，无需收尾
    }
  }

  /**
   * 执行一步：一次 LLM 流式调用 + 工具顺序执行（对齐 Harness step）
   *
   * LLM 流 chunk 级检查 signal 与 res.destroyed——「思考中打断」即刻生效。
   * abort 抛出的 AbortError 由本服务创建并向上传播，turn 层分类为 aborted。
   * 半截 AI 输出不落 history（流被打断时直接抛，不 push AIMessage）。
   *
   * @param session - 会话
   * @param phase - 本 driver 的 running phase
   * @param res - SSE 响应
   * @param loopGuard - 死循环检测状态
   * @param guardState - turn 级交付守卫状态（save 成功后拦截迭代工具）
   * @returns StepOutcome（null = 继续下一步）
   */
  private async step(
    session: Session,
    phase: Extract<Phase, { kind: "running" }>,
    res: SSEResponse,
    loopGuard: LoopGuard,
    guardState: TurnGuardState,
  ): Promise<StepOutcome> {
    const signal = phase.abort.signal;
    signal.throwIfAborted();
    const step = phase.step + 1;
    phase.step = step;
    const turn = phase.turn;

    this.logger.log(`[Agent] turn=${turn} step=${step} llm_call`);
    this.appendEvent(session, "step_start", { turn, step });

    // 组装消息：系统提示词 + 滑动窗口 + 孤儿 ToolMessage 自愈
    const messages = this.buildMessages(session);

    // LLM 流式调用：chunk 累积进 full（AIMessageChunk.concat 组装完整 tool_calls）
    let full: AIMessageChunk | null = null;
    // 每步首个文本/思考 chunk 前发段开始标记（前端按 step 分段渲染气泡）
    let stepTextStarted = false;
    const ensureStepTextStarted = (): void => {
      if (!stepTextStarted) {
        stepTextStarted = true;
        this.sseEvent(res, { type: "step_text_start", step });
      }
    };
    const stream = await modelWithTools.stream(messages, { signal });
    for await (const chunk of stream) {
      // 检查点 1：AbortSignal（「打断并发送」的主路径，比 res.destroyed 更及时）
      signal.throwIfAborted();
      // 检查点 2：客户端断开（close 事件已补发 abort，这里即时兜底）
      if (res.destroyed) {
        phase.abort.abort("client-disconnect");
        signal.throwIfAborted();
      }
      full = full ? full.concat(chunk) : chunk;

      // 思考内容增量（DeepSeek reasoning_content；当前模型已关思考，防御保留）
      const reasoning = chunk.additional_kwargs?.reasoning_content;
      if (typeof reasoning === "string" && reasoning.length > 0) {
        ensureStepTextStarted();
        this.sseEvent(res, {
          type: "reasoning_delta",
          content: reasoning,
          step,
        });
      }
      // 文本增量（走 reasoning_delta 通道：中间叙述显示在过程气泡，
      // step 结束判定为最终回复时由 final_answer 事件升级为正文气泡）
      const text = extractTextContent(chunk.content);
      if (text) {
        ensureStepTextStarted();
        this.sseEvent(res, { type: "reasoning_delta", content: text, step });
      }
    }
    signal.throwIfAborted();

    // 组装完整 AI 消息并落 history（tool_calls 参数为完整 JSON 字符串）
    const rawToolCalls = full?.tool_calls ?? [];
    const toolCalls: PlannedCall[] = rawToolCalls.map((tc) => ({
      id: tc.id ?? `call_${randomUUID()}`,
      name: tc.name,
      args:
        typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args ?? {}),
    }));
    const content = full?.content ?? "";
    // 落 history 的 tool_calls.args 必须是对象（LangChain 约定）：
    // 存字符串会在下一轮 convertLangChainToolCallToOpenAI 中被再次
    // JSON.stringify，产生双转义畸形格式污染上下文，诱导模型模仿输出
    // {"arguments": "..."} 包装导致 zod 校验失败。
    session.history.push(
      new AIMessage({
        content,
        tool_calls:
          toolCalls.length > 0
            ? toolCalls.map((c) => ({
                id: c.id,
                name: c.name,
                args: parseToolArguments(c.args),
              }))
            : undefined,
      }),
    );

    const textContent = extractTextContent(content);
    this.appendEvent(session, "llm_call", {
      turn,
      step,
      preview: textContent.slice(0, 50),
    });
    this.appendEvent(session, "step_end", { turn, step });

    const finishReason =
      (full?.response_metadata as { finish_reason?: string } | undefined)
        ?.finish_reason ??
      (full?.additional_kwargs as { finish_reason?: string } | undefined)
        ?.finish_reason;

    // 空回复保护：无文本且无工具调用（静默空回复 bug 的根因拦截）
    if (!textContent && toolCalls.length === 0) {
      this.logger.warn(
        `[Agent] turn=${turn} step=${step} 空回复（无内容无工具调用）`,
      );
      return { kind: "completed" };
    }

    // max_tokens 粘性（Harness 语义）：截断的输出不可靠，不执行其 tool_calls
    if (finishReason === "length") {
      return { kind: "max_tokens" };
    }

    if (toolCalls.length === 0) {
      // 最终回复：无工具调用的步骤文本升级为正文气泡
      if (textContent) {
        this.sseEvent(res, { type: "final_answer", step });
      }
      return { kind: "completed" };
    }

    // 顺序执行工具（对齐 Harness executeToolCalls 的模型顺序提交）
    return this.executeToolCalls(
      session,
      phase,
      res,
      toolCalls,
      loopGuard,
      guardState,
    );
  }

  /**
   * 顺序执行一步的工具调用（对齐 Harness executeToolCalls）：
   * 模型顺序提交，结果以 ToolMessage 写回 history。abort 时未执行的调用
   * 由 buildMessages 自愈补位。死循环在第 4 次同参调用时拦截（不执行）。
   * clarify_question 的 __clarify 标记触发 turn 挂起。
   *
   * @param session - 会话
   * @param phase - 本 driver 的 running phase
   * @param res - SSE 响应
   * @param toolCalls - 模型顺序的工具调用
   * @param loopGuard - 死循环检测状态
   * @param guardState - turn 级交付守卫状态
   * @returns StepOutcome（null = 全部执行完，继续下一步）
   */
  private async executeToolCalls(
    session: Session,
    phase: Extract<Phase, { kind: "running" }>,
    res: SSEResponse,
    toolCalls: PlannedCall[],
    loopGuard: LoopGuard,
    guardState: TurnGuardState,
  ): Promise<StepOutcome> {
    const signal = phase.abort.signal;
    const turn = phase.turn;
    const step = phase.step;

    for (const call of toolCalls) {
      signal.throwIfAborted();
      const args = parseToolArguments(call.args);
      const inputKey = JSON.stringify(args);

      // 死循环检测：同一工具 + 同一参数连续调用，第 4 次相同调用拦截（不执行）
      if (
        loopGuard.lastToolName === call.name &&
        loopGuard.lastToolInput === inputKey
      ) {
        loopGuard.repeatCount += 1;
      } else {
        loopGuard.lastToolName = call.name;
        loopGuard.lastToolInput = inputKey;
        loopGuard.repeatCount = 0;
      }
      if (loopGuard.repeatCount >= LOOP_REPEAT_LIMIT) {
        const warning = `[系统拦截] ${call.name} 连续 4 次相同参数调用被判定为死循环，已强制停止。`;
        session.history.push(
          new ToolMessage({
            content: warning,
            tool_call_id: call.id,
            name: call.name,
          }),
        );
        // 注入下轮上下文：下次对话时 LLM 能看到循环警告
        session.inbox.nextStep.push(warning);
        this.logger.warn(
          `[Agent] loop_detected: ${call.name} ${inputKey.slice(0, 200)}`,
        );
        return { kind: "loop_detected", name: call.name, input: args };
      }

      // 交付守卫拦截：save 成功后禁止继续验证/修改（防"修到满意为止"循环）
      const blockTools = guardState.validationRequested
        ? DELIVERY_BLOCK_TOOLS_VALIDATION
        : DELIVERY_BLOCK_TOOLS;
      if (guardState.saveSucceeded && blockTools.has(call.name)) {
        guardState.iterationBlockCount += 1;
        const warning =
          guardState.iterationBlockCount >= 2
            ? "[系统强制停止] 工作流已保存成功，任务已完成。你已连续 2 次尝试继续验证/修改，本轮对话立即结束，请直接查看右侧面板的工作流与保存结果。"
            : "[系统拦截] 工作流已保存成功，任务已完成。请直接向用户总结交付（含 workflowId），不要再调用 batch_validate / update_workflow / plan_workflow / generate_workflow。";
        session.history.push(
          new ToolMessage({
            content: warning,
            tool_call_id: call.id,
            name: call.name,
          }),
        );
        this.logger.warn(
          `[Agent] turn=${turn} step=${step} 交付拦截: ${call.name}（第 ${guardState.iterationBlockCount} 次）`,
        );
        if (guardState.iterationBlockCount >= 2) {
          return { kind: "forced_delivery" };
        }
        continue; // 跳过该工具，继续执行同一步内其余调用
      }

      // 重复规划拦截：plan_workflow 超次数直接拦截（planId 已句柄化，无需重新规划）
      if (call.name === "plan_workflow") {
        guardState.planCallCount += 1;
        if (guardState.planCallCount > PLAN_CALL_LIMIT) {
          const warning =
            "[系统拦截] 本回合已多次调用 plan_workflow。不要重复规划：请基于已有 planId 调用 generate_workflow 继续，或直接向用户汇报当前进度。";
          session.history.push(
            new ToolMessage({
              content: warning,
              tool_call_id: call.id,
              name: call.name,
            }),
          );
          this.logger.warn(
            `[Agent] turn=${turn} step=${step} 重复规划拦截: plan_workflow（第 ${guardState.planCallCount} 次）`,
          );
          continue; // 跳过该工具
        }
      }

      // 工具开始事件（先发事件再执行，前端实时展示调用链）
      this.logger.log(
        `[Agent] turn=${turn} step=${step} tool_start ${call.name} ${inputKey.slice(0, 200)}`,
      );
      this.sseEvent(res, { type: "tool_start", name: call.name, input: args });
      this.appendEvent(session, "tool_start", {
        turn,
        step,
        name: call.name,
        input: args,
      });

      // 执行工具（withToolTimeout 已包装超时；signal 传入供工具内感知打断）
      let result: unknown;
      let toolError: unknown;
      try {
        result = await this.invokeTool(call.name, args, signal);
      } catch (error) {
        toolError = error;
      }
      signal.throwIfAborted();

      const outputText = toolError
        ? `工具执行失败: ${errorChainText(toolError)}`
        : stringifyToolOutput(result);

      this.logger.log(
        `[Agent] turn=${turn} step=${step} tool_end ${call.name} ${outputText.slice(0, 200)}`,
      );
      this.sseEvent(res, {
        type: "tool_end",
        name: call.name,
        output: outputText,
      });
      this.appendEvent(session, "tool_end", {
        turn,
        step,
        name: call.name,
        output: outputText.slice(0, 200),
      });

      // clarify 挂起检测：工具返回 __clarify 标记 → 占位 ToolMessage + 挂起状态
      // （resume 时占位被替换为「用户回答」，语义等价 LangGraph interrupt 返回值）
      if (!toolError && isClarifyMarker(result)) {
        session.history.push(
          new ToolMessage({
            content: "（等待用户回答中）",
            tool_call_id: call.id,
            name: call.name,
          }),
        );
        session.pendingClarify = {
          question: result.question,
          context: result.context,
        };
        this.logger.log(`[Agent] clarify: ${result.question.slice(0, 100)}`);
        this.sseEvent(res, {
          type: "interrupt",
          question: result.question,
          context: result.context,
          sessionId: session.id,
        });
        return {
          kind: "clarify",
          question: result.question,
          context: result.context,
        };
      }

      // 交付信号检测：save_to_coze 成功 → 本 turn 进入交付模式（后续迭代工具被拦截）
      if (
        !toolError &&
        call.name === "save_to_coze" &&
        /"saved"\s*:\s*true/.test(outputText)
      ) {
        guardState.saveSucceeded = true;
        this.logger.log(
          `[Agent] turn=${turn} step=${step} save 成功，进入交付模式`,
        );
      }

      // 连续失败拦截：同一工具连续失败 FAIL_REPEAT_LIMIT 次停止重试（防失败重试循环）
      if (toolError) {
        loopGuard.failStreak = loopGuard.lastFailed
          ? loopGuard.failStreak + 1
          : 1;
      } else {
        loopGuard.failStreak = 0;
      }
      loopGuard.lastFailed = !!toolError;
      if (loopGuard.failStreak >= FAIL_REPEAT_LIMIT) {
        const warning = `[系统拦截] 工具 ${call.name} 连续失败 ${FAIL_REPEAT_LIMIT} 次，已停止重试。请向用户汇报错误信息，等待用户指示。`;
        session.history.push(
          new ToolMessage({
            content: warning,
            tool_call_id: call.id,
            name: call.name,
          }),
        );
        this.logger.warn(
          `[Agent] turn=${turn} step=${step} 连续失败拦截: ${call.name}（第 ${loopGuard.failStreak} 次）`,
        );
        return { kind: "repeat_failure", name: call.name, input: args };
      }

      // 工具结果落 history（打断不丢失：直接写在权威记录里，无 checkpoint 机制）
      session.history.push(
        new ToolMessage({
          content: outputText,
          tool_call_id: call.id,
          name: call.name,
        }),
      );
    }
    return null;
  }

  /**
   * 按工具名调用注册工具
   *
   * @param name - 工具名
   * @param args - 解析后的参数对象
   * @param signal - driver 的 abort 信号（传入工具 invoke 配置）
   * @returns 工具返回结果
   */
  private async invokeTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const tool = (
      ALL_TOOLS as unknown as Array<{
        name: string;
        invoke: (input: unknown, config?: unknown) => Promise<unknown>;
      }>
    ).find((t) => t.name === name);
    if (!tool) throw new Error(`未知工具: ${name}`);
    return tool.invoke(args, { signal });
  }

  // ============================================
  // 消息组装与协议输出
  // ============================================

  /**
   * 组装 LLM 输入消息：系统提示词 + 历史滑动窗口 + 孤儿 ToolMessage 自愈
   *
   * 自愈（对齐 Harness appendSkippedToolCall）：AIMessage.tool_calls 未配对
   * ToolMessage 时补合成 aborted 结果——打断发生在工具执行中/LLM 输出中
   * 都会留下半截序列，此处统一修复，保证 OpenAI 兼容协议合法。
   *
   * @param session - 会话
   * @returns LLM 输入消息序列（SystemMessage 开头）
   */
  private buildMessages(session: Session): BaseMessage[] {
    const window = session.history.slice(-MAX_HISTORY_MESSAGES);
    // 裁剪窗口头的孤立 ToolMessage
    while (window.length > 0 && isToolMessage(window[0])) window.shift();

    const patched: BaseMessage[] = [];
    // 等待配对的 tool_calls（id → 调用）
    const pending = new Map<string, PlannedCall>();
    for (const msg of window) {
      if (isToolMessage(msg)) {
        pending.delete(msg.tool_call_id);
        patched.push(msg);
        continue;
      }
      if (isAIMessage(msg)) {
        // 自愈：修复历史遗留的畸形 tool_calls（args 为字符串的双转义
        // 污染）。LangChain 约定 args 为对象，字符串形态经
        // convertLangChainToolCallToOpenAI 的 JSON.stringify 会二次转义。
        let aiMsg: AIMessage = msg;
        const dirtyCalls = (aiMsg.tool_calls ?? []).filter(
          (c) => typeof c.args === "string",
        );
        if (dirtyCalls.length > 0) {
          aiMsg = new AIMessage({
            content: aiMsg.content,
            tool_calls: (aiMsg.tool_calls ?? []).map((c) =>
              typeof c.args === "string"
                ? { ...c, args: parseToolArguments(c.args) }
                : c,
            ),
            additional_kwargs: aiMsg.additional_kwargs,
            response_metadata: aiMsg.response_metadata,
            id: aiMsg.id,
          });
        }
        // 新 AI 消息前的未配对调用：上一工具序列已结束，补合成结果
        for (const [id] of pending) {
          patched.push(
            new ToolMessage({ content: TOOL_ABORTED_TEXT, tool_call_id: id }),
          );
        }
        pending.clear();
        patched.push(aiMsg);
        for (const call of aiMsg.tool_calls ?? []) {
          if (call.id) {
            pending.set(call.id, {
              id: call.id,
              name: call.name,
              args:
                typeof call.args === "string"
                  ? call.args
                  : JSON.stringify(call.args ?? {}),
            });
          }
        }
        continue;
      }
      // user/system：配对中断（防御，正常不会出现在工具序列中间）
      for (const [id] of pending) {
        patched.push(
          new ToolMessage({ content: TOOL_ABORTED_TEXT, tool_call_id: id }),
        );
      }
      pending.clear();
      patched.push(msg);
    }
    // 窗口尾部残余（被截断的 AIMessage 在窗口末尾）
    for (const [id] of pending) {
      patched.push(
        new ToolMessage({ content: TOOL_ABORTED_TEXT, tool_call_id: id }),
      );
    }
    return [new SystemMessage(SYSTEM_PROMPT), ...patched];
  }

  /**
   * 设置 SSE 响应头
   *
   * Content-Type 保持 text/event-stream：Vercel AI SDK 的 useChat
   * 内部用 fetch 读流按行解析，兼容此格式。
   */
  private setSSEHeaders(res: SSEResponse): void {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
  }

  /** 写一行 SSE 文本（客户端断开时静默跳过） */
  private sseLine(res: SSEResponse, line: string): void {
    if (!res.destroyed) res.write(`${line}\n`);
  }

  /** 写一个 d: 结构化事件 */
  private sseEvent(res: SSEResponse, data: Record<string, unknown>): void {
    this.sseLine(res, `d:${JSON.stringify(data)}`);
  }

  /** 参数校验失败等场景：直接输出 error 事件并结束流 */
  private failImmediately(res: SSEResponse, message: string): void {
    this.setSSEHeaders(res);
    this.sseEvent(res, { type: "error", message });
    res.end();
  }

  /**
   * 追加 Agent 事件日志（轻量版 session log）
   *
   * 追加式不可变日志：与 history（只保留最终结果）不同，
   * 事件日志保留中间状态时间线，可按 turn/step 过滤排查问题。
   * 上限 1000 条，超出淘汰最旧的条目。
   *
   * @param session - 会话
   * @param type - 事件类型
   * @param data - 事件数据
   */
  private appendEvent(
    session: Session,
    type: AgentEvent["type"],
    data: Record<string, unknown>,
  ): void {
    session.events.push({ timestamp: Date.now(), type, data });
    if (session.events.length > MAX_EVENTS) {
      session.events.splice(0, session.events.length - MAX_EVENTS);
    }
  }
}
