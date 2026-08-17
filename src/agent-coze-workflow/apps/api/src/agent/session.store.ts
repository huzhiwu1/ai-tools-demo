/**
 * SessionStore - 内存会话存储（对齐 DeepSeek Harness 架构）
 *
 * 职责：
 * 管理会话的权威状态：对话历史（BaseMessage[]）、Phase 状态机、Inbox 队列。
 * 不再持有 LangGraph graph/checkpointer——主循环由 ReactAgentService 自建，
 * 工具结果以 ToolMessage 直接写入 history，打断后不丢失。
 *
 * 关键细节：
 * - history 是唯一权威记录：AIMessage.tool_calls 与 ToolMessage 成对写入，
 *   半截序列（打断遗留）由 service 的 buildMessages 自愈补全
 * - Phase 状态机（Harness 语义）：idle 或 running，同一时刻最多一个 driver
 * - Inbox 分离：nextTurn 用户消息队列 / nextStep 系统注入队列（死循环警告等）
 * - Map<string, Session> 内存存储，重启即清（可接受）
 */

import type { BaseMessage } from "@langchain/core/messages";

/**
 * Phase 状态机（对齐 Harness agent.ts 的 Phase）：
 * - idle：无 driver 执行，lastTurn 记录最近完成的 turn
 * - running：driver 执行中，持有本 driver 的 abort 信号与 turn/step 计数
 *   wakeRequested 保留自 Harness 结构（本服务 HTTP 驱动模型下始终为 false）
 */
export type Phase =
  | { kind: "idle"; lastTurn: number }
  | {
      kind: "running";
      abort: AbortController;
      turn: number;
      step: number;
      wakeRequested: boolean;
    };

/**
 * Turn 结束原因（结构化，替代纯字符串错误）
 *
 * 借鉴 DeepSeek Harness：每个 turn 的退出路径都有明确 reason，
 * max_tokens 是粘性的——一旦某步命中，后续正常完成的 step 不能降级。
 * clarify 挂起时 turn 尚未结束，不记录 TurnEndReason。
 */
export type TurnEndReason =
  | { kind: "completed" }
  | { kind: "max_tokens"; message: string }
  | { kind: "aborted"; reason: string }
  | { kind: "error"; code: string; message: string }
  | { kind: "step_limit"; maxSteps: number };

/**
 * Agent 事件日志条目（轻量版 session log）
 *
 * 追加式不可变日志：与 history（只保留最终结果）不同，
 * 事件日志保留中间状态时间线，可按 turn/step 过滤排查问题。
 */
export interface AgentEvent {
  timestamp: number;
  type:
    | "turn_start"
    | "turn_end"
    | "step_start"
    | "step_end"
    | "tool_start"
    | "tool_end"
    | "llm_call"
    | "error"
    | "aborted";
  data: Record<string, unknown>;
}

/**
 * clarify 挂起状态：Agent 向用户提问后等待回答（自建主循环协议，
 * 替代 LangGraph interrupt）。回答通过 resume 接口写回 ToolMessage。
 */
export interface PendingClarify {
  question: string;
  context?: string;
}

/**
 * Inbox 消息队列（对齐 Harness Inbox 设计）
 *
 * - nextTurn：下一轮处理的用户消息队列
 * - nextStep：系统注入消息队列（如死循环拦截警告），下一轮 claim 时
 *   以 SystemMessage 注入，不污染用户消息序列
 *
 * 工具结果不走 Inbox：直接以 ToolMessage 写入 history（自建循环的
 * 优势——打断后工具结果不丢失，无需旧实现的摘要补偿机制）。
 */
export class Inbox {
  /** 下一轮处理的用户消息队列 */
  nextTurn: string[] = [];
  /** 系统注入消息队列（死循环警告等） */
  nextStep: string[] = [];

  get hasPending(): boolean {
    return this.nextTurn.length > 0 || this.nextStep.length > 0;
  }

  /** 取走下一轮用户消息（Harness claim 语义：整批取走） */
  claimTurn(): string[] {
    const claimed = [...this.nextTurn];
    this.nextTurn.length = 0;
    return claimed;
  }

  /** 取走系统注入消息 */
  claimStep(): string[] {
    const claimed = [...this.nextStep];
    this.nextStep.length = 0;
    return claimed;
  }

  clear(): void {
    this.nextTurn.length = 0;
    this.nextStep.length = 0;
  }
}

/**
 * 会话数据结构
 */
export interface Session {
  /** 会话 ID（前端传或首次自动生成） */
  id: string;
  /**
   * 权威对话历史（BaseMessage 序列）：
   * HumanMessage / AIMessage（含 tool_calls）/ ToolMessage 成对出现，
   * SystemMessage 为系统注入（上轮拦截警告等）
   */
  history: BaseMessage[];
  /** Phase 状态机：idle 或 running，同一时刻只有一个 driver 在执行 */
  phase: Phase;
  /** Inbox 消息队列（用户消息与系统注入分离） */
  inbox: Inbox;
  /** 追加式事件日志（上限 1000 条，超出淘汰最旧） */
  events: AgentEvent[];
  /** clarify 挂起状态（等待用户回答；新消息到达时作废） */
  pendingClarify: PendingClarify | null;
  /** 当前（或最近一次）driver 的完成 Promise，打断方 await 它等待收敛 */
  driverDone: Promise<void>;
  /** 创建时间戳 */
  createdAt: number;
}

/**
 * 内存会话存储
 *
 * 单例模式：整个应用共享一个 store 实例。
 */
class SessionStore {
  private sessions = new Map<string, Session>();

  /**
   * 创建会话
   *
   * @param sessionId - 可选的会话 ID，不传则自动生成
   * @returns 新创建的会话对象
   */
  create(sessionId?: string): Session {
    const session: Session = {
      id: sessionId ?? crypto.randomUUID(),
      history: [],
      phase: { kind: "idle", lastTurn: 0 },
      inbox: new Inbox(),
      events: [],
      pendingClarify: null,
      driverDone: Promise.resolve(),
      createdAt: Date.now(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * 获取会话
   *
   * @param sessionId - 会话 ID
   * @returns 会话对象，不存在返回 undefined
   */
  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * 删除会话
   *
   * @param sessionId - 会话 ID
   */
  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * 检查会话是否存在
   */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }
}

/** 全局单例 */
export const sessionStore = new SessionStore();
