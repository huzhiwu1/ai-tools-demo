/**
 * WorkflowCache - 服务端工作流缓存（内存 Map）
 *
 * 职责：
 * 缓存 CozeWorkflow（项目格式 JSON），支撑 update_workflow / save_to_coze 句柄化：
 * LLM 不再背诵完整 workflow JSON，只传 workflowId 句柄 + 修改指令，
 * 工具从缓存取工作流、改完 save 写回平台。
 *
 * 关键细节：
 * - TTL：条目超过 30 分钟未更新视为过期（get 时检查，过期返回 undefined 并淘汰）
 * - LRU 上限 200 条：超出淘汰最久未访问（lastAccessAt）
 * - dirty 语义：update_workflow 修改缓存对象后 markDirty；
 *   save_to_coze 成功后 clearDirty 并刷新 updatedAt
 * - commitId：记录平台 submit_commit_id，供 stale 检测（缓存与平台版本比对）
 * - 不落盘、不持久化：重启丢失可接受，miss 时从平台 getSchema 拉取兜底
 * - 模块级单例：所有工具/会话共享（多会话并发写同一 workflowId 由 stale 检测兜底）
 */

/** 缓存条目 */
export interface CachedWorkflow {
  /** CozeWorkflow 形状（meta/nodes/edges） */
  workflow: Record<string, unknown>;
  /** 最近更新时间戳（ms），TTL 基准 */
  updatedAt: number;
  /** 平台 submit_commit_id（stale 检测用） */
  commitId?: string;
  /** update 修改后未保存 */
  dirty: boolean;
  /** 写入方会话（并发警告用，可后续扩展） */
  ownerSessionId?: string;
  /** 最近访问时间戳（ms），LRU 淘汰基准 */
  lastAccessAt: number;
}

/** 条目 TTL：30 分钟 */
const TTL_MS = 30 * 60 * 1000;

/** LRU 上限 */
const MAX_ENTRIES = 200;

export class WorkflowCache {
  private readonly entries = new Map<string, CachedWorkflow>();

  /**
   * 读取缓存条目
   *
   * 过期条目（超过 TTL 未更新）直接淘汰并返回 undefined；
   * 命中时刷新 lastAccessAt（LRU 语义）。
   */
  get(workflowId: string): CachedWorkflow | undefined {
    const entry = this.entries.get(workflowId);
    if (!entry) return undefined;

    if (Date.now() - entry.updatedAt > TTL_MS) {
      this.entries.delete(workflowId);
      return undefined;
    }

    entry.lastAccessAt = Date.now();
    return entry;
  }

  /**
   * 写入（或覆盖）缓存条目
   *
   * @param workflowId - 工作流 ID（平台 platformWorkflowId）
   * @param workflow - CozeWorkflow 形状的 JSON 对象（引用存储，不做深拷贝）
   * @param opts.commitId - 平台 submit_commit_id（可选，stale 检测用）
   */
  set(
    workflowId: string,
    workflow: Record<string, unknown>,
    opts?: { commitId?: string },
  ): void {
    const now = Date.now();
    this.entries.set(workflowId, {
      workflow,
      updatedAt: now,
      lastAccessAt: now,
      commitId: opts?.commitId,
      dirty: false,
    });
    this.evictIfNeeded();
  }

  /** update_workflow 修改缓存对象后调用：标记 dirty（待保存） */
  markDirty(workflowId: string): void {
    const entry = this.entries.get(workflowId);
    if (!entry) return;
    entry.dirty = true;
    entry.updatedAt = Date.now();
  }

  /** save_to_coze 成功后调用：清除 dirty 并刷新 updatedAt */
  clearDirty(workflowId: string): void {
    const entry = this.entries.get(workflowId);
    if (!entry) return;
    entry.dirty = false;
    entry.updatedAt = Date.now();
  }

  /** 删除条目（测试/清理用） */
  remove(workflowId: string): void {
    this.entries.delete(workflowId);
  }

  /** 当前条目数（测试/观测用） */
  size(): number {
    return this.entries.size;
  }

  /** LRU 淘汰：超出上限时删除最久未访问的条目 */
  private evictIfNeeded(): void {
    while (this.entries.size > MAX_ENTRIES) {
      let oldestKey: string | undefined;
      let oldestAccess = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.entries) {
        if (entry.lastAccessAt < oldestAccess) {
          oldestAccess = entry.lastAccessAt;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }
}

/** 模块级单例：所有工具共享同一缓存 */
export const workflowCache = new WorkflowCache();
