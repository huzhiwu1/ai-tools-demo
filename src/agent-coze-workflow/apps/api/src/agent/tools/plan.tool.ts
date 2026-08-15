/**
 * [Tool] plan_workflow - 工作流规划
 *
 * 职责：
 * 接收用户需求描述，通过 WorkflowPlanner（DeepSeek LLM）生成 WorkflowPlan，
 * 并把 plan 写入服务端缓存（句柄化：generate_workflow 只传 planId，不背大 JSON）。
 *
 * 关键细节：
 * - 使用模块级单例 planner，避免每次调用重建 DeepSeekClient
 * - try/catch 兜底，错误以字符串返回给 LLM
 * - .env 中的 DEEPSEEK_API_KEY 等由 DeepSeekClient 内部读取
 * - 句柄化：plan 成功后以 randomUUID 为 key 写入 workflowCache（TTL 30 分钟，
 *   足够覆盖 plan→generate 间隔），返回结果额外携带 planId + _meta
 * - 返回结构用平铺展开（...plan + planId + _meta）而不是 { planId, plan } 嵌套：
 *   前端草图面板直接 JSON.parse 后读顶层 steps 字段渲染，嵌套会破坏前端（不改前端）
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { WorkflowPlanner } from "../../workflow-engine/planner";
import { DeepSeekClient } from "../../llm/deepseek.client";
import { workflowCache } from "../workflow-cache";

/** 模块级单例：planner 内部持有 DeepSeekClient，无状态，可安全跨会话共享 */
const planner = new WorkflowPlanner(new DeepSeekClient());

export const planWorkflowTool = tool(
  async ({ requirement }) => {
    try {
      const plan = await planner.plan({ description: requirement });
      // plan 成功后写缓存（句柄化：generate 只传 planId，不传完整 plan）
      const planId = randomUUID();
      workflowCache.set(planId, plan as unknown as Record<string, unknown>);
      // 平铺展开保留完整 plan（前端草图渲染依赖顶层 steps 字段），
      // 额外附加 planId 句柄 + 规划完成标记（防主 LLM 重复规划）
      return JSON.stringify(
        {
          ...plan,
          planId,
          _meta: { planningComplete: true },
        },
        null,
        2,
      );
    } catch (e) {
      return `规划失败: ${(e as Error).message}`;
    }
  },
  {
    name: "plan_workflow",
    description:
      "将用户的自然语言需求通过大模型分析，生成结构化的工作流规划结果（WorkflowPlan）。" +
      "输出包含：工作流名称、描述、步骤列表、涉及模块、预估复杂度。",
    schema: z.object({
      requirement: z
        .string()
        .describe('用户的自然语言需求描述，例如："用户输入问题，LLM 回答"'),
    }),
  },
);
