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
  ExecuteDetailData,
} from "./types";
import { Logger } from "@nestjs/common";

/** 已知错误码 */
const ERR_NOT_LATEST = 777777759; // commit 过期 / 没拿锁
const REQUEST_TIMEOUT_MS = 10_000;
const LOCK_TTL_MS = 15 * 60 * 1000; // 15 分钟
const MAX_SAVE_RETRIES = 2;

/** 请求体/响应体日志最大长度（超出截断，避免大 schema 刷屏；create 等小接口可完整打印） */
const LOG_MAX_LEN = 2000;

export class CozeClient {
  private readonly baseUrl: string;
  private readonly sessionKey: string;
  private readonly spaceId: string;
  /** 编辑锁过期时间戳（ms），0 表示无锁 */
  private lockExpireAt = 0;

  /** 日志器：CozeClient 是普通类（不依赖 DI），直接用上下文名 new Logger */
  private readonly logger = new Logger("CozeClient");

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
   * 查询执行结果（轮询用）
   *
   * 候选接口路径（按优先级尝试）：
   * 1. execute_detail
   * 2. execute_info（兜底）
   *
   * 若候选接口均返回 404/非 0 code，抛 CozeError 提示接口未打通。
   *
   * @param executeId - testRun 返回的 execute_id
   * @returns 执行状态和输出
   */
  async queryExecute(executeId: string): Promise<ExecuteDetailData> {
    const candidates = ["execute_detail", "execute_info"];

    for (const path of candidates) {
      try {
        const res = await this.request<ExecuteDetailData>(path, {
          execute_id: executeId,
        });
        // 接口返回了数据，提取有效字段
        return this.normalizeExecuteResult(
          res.data as unknown as Record<string, unknown>,
        );
      } catch (e) {
        // 最后一个候选也失败，统一抛错
        const isLast = path === candidates[candidates.length - 1];
        if (isLast) {
          throw new Error(
            `CozeError: 执行详情接口未打通，需在平台 DevTools 抓包确认路径。` +
              `已尝试: ${candidates.join(", ")}。错误: ${(e as Error).message}`,
          );
        }
        // 继续尝试下一个候选
      }
    }

    throw new Error("CozeError: queryExecute 无可用候选接口");
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

  /**
   * 获取平台资源库中的数据库列表（res_type=7）
   *
   * 接口契约见 docs/coze-platform/platform-facts.md 第二节：
   * POST /api/plugin_api/library_resource_list，返回 resource_list[]。
   * res_id 即 database 节点的 databaseInfoID（不能臆造）。
   *
   * @returns 数据库资源列表（name + resId + desc）
   */
  async listDatabases(): Promise<
    Array<{ name: string; resId: string; desc: string }>
  > {
    const res = await this.request<{
      resource_list: Array<{ name?: string; res_id?: string; desc?: string }>;
    }>(
      "plugin_api/library_resource_list",
      {
        user_filter: 0,
        res_type_filter: [7],
        name: "",
        publish_status_filter: 0,
        space_id: this.spaceId,
        size: 15,
        owner_ids: [],
        desc: "",
        res_id: "",
      },
      "/api/",
    );
    return (res.data.resource_list ?? []).map((item) => ({
      name: item.name ?? "",
      resId: item.res_id ?? "",
      desc: item.desc ?? "",
    }));
  }

  // ============================================
  // 私有方法
  // ============================================

  /**
   * 统一 HTTP 请求
   *
   * @param path - API 路径（如 "create"），自动拼接 urlPrefix
   * @param body - 请求体
   * @param urlPrefix - 接口前缀（默认 /api/workflow_api/；资源库等外部接口传 /api/）
   */
  private async request<T>(
    path: string,
    body: unknown,
    urlPrefix = "/api/workflow_api/",
  ): Promise<CozeApiResponse<T>> {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    // 请求前：info 级别（默认可见），记路径 + 完整 body（敏感字段已脱敏）
    this.logger.log(`[CozeAPI] -> ${path} body=${this.summarize(body)}`);

    try {
      const res = await fetch(`${this.baseUrl}${urlPrefix}${path}`, {
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
        // 业务失败：warn 级别，记 code + msg
        this.logger.warn(
          `[CozeAPI] !! ${path} code=${json.code} msg=${json.msg} ${Date.now() - start}ms`,
        );
        throw new Error(`CozeError[${json.code}]: ${json.msg}`);
      }

      // 响应成功：info 级别，记路径 + 耗时 + code + 返回数据（完整 JSON）
      this.logger.log(
        `[CozeAPI] <- ${path} code=${json.code} ${Date.now() - start}ms data=${this.summarize(json.data ?? {})}`,
      );
      return json;
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        // 网络超时：error 级别
        this.logger.error(
          `[CozeAPI] ✗ ${path} 请求超时 ${Date.now() - start}ms`,
        );
        throw new Error(`CozeError: 请求超时 (${path})`);
      }
      // 已经是 CozeError 格式的直接抛（warn 日志已在业务失败分支打过）
      if (e instanceof Error && e.message.startsWith("CozeError")) {
        throw e;
      }
      // 网络异常：error 级别，记路径 + 错误
      this.logger.error(`[CozeAPI] ✗ ${path} ${(e as Error).message}`);
      throw new Error(
        `CozeError: 网络异常 (${path}) - ${(e as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 请求/响应体摘要：转 JSON 字符串，敏感字段脱敏，超过 2000 字符截断
   *
   * 敏感字段（session_key / token / api_key 等）只保留前 8 位 + 长度，
   * 防止认证信息完整泄露到日志（脱敏铁律）。
   */
  private summarize(body: unknown): string {
    const json = JSON.stringify(body, (key, value) => {
      if (
        key &&
        /session_key|api_?key|token|secret|password/i.test(key) &&
        typeof value === "string"
      ) {
        return `${value.slice(0, 8)}...(len=${value.length})`;
      }
      return value;
    });
    return json.length > LOG_MAX_LEN
      ? `${json.slice(0, LOG_MAX_LEN)}...(len=${json.length})`
      : json;
  }

  /**
   * 规整执行结果字段
   *
   * 平台返回的字段名可能不统一（如 status 可能是 execute_status、state 等），
   * 本方法做兼容映射，并递归提取输出值。
   */
  private normalizeExecuteResult(
    raw: Record<string, unknown>,
  ): ExecuteDetailData {
    const status =
      (raw.status as string) ??
      (raw.execute_status as string) ??
      (raw.state as string) ??
      "unknown";

    const output = this.findOutput(raw);

    return {
      status,
      output,
      error: (raw.error as string) ?? (raw.error_msg as string),
      duration: (raw.duration as number) ?? (raw.cost as number),
    };
  }

  /**
   * 递归查找第一个非空 output 值
   *
   * 平台可能将输出嵌套在 data.output、result.output 等路径中，
   * 递归查找以兼容不同接口返回格式。
   */
  private findOutput(obj: unknown, depth = 0): unknown {
    if (depth > 5 || obj === null || obj === undefined) return undefined;

    if (typeof obj === "object" && !Array.isArray(obj)) {
      const record = obj as Record<string, unknown>;

      // 优先命中 output / result 字段
      if (
        "output" in record &&
        record.output !== null &&
        record.output !== undefined
      ) {
        return record.output;
      }
      if (
        "result" in record &&
        record.result !== null &&
        record.result !== undefined
      ) {
        return record.result;
      }

      // 递归搜索子对象
      for (const key of Object.keys(record)) {
        if (key === "status" || key === "error" || key === "duration") continue;
        const found = this.findOutput(record[key], depth + 1);
        if (found !== undefined) return found;
      }
    }

    return undefined;
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
