/**
 * CozeClient - Coze 平台 API 客户端
 *
 * 职责：
 * 封装对私有 Coze Studio 平台（coze.dev1.dachensky.com）的 API 调用，
 * 包括工作流创建、编辑锁、schema 拉取、保存、试运行等完整生命周期操作。
 *
 * 流程：
 * 1. create → 建工作流骨架，拿到 workflow_id
 * 2. acquireEditLock → 获取 15 分钟编辑锁（没有它 save 会报 777777759）
 * 3. getSchema → 拉取最新 schema + submit_commit_id
 * 4. saveWorkflow → 提交 schema（每次 save 前自动重新 getSchema 拿最新 commit）
 * 5. testRun → 试运行
 *
 * 关键细节：
 * - 认证方式：Cookie session_key（PAT 不被接受），附带 Agw-Js-Conv + x-requested-with
 * - 所有请求 10s 超时，使用原生 fetch（零依赖）
 * - save 时若返回 777777759（commit 过期），自动重试（重新拿锁 + schema + save，最多 2 次）
 * - 类内维护 lockExpireAt，save 前检查锁是否过期，过期自动重新 acquire
 * - 所有错误统一抛 Error("CozeError[code]: msg")
 */
import type {
  CozeClientConfig,
  CozeApiResponse,
  CreateWorkflowData,
  EditLockData,
  CanvasData,
  TestRunData,
} from "./types";

/** 已知错误码 */
const ERR_NOT_LATEST = 777777759; // commit 过期 / 没拿锁
const REQUEST_TIMEOUT_MS = 10_000;
const LOCK_TTL_MS = 15 * 60 * 1000; // 15 分钟
const MAX_SAVE_RETRIES = 2;

export class CozeClient {
  private readonly baseUrl: string;
  private readonly sessionKey: string;
  private readonly spaceId: string;
  /** 编辑锁过期时间戳（ms），0 表示无锁 */
  private lockExpireAt = 0;

  constructor(config: CozeClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.sessionKey = config.sessionKey;
    this.spaceId = config.spaceId;
  }

  // ============================================
  // 公开 API
  // ============================================

  /**
   * 创建工作流
   *
   * @returns workflow_id
   */
  async createWorkflow(name: string, desc: string): Promise<string> {
    const res = await this.request<CreateWorkflowData>("create", {
      name,
      desc,
      icon_uri: "",
      space_id: this.spaceId,
      flow_mode: 2,
    });
    return res.data.workflow_id;
  }

  /**
   * 获取编辑锁
   *
   * 15 分钟有效期，类内记录过期时间。
   *
   * @returns remaining_ttl（秒）
   */
  async acquireEditLock(workflowId: string): Promise<number> {
    const res = await this.request<EditLockData>("edit_lock", {
      workflow_id: workflowId,
      space_id: this.spaceId,
      action: "acquire",
    });
    this.lockExpireAt = Date.now() + LOCK_TTL_MS;
    return res.data.remaining_ttl;
  }

  /**
   * 获取工作流最新 schema + submit_commit_id
   *
   * 内部自动检查编辑锁，过期则重新 acquire。
   */
  async getSchema(
    workflowId: string,
  ): Promise<{ schemaJson: string; submitCommitId: string }> {
    await this.ensureLock(workflowId);

    const res = await this.request<CanvasData>("canvas", {
      workflow_id: workflowId,
      space_id: this.spaceId,
    });
    return {
      schemaJson: res.data.workflow.schema_json,
      submitCommitId: res.data.vcs_data.submit_commit_id,
    };
  }

  /**
   * 保存工作流
   *
   * 流程：ensureLock → getSchema（拿最新 commit）→ save。
   * 若返回 777777759（commit 过期），自动重试最多 2 次。
   */
  async saveWorkflow(workflowId: string, schemaJson: string): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_SAVE_RETRIES; attempt++) {
      try {
        await this.ensureLock(workflowId);
        const { submitCommitId } = await this.getSchema(workflowId);

        await this.request("save", {
          workflow_id: workflowId,
          schema: schemaJson,
          space_id: this.spaceId,
          submit_commit_id: submitCommitId,
          ignore_status_transfer: true,
        });
        return; // 成功
      } catch (e) {
        lastError = e as Error;
        const isCommitExpired =
          e instanceof Error && e.message.includes(String(ERR_NOT_LATEST));
        if (!isCommitExpired || attempt >= MAX_SAVE_RETRIES) {
          throw e;
        }
        // commit 过期：清除锁状态，下一轮重试
        this.lockExpireAt = 0;
      }
    }

    throw lastError ?? new Error("CozeError: save 重试耗尽");
  }

  /**
   * 试运行工作流
   *
   * @returns execute_id
   */
  async testRun(
    workflowId: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    const res = await this.request<TestRunData>("test_run", {
      workflow_id: workflowId,
      input,
      space_id: this.spaceId,
    });
    return res.data.execute_id;
  }

  /**
   * 更新工作流元信息（名称 / 描述）
   */
  async updateMeta(
    workflowId: string,
    name: string,
    desc: string,
  ): Promise<void> {
    await this.request("update_meta", {
      workflow_id: workflowId,
      space_id: this.spaceId,
      name,
      desc,
      icon_uri: "",
    });
  }

  /**
   * 获取工作流列表
   */
  async listWorkflows(page = 1, size = 20): Promise<unknown[]> {
    const res = await this.request<{ workflow_list: unknown[] }>(
      "workflow_list",
      {
        space_id: this.spaceId,
        page,
        size,
      },
    );
    return res.data.workflow_list;
  }

  // ============================================
  // 私有方法
  // ============================================

  /**
   * 统一 HTTP 请求
   *
   * @param path - API 路径（如 "create"），自动拼接 /api/workflow_api/
   */
  private async request<T>(
    path: string,
    body: unknown,
  ): Promise<CozeApiResponse<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(`${this.baseUrl}/api/workflow_api/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `session_key=${this.sessionKey}`,
          "Agw-Js-Conv": "str",
          "x-requested-with": "XMLHttpRequest",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const json = (await res.json()) as CozeApiResponse<T>;

      if (json.code !== 0) {
        throw new Error(`CozeError[${json.code}]: ${json.msg}`);
      }

      return json;
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        throw new Error(`CozeError: 请求超时 (${path})`);
      }
      // 已经是 CozeError 格式的直接抛
      if (e instanceof Error && e.message.startsWith("CozeError")) {
        throw e;
      }
      throw new Error(
        `CozeError: 网络异常 (${path}) - ${(e as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 确保持有编辑锁
   *
   * 锁过期或未获取时自动重新 acquire。
   */
  private async ensureLock(workflowId: string): Promise<void> {
    if (Date.now() < this.lockExpireAt) return;
    await this.acquireEditLock(workflowId);
  }
}
