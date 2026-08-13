/**
 * [Tool] generate_workflow - 工作流生成
 *
 * 职责：
 * 将 WorkflowPlan 映射为 CozeWorkflow（完整工作流 JSON），
 * 并在返回前进行本地校验，确保结构有效。
 *
 * 关键细节：
 * - 使用模块级单例 generator，无状态，可安全共享
 * - 校验从 @coze-workflow/workflow-schema 导入（不要从本地 validator 导入）
 * - 输出包含 { workflow, validation }，即使校验失败也返回 workflow
 * - try/catch 兜底，错误以字符串返回给 LLM
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { WorkflowPlan } from "@coze-workflow/shared";
import { validateWorkflow } from "@coze-workflow/workflow-schema";
import { WorkflowGenerator } from "../../workflow-engine/generator";
import { CodeGenerator } from "../../workflow-engine/code-generator";
import { DeepSeekClient } from "../../llm/deepseek.client";

/**
 * 模块级单例：generator 依赖 CodeGenerator（LLM 生成代码节点 Python 代码），
 * 无状态可安全共享；LLM 失败时 CodeGenerator 内部自动降级为兜底模板。
 */
const generator = new WorkflowGenerator(
  new CodeGenerator(new DeepSeekClient()),
);

export const generateWorkflowTool = tool(
  async ({ plan, referenceData }) => {
    try {
      // 将 plan 转换为 WorkflowPlan 类型（LLM 传递的 JSON 对象结构匹配）
      const workflowPlan = plan as unknown as WorkflowPlan;
      // 参考数据（如歌词库/歌曲列表）：必须传给代码生成器，
      // 否则 LLM 生成代码节点时会凭空编造数据（如假歌词）
      const workflow = await generator.generateWorkflow(
        workflowPlan,
        referenceData as Record<string, string> | undefined,
      );

      // 调用本地校验，避免无效 API 调用
      const validation = validateWorkflow(workflow);

      return JSON.stringify(
        {
          workflow,
          validation: {
            valid: validation.valid,
            errors: validation.errors,
            warnings: validation.warnings,
          },
        },
        null,
        2,
      );
    } catch (e) {
      return `生成失败: ${(e as Error).message}`;
    }
  },
  {
    name: "generate_workflow",
    description:
      "将 plan_workflow 输出的工作流规划结果（WorkflowPlan）映射为 Coze 平台可部署的" +
      "工作流 JSON，并在返回前自动校验结构完整性。" +
      "如果规划中有参考数据（如歌词库、歌曲列表），必须从 read_file 读取后传入 referenceData。",
    schema: z.object({
      plan: z
        .record(z.string(), z.any())
        .describe(
          "plan_workflow 返回的完整工作流规划结果 JSON（含 name、description、steps、modules、estimatedComplexity）",
        ),
      referenceData: z
        .record(z.string(), z.any())
        .optional()
        .describe(
          "参考数据（如歌词库 {歌名: 歌词}、歌曲列表），用于代码节点生成时内嵌为常量。" +
          "必须来自 read_file 读取的文件内容，禁止凭空编造。",
        ),
    }),
  },
);
