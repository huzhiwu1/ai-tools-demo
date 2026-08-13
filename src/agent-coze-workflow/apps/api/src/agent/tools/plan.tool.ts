/**
 * [Tool] plan_workflow - 工作流规划
 *
 * 职责：
 * 接收用户需求描述，通过 WorkflowPlanner（DeepSeek LLM）生成 WorkflowPlan。
 *
 * 关键细节：
 * - 使用模块级单例 planner，避免每次调用重建 DeepSeekClient
 * - try/catch 兜底，错误以字符串返回给 LLM
 * - .env 中的 DEEPSEEK_API_KEY 等由 DeepSeekClient 内部读取
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { WorkflowPlanner } from "../../agents/workflow-planner";
import { DeepSeekClient } from "../../llm/deepseek.client";

/** 模块级单例：planner 内部持有 DeepSeekClient，无状态，可安全跨会话共享 */
const planner = new WorkflowPlanner(new DeepSeekClient());

export const planWorkflowTool = tool(
  async ({ requirement }) => {
    try {
      const plan = await planner.plan({ description: requirement });
      return JSON.stringify(plan, null, 2);
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
