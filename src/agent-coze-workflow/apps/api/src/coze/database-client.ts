/**
 * DatabaseClient - Coze 数据库（知识库）客户端
 *
 * 封装数据库全生命周期 API（2026-08-17 实测）：
 *   创建库 → 上传文件 → 获取/校验表结构 → 导入数据 → 查进度
 *
 * 用法（与 CozeClient 同构，凭证注入）：
 *   const db = new DatabaseClient({ baseUrl, sessionKey });
 *   await db.createDatabase({ spaceId, name, desc, fields });
 *   const tosUri = await db.uploadFile("/path/to.xlsx");
 *   await db.importData(databaseId, tosUri);
 */
import { readFileSync } from "node:fs";

interface DatabaseClientConfig {
  baseUrl: string;
  sessionKey: string;
}

interface DbField {
  name: string;
  desc?: string;
  /** 1=字符串（实测），其他类型待平台确认 */
  type?: number;
  must_required?: boolean;
}

const DEFAULT_SHEET = { sheet_id: "0", header_line_idx: "0", start_line_idx: "1" };

export class DatabaseClient {
  private readonly baseUrl: string;
  private readonly sessionKey: string;

  constructor(config: DatabaseClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.sessionKey = config.sessionKey;
  }

  private async request<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `session_key=${this.sessionKey}`,
        "Agw-Js-Conv": "str",
        "x-requested-with": "XMLHttpRequest",
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { code: number; msg: string } & T;
    if (json.code !== 0) {
      throw new Error(`CozeError[${json.code}]: ${json.msg}`);
    }
    return json;
  }

  /** 获取真实 user_id_str（creator_id 必须用它，不是 JWT 会话 id） */
  async getUserId(): Promise<string> {
    const r = await this.request<{ data?: { user_id_str?: string } }>(
      "/api/passport/account/info/v2/",
      {},
    );
    return r.data?.user_id_str ?? "";
  }

  /** 空间列表（创建前让用户选空间） */
  async listSpaces(): Promise<
    Array<{ id: string; name: string; role_name?: string }>
  > {
    const r = await this.request<{ data?: { bot_space_list?: Array<{ id: string; name: string; role_name?: string }> } }>(
      "/api/playground_api/space/list",
      {},
    );
    return r.data?.bot_space_list ?? [];
  }

  /**
   * 创建数据库
   * ⚠️ tableName 只允许小写字母开头的小写字母/数字/下划线
   */
  async createDatabase(opts: {
    spaceId: string;
    tableName: string;
    tableDesc?: string;
    fields: DbField[];
    creatorId?: string;
  }): Promise<{ databaseId: string; actualTableName: string }> {
    const creatorId = opts.creatorId ?? (await this.getUserId());
    const r = await this.request<{
      database_info?: { id?: string; actual_table_name?: string };
    }>("/api/memory/database/add", {
      creator_id: creatorId,
      space_id: opts.spaceId,
      icon_uri: "default_icon/default_database_icon.png",
      table_name: opts.tableName,
      table_desc: opts.tableDesc ?? "",
      field_list: opts.fields.map((f) => ({
        name: f.name,
        desc: f.desc ?? "",
        type: f.type ?? 1,
        must_required: f.must_required ?? true,
      })),
      prompt_disabled: false,
    });
    const info = r.database_info ?? {};
    return { databaseId: info.id ?? "", actualTableName: info.actual_table_name ?? "" };
  }

  /** 上传文件（xlsx base64）→ tos_uri（BIZ_BOT_DATASET/... 路径） */
  async uploadFile(filePath: string): Promise<string> {
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "xlsx";
    const data = readFileSync(filePath).toString("base64");
    const r = await this.request<{ data?: { upload_url?: string; tos_uri?: string } }>(
      "/api/bot/upload_file",
      { file_head: { file_type: ext, biz_type: 2 }, data },
    );
    const url = r.data?.upload_url ?? r.data?.tos_uri ?? "";
    const m = /(BIZ_BOT_DATASET\/[^?&]+)/.exec(url);
    return m ? m[1] : url;
  }

  /** 获取表结构（table_data_type 1=结构预览） */
  async getSchema(databaseId: string, tosUri: string): Promise<unknown> {
    const r = await this.request<{ data?: unknown }>(
      "/api/memory/table_schema/get",
      {
        table_sheet: DEFAULT_SHEET,
        table_data_type: 1,
        database_id: databaseId,
        source_file: { tos_uri: tosUri },
      },
    );
    return r.data;
  }

  /** 校验 schema + 导入数据 */
  async importData(databaseId: string, tosUri: string): Promise<unknown> {
    const val = await this.request<{ data?: unknown }>(
      "/api/memory/table_schema/validate",
      {
        database_id: databaseId,
        source_file: { tos_uri: tosUri },
        table_sheet: DEFAULT_SHEET,
        table_type: 1,
      },
    );
    const imp = await this.request<{ data?: unknown }>(
      "/api/memory/table_file/submit",
      {
        database_id: databaseId,
        file_uri: tosUri,
        table_type: 1,
        table_sheet: DEFAULT_SHEET,
      },
    );
    return { validate: val.data, submit: imp.data };
  }

  /** 导入进度（progress 100=完成） */
  async getProgress(databaseId: string): Promise<{ progress: number }> {
    const r = await this.request<{ data?: { progress?: number; status_descript?: string } }>(
      "/api/memory/table_file/get_progress",
      { database_id: databaseId, table_type: 1 },
    );
    return { progress: r.data?.progress ?? -1 };
  }

  /** 数据库列表（顶层 database_info_list） */
  async listDatabases(spaceId: string): Promise<Array<{ id: string; table_name: string }>> {
    const r = await this.request<{
      database_info_list?: Array<{ id: string; table_name: string; table_desc?: string }>;
    }>("/api/memory/database/list", { space_id: spaceId, table_type: 2 });
    return r.database_info_list ?? [];
  }
}
