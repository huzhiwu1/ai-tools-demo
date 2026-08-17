/**
 * [Tool] read_workflow - 读取平台已有工作流
 *
 * 职责：
 * 按 workflowId 从平台拉取最新 schema，反转换为项目格式并写入服务端缓存，
 * 输出人类可读的 Markdown 说明书（概览/拓扑图/节点清单/数据流/配置详情/验证报告）。
 *
 * 流程：
 * 1. cozeClient.getSchema(workflowId) → schemaJson + submitCommitId
 * 2. platformToProject(schemaJson) → 项目格式工作流
 * 3. workflowCache.set(workflowId, workflow, {commitId})（供 update/save 句柄化复用）
 * 4. workflowToDoc(workflow, {source:"platform"}) → 说明书
 * 5. scope=overview（默认）截断为 1-4 章节（省 token）；full 输出完整 7 章节
 * 6. 反转换 warnings 追加到文档末尾
 *
 * 关键细节：
 * - 读后写缓存：后续 update_workflow 只需传 workflowId，无需重读平台
 * - 修改工作流前先读：缓存会带上 commitId，update 时的 stale 检测据此比对
 * - 错误以字符串返回给 LLM（不抛异常给框架）
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { cozeClient } from "./coze-client";
import { workflowCache } from "../workflow-cache";
import { platformToProject } from "../../workflow-engine/platform-to-project";
import { workflowToDoc } from "../../workflow-engine/workflow-to-doc";

/** overview 截断位置：完整说明书的第 5 章起（配置详情/验证报告/透传区） */
const OVERVIEW_CUT_MARKER = "## 5. 配置详情";

export const readWorkflowTool = tool(
  async ({ workflowId, scope, spaceId }) => {
    try {
      // 1. 拉取平台最新 schema + submit_commit_id（stale 检测基线）
      // noLock：只读场景不拿 15 分钟编辑锁，避免阻塞其他会话的 save
      const { schemaJson, submitCommitId } = await cozeClient.getSchema(
        workflowId,
        { noLock: true, spaceId },
      );

      // 2. 反转换为项目格式
      const converted = platformToProject(schemaJson);

      // 3. 写缓存：供 update_workflow / save_to_coze 句柄化复用
      workflowCache.set(
        workflowId,
        converted.workflow as unknown as Record<string, unknown>,
        { commitId: submitCommitId },
      );

      // 4. 渲染说明书（full 才带透传区）
      const isFull = scope === "full";
      let doc = workflowToDoc(converted.workflow, {
        source: "platform",
        showRaw: isFull,
      });

      // 5. overview（默认）：只保留 1-4 章节，省 token
      if (!isFull) {
        const cutAt = doc.indexOf(OVERVIEW_CUT_MARKER);
        if (cutAt >= 0) {
          doc = doc.slice(0, cutAt).trimEnd();
        }
      }

      // 6. 反转换警告追加到末尾
      if (converted.warnings.length > 0) {
        doc +=
          "\n\n> ⚠️ 反转换警告:\n> " +
          converted.warnings.map((w) => "- " + w).join("\n> ");
      }

      return doc;
    } catch (e) {
      return `读取工作流失败: ${(e as Error).message}`;
    }
  },
  {
    name: "read_workflow",
    description:
      "读取平台已有工作流，输出人类可读的 Markdown 说明书（拓扑图、节点清单、数据流、配置详情）。" +
      "使用场景：用户问「这个工作流长什么样/为什么错」时先读；修改线上工作流前先读（读后写入服务端缓存，" +
      "后续 update_workflow 只需传 workflowId，无需重读）。" +
      "默认 scope=overview 只输出概览/拓扑图/节点清单/数据流（省 token）；需要完整配置与验证报告时传 scope=full。",
    schema: z.object({
      workflowId: z
        .string()
        .describe("平台工作流 ID（list_workflows 或 save_to_coze 返回）"),
      scope: z
        .enum(["overview", "full"])
        .optional()
        .describe(
          "overview=只输出概览+节点清单+数据流（默认，省 token）；full=完整说明书含配置详情与验证报告",
        ),
      spaceId: z.string().optional().describe("目标空间 ID（缺省用 .env 的 COZE_SPACE_ID）"),
    }),
  },
);
