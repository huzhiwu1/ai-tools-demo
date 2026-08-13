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
 * 会话数据结构
 */
export interface Session {
  /** 编译后的 ReAct Agent graph 实例 */
  graph: CompiledStateGraph<any, any, any, any, any>;
  /** 对话历史（简化格式，供日志和恢复使用） */
  messages: Array<{ role: "user" | "assistant"; content: string }>;
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
