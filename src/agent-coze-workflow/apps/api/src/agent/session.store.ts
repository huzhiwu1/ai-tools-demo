/**
 * SessionStore - 内存会话存储
 *
 * 职责：
 * 管理 ReAct Agent 会话（sessionId → graph + messages），
 * 每个会话持有独立的编译后 graph 实例（InMemorySaver 不支持跨实例恢复）。
 *
 * 流程：
 * 1. create(sessionId) → 创建新会话，存储 graph 实例
 * 2. get(sessionId) → 获取会话
 * 3. delete(sessionId) → 清理会话
 * 4. 自动生成 sessionId（crypto.randomUUID()）
 *
 * 关键细节：
 * - Map<string, Session> 内存存储，重启即清（可接受）
 * - 每个会话的 graph 实例持有独立的 InMemorySaver（checkpointer）
 * - sessionId 由前端传或首次自动生成
 */

import type { CompiledStateGraph } from "@langchain/langgraph";

/**
 * 会话消息（支持 user/assistant/tool 三种角色）
 *
 * tool 消息用于打断恢复记忆：用户打断后 graph 重建，checkpoint 中的
 * ToolMessage 全丢，但 inbox.nextStep 里的 tool 摘要可注入上下文，
 * 让 LLM 知道此前已完成的工具操作（read_file 的文件内容、save 的 workflowId 等）。
 */
export interface SessionMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  /** tool 消息专属：工具名（如 read_file / save_to_coze），便于重建时归类 */
  toolName?: string;
}

/**
 * Turn 结束原因（结构化，替代纯字符串错误）
 *
 * 借鉴 DeepSeek Harness：每个 turn 的退出路径都有明确 reason，
 * max_tokens 是粘性的——一旦某步命中，后续正常完成的 step 不能降级。
 */
export type TurnEndReason =
  | { kind: "completed" }
  | { kind: "max_tokens"; message: string }
  | { kind: "aborted"; reason: string }
  | { kind: "error"; code: string; message: string }
  | { kind: "step_limit"; maxSteps: number };

/**
 * Turn/Step 追踪状态（双层循环：turn = 用户交互边界，step = LLM 调用边界）
 *
 * 借鉴 DeepSeek Harness 的双层循环设计：
 * - 一次 handleChat = 1 个新 turn
 * - turn 内一次 LLM 调用 = 1 个 step（ReAct 循环含多次 step）
 * - step 超过 maxStepsPerTurn 判定为死循环，强制终止
 */
export interface AgentTurnState {
  /** 当前是第几轮对话 */
  currentTurn: number;
  /** 当前 turn 内是第几步 */
  currentStep: number;
  /** turn 结束原因（结构化；undefined = 尚未结束或 interrupt 等待回答） */
  turnEndReason?: TurnEndReason;
  /** 每 turn 最多步数（死循环保护上限） */
  maxStepsPerTurn: number;
}

/**
 * Inbox 消息队列（分离用户消息与工具结果）
 *
 * 借鉴 DeepSeek Harness 的 Inbox 设计：
 * - nextTurn：用户新消息队列（下一轮处理）
 * - nextStep：工具结果队列（当前轮下一步处理）
 * 好处：工具结果不污染用户消息序列；打断消息可精准插入当前步。
 */
export interface Inbox {
  /** 下一轮处理的用户消息队列（入站镜像，会话历史以 messages 为准） */
  nextTurn: SessionMessage[];
  /** 当前轮下一步处理的工具结果队列（打断恢复记忆来源） */
  nextStep: SessionMessage[];
}

/**
 * Agent 事件日志条目（轻量版 session log）
 *
 * 追加式不可变日志：与 messages（只保留最终结果）不同，
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
 * 会话数据结构
 */
export interface Session {
  /** 编译后的 ReAct Agent graph 实例 */
  graph: CompiledStateGraph<any, any, any, any, any>;
  /** 对话历史（user/assistant 最终结果；工具摘要已迁移到 inbox.nextStep） */
  messages: SessionMessage[];
  /** Phase 状态机：idle 或 running，同一时刻只有一个 driver 在执行 */
  phase: "idle" | "running";
  /** 当前活跃 driver 的 AbortController，用于从外部打断执行 */
  abortController: AbortController | null;
  /** 当前活跃 driver 的完成 Promise，handleChat 用 await 等旧 driver 退出 */
  runningPromise: Promise<void> | null;
  /** Turn/Step 追踪状态（双层循环） */
  turnState: AgentTurnState;
  /** Inbox 消息队列（用户消息与工具结果分离） */
  inbox: Inbox;
  /** 追加式事件日志（上限 1000 条，超出淘汰最旧） */
  events: AgentEvent[];
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
   * @param graph - 编译后的 graph 实例
   * @param sessionId - 可选的会话 ID，不传则自动生成
   * @returns sessionId
   */
  create(graph: Session["graph"], sessionId?: string): string {
    const id = sessionId ?? crypto.randomUUID();
    this.sessions.set(id, {
      graph,
      messages: [],
      phase: "idle",
      abortController: null,
      runningPromise: null,
      turnState: { currentTurn: 0, currentStep: 0, maxStepsPerTurn: 25 },
      inbox: { nextTurn: [], nextStep: [] },
      events: [],
      createdAt: Date.now(),
    });
    return id;
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
