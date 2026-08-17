/**
 * [Tool] database - 数据库（知识库）操作工具
 *
 * 职责：
 * 封装 Coze 数据库全生命周期能力供 ReAct agent 调用：
 *   创建数据库（选空间）→ 上传文件 → 校验/导入 → 查进度 → 列表
 *
 * 用法（agent 视角）：
 *   1. database_list_spaces      先列出空间，让用户选放哪个
 *   2. database_create           创建库（表名小写字母开头，仅小写字母数字下划线）
 *   3. database_upload           上传 xlsx → tos_uri
 *   4. database_import           校验 + 导入数据
 *   5. database_progress         查导入进度
 *
 * ⚠️ 铁律（2026-08-17 实测）：
 * - creator_id 必须用 account/info/v2 的 user_id_str（不是 JWT 会话 id）
 * - 表名字段数必须与上传文件列数一致（否则 106000000 field number not match）
 * - database/add 返回在顶层 database_info；database/list 返回顶层 database_info_list
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { DatabaseClient } from "../../coze/database-client";

function client() {
  // 与 coze-client.ts 同源：.env 的 COZE_API_BASE_URL / COZE_SESSION_KEY
  const baseUrl = process.env.COZE_API_BASE_URL ?? "";
  const sessionKey = process.env.COZE_SESSION_KEY ?? "";
  if (!baseUrl || !sessionKey) {
    throw new Error("缺少 COZE_API_BASE_URL / COZE_SESSION_KEY（检查 .env）");
  }
  return new DatabaseClient({ baseUrl, sessionKey });
}

export const databaseListSpacesTool = tool(
  async () => {
    try {
      const spaces = await client().listSpaces();
      return JSON.stringify(
        spaces.map((s) => ({ id: s.id, name: s.name, role: s.role_name })),
      );
    } catch (e) {
      return `获取空间列表失败: ${(e as Error).message}`;
    }
  },
  {
    name: "database_list_spaces",
    description:
      "列出当前账号可用的 Coze 空间（Personal/公共/团队）。创建数据库前必须先调用此工具让用户选择要放入的空间。返回 [{id, name, role}]",
    schema: z.object({}),
  },
);

export const databaseCreateTool = tool(
  async ({ spaceId, tableName, tableDesc, fields }) => {
    try {
      const r = await client().createDatabase({
        spaceId,
        tableName,
        tableDesc,
        fields,
      });
      return JSON.stringify(r);
    } catch (e) {
      return `创建数据库失败: ${(e as Error).message}`;
    }
  },
  {
    name: "database_create",
    description:
      "创建数据库。tableName 只允许小写字母开头的小写字母/数字/下划线；fields 为字段列表 [{name, desc, type:1=字符串, must_required}]，字段必须与后续上传文件的列一一对应",
    schema: z.object({
      spaceId: z.string().describe("目标空间 ID（先调 database_list_spaces 获取）"),
      tableName: z.string().describe("表名：小写字母开头，仅小写字母数字下划线"),
      tableDesc: z.string().optional().describe("表描述"),
      fields: z
        .array(
          z.object({
            name: z.string(),
            desc: z.string().optional(),
            type: z.number().optional(),
            must_required: z.boolean().optional(),
          }),
        )
        .describe("字段列表，需与文件列一一对应"),
    }),
  },
);

export const databaseUploadTool = tool(
  async ({ filePath }) => {
    try {
      const tosUri = await client().uploadFile(filePath);
      return JSON.stringify({ tos_uri: tosUri });
    } catch (e) {
      return `上传文件失败: ${(e as Error).message}`;
    }
  },
  {
    name: "database_upload",
    description:
      "上传 xlsx 文件到平台，返回 tos_uri（后续导入用）。filePath 为本地文件绝对路径",
    schema: z.object({
      filePath: z.string().describe("本地 xlsx 文件绝对路径"),
    }),
  },
);

export const databaseImportTool = tool(
  async ({ databaseId, tosUri }) => {
    try {
      const r = await client().importData(databaseId, tosUri);
      return JSON.stringify(r);
    } catch (e) {
      return `导入数据失败: ${(e as Error).message}`;
    }
  },
  {
    name: "database_import",
    description:
      "校验 schema 并导入数据到数据库。databaseId 为创建时返回的 databaseId，tos_uri 为 database_upload 返回的值",
    schema: z.object({
      databaseId: z.string(),
      tosUri: z.string(),
    }),
  },
);

export const databaseDeleteTool = tool(
  async ({ databaseId }) => {
    try {
      await client().deleteDatabase(databaseId);
      return JSON.stringify({ databaseId, deleted: true });
    } catch (e) {
      return `删除数据库失败: ${(e as Error).message}`;
    }
  },
  {
    name: "database_delete",
    description: "删除数据库（不可恢复，谨慎调用）",
    schema: z.object({
      databaseId: z.string(),
    }),
  },
);

export const databaseProgressTool = tool(
  async ({ databaseId }) => {
    try {
      const r = await client().getProgress(databaseId);
      return JSON.stringify(r);
    } catch (e) {
      return `查询进度失败: ${(e as Error).message}`;
    }
  },
  {
    name: "database_progress",
    description: "查询数据库导入进度（progress 100=完成）",
    schema: z.object({
      databaseId: z.string(),
    }),
  },
);
