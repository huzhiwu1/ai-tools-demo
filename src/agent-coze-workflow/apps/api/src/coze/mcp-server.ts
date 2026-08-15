/**
 * Coze MCP Server —— 标准 MCP（Model Context Protocol）包装
 *
 * 职责：
 * 将 CozeClient 的工作流操作（创建/保存/试运行/列表/元信息/schema 转换）
 * 暴露为标准 MCP 工具，供 MCP 客户端（LangGraph agent、Qoder、Claude、
 * Codex 等）通过协议调用，而不是直接 HTTP 调用。
 *
 * 启动方式（stdio）：
 *   pnpm --filter @coze-workflow/api mcp
 *
 * 工具列表：
 * - coze_create_workflow   创建工作流骨架
 * - coze_save_workflow     保存工作流（接受项目 CozeWorkflow 对象或平台 schema 字符串）
 * - coze_test_run          试运行工作流
 * - coze_list_workflows    工作流列表
 * - coze_update_meta       更新名称/描述
 * - coze_get_schema        获取工作流最新 schema + commit
 * - coze_convert_schema    项目格式 → 平台格式（纯本地，不调 API）
 *
 * 依赖注入方式：本文件直接读取 .env 构造 CozeClient（与 NestJS 模块解耦），
 * 这样 MCP server 可以独立于 HTTP 服务运行。
 */
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CozeClient } from "./coze.client";
import { convertToPlatformSchema } from "./schema-converter";
import type { CozeWorkflow } from "@coze-workflow/workflow-schema";

// 定位项目根 .env（兼容 tsx src 模式 / node dist 模式 / pnpm --filter cwd）
const envCandidates = [
  path.resolve(process.cwd(), "../../.env"), // pnpm --filter: cwd=apps/api -> 项目根
  path.resolve(__dirname, "../../../../.env"), // tsx: apps/api/src/mcp -> 项目根；dist: apps/api/dist/mcp -> 项目根
  path.resolve(process.cwd(), "../.env"),
  path.resolve(process.cwd(), ".env"),
];
for (const envPath of envCandidates) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    break;
  }
}

function getConfig() {
  const baseUrl = process.env.COZE_API_BASE_URL ?? "";
  const sessionKey = process.env.COZE_SESSION_KEY ?? "";
  const spaceId = process.env.COZE_SPACE_ID ?? "";
  if (!baseUrl || !sessionKey || !spaceId) {
    throw new Error(
      "MCP Server 缺少 Coze 配置：请检查 .env 中 COZE_API_BASE_URL / COZE_SESSION_KEY / COZE_SPACE_ID",
    );
  }
  return { baseUrl, sessionKey, spaceId };
}

export function createCozeMcpServer(client?: CozeClient): McpServer {
  const coze = client ?? new CozeClient(getConfig());

  const server = new McpServer({
    name: "coze-workflow-mcp",
    version: "1.0.0",
  });

  // ---------- 创建工作流 ----------
  server.registerTool(
    "coze_create_workflow",
    {
      description: "在 Coze 平台创建空白工作流骨架，返回 workflow_id",
      inputSchema: {
        name: z.string().describe("工作流名称"),
        desc: z.string().describe("工作流描述"),
      },
    },
    async ({ name, desc }) => {
      try {
        const workflowId = await coze.createWorkflow(name, desc);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ workflowId }) },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: (e as Error).message }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ---------- 保存工作流 ----------
  server.registerTool(
    "coze_save_workflow",
    {
      description:
        "保存工作流到 Coze 平台。schema 可传项目 CozeWorkflow 对象（自动转换）或平台内部 schema JSON 字符串",
      inputSchema: {
        workflowId: z.string().describe("目标工作流 ID"),
        schema: z
          .union([z.string(), z.record(z.string(), z.unknown())])
          .describe("项目 CozeWorkflow 对象或平台 schema JSON 字符串"),
        spaceId: z.string().optional().describe("覆盖空间 ID（默认用 .env）"),
      },
    },
    async ({ workflowId, schema, spaceId }) => {
      try {
        const schemaStr =
          typeof schema === "string"
            ? schema
            : convertToPlatformSchema(schema as unknown as CozeWorkflow);
        const client = spaceId
          ? new CozeClient({ ...getConfig(), spaceId })
          : coze;
        await client.saveWorkflow(workflowId, schemaStr);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ workflowId, saved: true }),
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: (e as Error).message }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ---------- 试运行 ----------
  server.registerTool(
    "coze_test_run",
    {
      description: "试运行工作流，返回 execute_id",
      inputSchema: {
        workflowId: z.string(),
        input: z.record(z.string(), z.unknown()).describe("工作流输入参数对象"),
      },
    },
    async ({ workflowId, input }) => {
      try {
        const executeId = await coze.testRun(workflowId, input);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ executeId }) },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: (e as Error).message }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ---------- 工作流列表 ----------
  server.registerTool(
    "coze_list_workflows",
    {
      description: "获取工作流列表（library_resource_list 接口，cursor 分页）",
      inputSchema: {
        size: z.number().int().positive().default(15),
        cursor: z.string().optional(),
      },
    },
    async ({ size, cursor }) => {
      try {
        const list = await coze.listWorkflows(size, cursor);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(list) }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: (e as Error).message }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ---------- 更新元信息 ----------
  server.registerTool(
    "coze_update_meta",
    {
      description: "更新工作流名称/描述（不走 save，不影响 schema）",
      inputSchema: {
        workflowId: z.string(),
        name: z.string().describe("新名称（字母开头，字母数字下划线）"),
        desc: z.string().describe("新描述"),
      },
    },
    async ({ workflowId, name, desc }) => {
      try {
        await coze.updateMeta(workflowId, name, desc);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ workflowId, updated: true }),
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: (e as Error).message }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ---------- 获取 schema ----------
  server.registerTool(
    "coze_get_schema",
    {
      description: "获取工作流最新 schema + submit_commit_id",
      inputSchema: { workflowId: z.string() },
    },
    async ({ workflowId }) => {
      try {
        const result = await coze.getSchema(workflowId);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: (e as Error).message }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ---------- 纯本地：格式转换 ----------
  server.registerTool(
    "coze_convert_schema",
    {
      description:
        "将项目 CozeWorkflow 格式转为平台内部 schema JSON 字符串（纯本地，不调 API）",
      inputSchema: {
        workflow: z
          .record(z.string(), z.unknown())
          .describe("项目 CozeWorkflow 对象"),
      },
    },
    async ({ workflow }) => {
      try {
        const schemaStr = convertToPlatformSchema(
          workflow as unknown as CozeWorkflow,
        );
        return {
          content: [{ type: "text" as const, text: schemaStr }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: (e as Error).message }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}

// 直接运行（node dist/mcp/mcp-server.js）时启动 stdio server
if (require.main === module) {
  const server = createCozeMcpServer();
  const transport = new StdioServerTransport();
  server.connect(transport).then(() => {
    console.error("[Coze MCP Server] stdio transport 已启动");
  });
}
