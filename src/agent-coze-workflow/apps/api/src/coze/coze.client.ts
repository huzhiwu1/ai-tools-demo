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
 * 4. validateTree → 保存前校验节点连通性（提前暴露端口未连接等问题）
 * 5. saveWorkflow → 提交 schema（每次 save 前自动重新 getSchema 拿最新 commit）
 * 6. testRun → 试运行（拿 execute_id）→ getProcess → 轮询执行结果
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
  ValidateTreeItem,
  GetProcessData,
} from "./types";
import { Logger } from "@nestjs/common";

/** 已知错误码 */
const ERR_NOT_LATEST = 777777759; // commit 过期 / 没拿锁
const ERR_RESOURCE_CHANGE = 777777770; // 资源变更通知失败（平台临时故障，可重试）
const REQUEST_TIMEOUT_MS = 10_000;
const LOCK_TTL_MS = 15 * 60 * 1000; // 15 分钟
const MAX_SAVE_RETRIES = 3;

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
  async createWorkflow(name: string, desc: string, spaceId?: string): Promise<string> {
    const sid = spaceId ?? this.spaceId;
    const res = await this.request<CreateWorkflowData>("create", {
      name,
      desc,
      icon_uri: "default_icon/default_workflow_icon.png", // 必须传默认工作流图标，空字符串会导致创建的资源不完整、无法打开
      space_id: sid,
      flow_mode: 0, // 0=工作流（样本实测）；2=智能体（会导致打开报"无法查看智能体"）
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
  async acquireEditLock(workflowId: string, spaceId?: string): Promise<number> {
    const sid = spaceId ?? this.spaceId;
    const res = await this.request<EditLockData>("edit_lock", {
      workflow_id: workflowId,
      space_id: sid,
      action: "acquire",
    });
    this.lockExpireAt = Date.now() + LOCK_TTL_MS;
    return res.data.remaining_ttl;
  }

  /**
   * 获取工作流最新 schema + submit_commit_id
   *
   * 默认内部检查编辑锁（过期则重新 acquire）；
   * 传 opts.noLock=true 时跳过锁检查（只读场景：read_workflow 拉 schema 展示用，
   * 避免读操作拿 15 分钟编辑锁阻塞其他会话的 save）。
   */
  async getSchema(
    workflowId: string,
    opts?: { noLock?: boolean; spaceId?: string },
  ): Promise<{ schemaJson: string; submitCommitId: string }> {
    const sid = opts?.spaceId ?? this.spaceId;
    if (!opts?.noLock) {
      await this.ensureLock(workflowId, sid);
    }

    const res = await this.request<CanvasData>("canvas", {
      workflow_id: workflowId,
      space_id: sid,
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
   * 若返回 777777759（commit 过期）或 777777770（资源变更通知失败），
   * 自动重试（最多 3 次），重试前清除锁状态并等待 2 秒。
   *
   * @returns 保存成功后返回最新 submit_commit_id（供调用方写入缓存，stale 检测用）
   */
  async saveWorkflow(
    workflowId: string,
    schemaJson: string,
    spaceId?: string,
  ): Promise<string> {
    const sid = spaceId ?? this.spaceId;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_SAVE_RETRIES; attempt++) {
      try {
        await this.ensureLock(workflowId, sid);
        const { submitCommitId } = await this.getSchema(workflowId, { spaceId: sid });

        await this.request("save", {
          workflow_id: workflowId,
          schema: schemaJson,
          space_id: sid,
          submit_commit_id: submitCommitId,
          ignore_status_transfer: true,
        });
        return submitCommitId; // 成功，返回最新 commit id
      } catch (e) {
        lastError = e as Error;
        const errMsg = (e as Error).message;
        const isRetryable =
          errMsg.includes(String(ERR_NOT_LATEST)) ||
          errMsg.includes(String(ERR_RESOURCE_CHANGE));
        if (!isRetryable || attempt >= MAX_SAVE_RETRIES) {
          throw e;
        }
        // 可重试错误：清除锁状态，等待 2 秒后重试
        this.lockExpireAt = 0;
        await new Promise((r) => setTimeout(r, 2000));
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
    spaceId?: string,
  ): Promise<string> {
    const sid = spaceId ?? this.spaceId;
    const res = await this.request<TestRunData>("test_run", {
      workflow_id: workflowId,
      input,
      space_id: sid,
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
    spaceId?: string,
  ): Promise<void> {
    const sid = spaceId ?? this.spaceId;
    await this.request("update_meta", {
      workflow_id: workflowId,
      space_id: sid,
      name,
      desc,
      icon_uri: "",
    });
  }

  /**
   * 校验工作流 schema 连通性（保存前校验）
   *
   * 接口：POST /api/workflow_api/validate_tree
   * 在 save 之前调用，可提前发现端口未连接、节点孤立等错误，
   * 避免"保存 → 平台报错 → 重试"的全链路往返。
   *
   * 校验失败时不抛异常，而是返回错误列表（让调用方决定怎么处理）。
   *
   * @param workflowId - 已创建的工作流 ID
   * @param schemaJson - 平台内部 schema JSON 字符串（与 save 的 schema 参数一致）
   * @returns 每个工作流的校验错误列表（无错误时为空数组）
   */
  async validateTree(
    workflowId: string,
    schemaJson: string,
  ): Promise<ValidateTreeItem[]> {
    const res = await this.request<ValidateTreeItem[]>("validate_tree", {
      workflow_id: workflowId,
      schema: schemaJson,
    });
    return res.data;
  }

  /**
   * 查询执行过程（轮询用）
   *
   * 接口：GET /api/workflow_api/get_process
   * 参数：workflow_id + execute_id（test_run 返回）+ space_id + need_async
   *
   * @param workflowId - 工作流 ID
   * @param executeId - testRun 返回的 execute_id
   * @returns 执行状态与各节点执行结果
   */
  async getProcess(
    workflowId: string,
    executeId: string,
    spaceId?: string,
  ): Promise<GetProcessData> {
    const sid = spaceId ?? this.spaceId;
    const res = await this.request<GetProcessData>(
      "get_process",
      {
        workflow_id: workflowId,
        space_id: sid,
        execute_id: executeId,
        need_async: true,
      },
      "/api/workflow_api/",
      "GET",
    );
    return res.data;
  }

  /**
   * 获取平台模型列表
   *
   * 接口：POST /api/bot/get_model_list
   * 返回可用模型的全量清单（含 audio/image/video 能力标记），
   * 供 get_platform_facts 工具动态查询，替代硬编码的 25 个模型列表。
   *
   * 关键约束：LLM 生成节点的 modelType + modleName 必须来自此列表。
   * 音频/视频任务必须选 audio_understanding=true 的模型。
   */
  async listModels(spaceId?: string): Promise<
    Array<{
      name: string;
      modelType: number;
      audio: boolean;
      image: boolean;
      video: boolean;
    }>
  > {
    const sid = spaceId ?? this.spaceId;
    const res = await this.request<{
      model_list: Array<{
        model_name: string;
        model_type: number;
        // 能力标记在 model_ability 对象里（实测 2026-08-14）
        model_ability?: {
          audio_understanding?: boolean;
          image_understanding?: boolean;
          video_understanding?: boolean;
        };
      }>;
    }>(
      "bot/get_model_list",
      {
        model: true,
        space_id: sid,
        cur_model_ids: ["201"],
      },
      "/api/",
    );
    return (res.data.model_list ?? []).map((m) => ({
      name: m.model_name,
      modelType: m.model_type,
      audio: m.model_ability?.audio_understanding ?? false,
      image: m.model_ability?.image_understanding ?? false,
      video: m.model_ability?.video_understanding ?? false,
    }));
  }

  /**
   * 获取工作流列表
   *
   * 接口：POST /api/plugin_api/library_resource_list（res_type_filter=[2]=工作流）
   * 2026-08-16 实测：旧接口 workflow_list 平台不支持；
   * 正确接口返回 resource_list[]，workflowId 在 res_id 字段，
   * 分页用 cursor + has_more（不是 page/size）。
   *
   * @param size - 每页条数（默认 15）
   * @param cursor - 分页游标（上页返回；不传=第一页）
   * @returns 工作流摘要列表 + 游标 + 是否还有下一页
   */
  async listWorkflows(
    size = 15,
    cursor?: string,
    spaceId?: string,
  ): Promise<{
    workflows: Array<{ workflowId: string; name: string; desc: string }>;
    cursor: string;
    hasMore: boolean;
  }> {
    const sid = spaceId ?? this.spaceId;
    const res = (await this.request<unknown>(
      "plugin_api/library_resource_list",
      {
        user_filter: 0,
        res_type_filter: [2],
        name: "",
        publish_status_filter: 0,
        space_id: sid,
        size,
        is_get_imageflow: true,
        owner_ids: [],
        desc: "",
        res_id: "",
        ...(cursor ? { cursor } : {}),
      },
      "/api/",
    )) as unknown as {
      data?: unknown;
      cursor?: string;
      has_more?: boolean;
      resource_list?: Array<{
        res_id?: string; // ⚠️ 工作流 ID 在 res_id，不是 id
        name?: string;
        desc?: string;
        res_type?: number; // 2=工作流
        publish_status?: number;
      }>;
    };
    // 实测（2026-08-16）该接口响应为顶层平铺（resource_list/cursor/has_more），
    // 无 data 包裹；若平台改回标准 CozeApiResponse 结构（data 嵌套），则读 res.data
    const raw = res.data as typeof res | undefined;
    const data = raw?.resource_list !== undefined ? raw : res;
    return {
      workflows: (data.resource_list ?? []).map((item) => ({
        workflowId: item.res_id ?? "",
        name: item.name ?? "",
        desc: item.desc ?? "",
      })),
      cursor: data.cursor ?? "",
      hasMore: data.has_more ?? false,
    };
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
  async listDatabases(spaceId?: string): Promise<
    Array<{ name: string; resId: string; desc: string }>
  > {
    const sid = spaceId ?? this.spaceId;
    const res = await this.request<{
      resource_list: Array<{ name?: string; res_id?: string; desc?: string }>;
    }>(
      "plugin_api/library_resource_list",
      {
        user_filter: 0,
        res_type_filter: [7],
        name: "",
        publish_status_filter: 0,
        space_id: sid,
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

  /**
   * 删除工作流
   *
   * 接口：POST /api/workflow_api/delete
   * 用于 validate_tree 校验失败时清理已创建的空壳工作流，避免平台上残留垃圾。
   *
   * @param workflowId - 要删除的工作流 ID
   */
  async deleteWorkflow(workflowId: string, spaceId?: string): Promise<void> {
    const sid = spaceId ?? this.spaceId;
    await this.request("delete", {
      workflow_id: workflowId,
      space_id: sid,
      action: 1,
    });
  }

  // ============================================
  // 私有方法
  // ============================================

  /**
   * 统一 HTTP 请求
   *
   * @param path - API 路径（如 "create"），自动拼接 urlPrefix
   * @param body - 请求体（GET 时作为查询参数拼接在 URL 上）
   * @param urlPrefix - 接口前缀（默认 /api/workflow_api/；资源库等外部接口传 /api/）
   * @param method - HTTP 方法（默认 POST；GET 时不传 body，参数拼查询字符串）
   */
  private async request<T>(
    path: string,
    body: unknown,
    urlPrefix = "/api/workflow_api/",
    method: "POST" | "GET" = "POST",
  ): Promise<CozeApiResponse<T>> {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    // GET 请求：参数拼接为查询字符串（body 为普通对象时）
    const isGet = method === "GET";
    const queryString =
      isGet && body && typeof body === "object"
        ? "?" +
          Object.entries(body as Record<string, unknown>)
            .map(
              ([k, v]) =>
                `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
            )
            .join("&")
        : "";

    // 请求前：info 级别（默认可见），记路径 + 完整 body（敏感字段已脱敏）
    this.logger.log(`[CozeAPI] -> ${path} body=${this.summarize(body)}`);

    try {
      const res = await fetch(
        `${this.baseUrl}${urlPrefix}${path}${queryString}`,
        {
          method,
          headers: {
            "Content-Type": "application/json",
            Cookie: `session_key=${this.sessionKey}`,
            "Agw-Js-Conv": "str",
            "x-requested-with": "XMLHttpRequest",
          },
          // GET 不传 body，避免 Content-Type 与空 body 冲突
          body: isGet ? undefined : JSON.stringify(body),
          signal: controller.signal,
        },
      );

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
   * 确保持有编辑锁
   *
   * 锁过期或未获取时自动重新 acquire。
   */
  private async ensureLock(workflowId: string, spaceId?: string): Promise<void> {
    const sid = spaceId ?? this.spaceId;
    if (Date.now() < this.lockExpireAt) return;
    await this.acquireEditLock(workflowId, sid);
  }
}
