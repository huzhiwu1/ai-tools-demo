/**
 * [Tool] list_workflows - 搜索平台已有工作流
 *
 * 职责：
 * 包装 CozeClient.listWorkflows，按名称模糊搜索平台已有工作流，
 * 返回摘要数组（workflowId/name/desc），供 read_workflow 按 ID 读取详情。
 *
 * 流程：
 * 1. cozeClient.listWorkflows(size, cursor) → { workflows, cursor, hasMore }
 * 2. keyword 过滤（匹配 name，不区分大小写）
 * 3. 输出摘要 JSON（含 cursor/hasMore 分页信息）
 *
 * 关键细节：
 * - 用户没给 workflowId 时先调本工具搜索，拿到 ID 后再 read_workflow
 * - 只返回摘要（id/name/desc），不拉 schema，省 token
 * - 底层接口 2026-08-16 实测为 library_resource_list（cursor 分页，res_id=workflowId）
 * - hasMore=true 时 LLM 可带 cursor 翻页继续找
 * - 错误以字符串返回给 LLM（不抛异常给框架）
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { cozeClient } from "./coze-client";

export const listWorkflowsTool = tool(
  async ({ keyword, size, cursor, spaceId }) => {
    try {
      const {
        workflows,
        cursor: nextCursor,
        hasMore,
      } = await cozeClient.listWorkflows(size ?? 15, cursor, spaceId);

      // keyword 过滤在工具层做（底层不传 name 过滤，保持简单）
      const items = workflows.filter((item) => {
        if (!keyword) return true;
        const kw = keyword.toLowerCase();
        return item.name.toLowerCase().includes(kw);
      });

      if (items.length === 0) {
        return keyword
          ? `未找到名称包含「${keyword}」的工作流，请调整关键词重试`
          : "平台暂无工作流";
      }

      const result = {
        workflows: items,
        ...(hasMore
          ? {
              cursor: nextCursor,
              hasMore: true,
              提示: "还有更多结果，可带 cursor 翻页",
            }
          : { hasMore: false }),
      };
      return JSON.stringify(result, null, 2);
    } catch (e) {
      return `查询工作流列表失败: ${(e as Error).message}`;
    }
  },
  {
    name: "list_workflows",
    description:
      "搜索平台已有工作流列表，返回摘要（workflowId/name/desc）。" +
      "使用场景：用户没给 workflowId 时先按名称搜索，拿到 ID 后再调用 read_workflow 读取详情。" +
      "hasMore=true 时返回 cursor，可带 cursor 翻页继续查找。",
    schema: z.object({
      keyword: z.string().optional().describe("按名称模糊搜索（可选）"),
      size: z.number().optional().describe("每页条数，默认 15"),
      cursor: z
        .string()
        .optional()
        .describe("分页游标（上页返回的 cursor；不传=第一页）"),
      spaceId: z.string().optional().describe("目标空间 ID（缺省用 .env 的 COZE_SPACE_ID）"),
    }),
  },
);
