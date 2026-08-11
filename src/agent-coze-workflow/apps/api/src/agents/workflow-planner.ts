/**
 * WorkflowPlanner - 工作流规划 Agent
 *
 * 职责：
 * 接收用户自然语言需求，通过 DeepSeek LLM 推理生成 WorkflowPlan
 *
 * 流程：
 * 1. 接收 UserRequirement
 * 2. 调用 DeepSeekClient.chatStructured()（LangChain withStructuredOutput）
 * 3. 将 LLM 输出映射为 WorkflowPlan（模板化优先：LLM 只做语义解析，结构组装交给代码）
 *
 * 关键细节：
 * - LLM 通过 PLAN_PROMPT 输出结构化需求 JSON（mode/goal/needBranch 等）
 * - 结构化输出由 zod schema + withStructuredOutput 保证，无需手写 JSON 容错
 * - 后端按映射规则组装 steps（顺序固定：start → 可选节点 → llm → end）
 * - LLM 调用失败时由 WorkflowService 降级为 mock 计划
 *
 * 映射规则：
 * - name：goal 截断 30 字符
 * - description：goal + constraints
 * - steps：start → (database_query) → (code) → (condition) → llm → end
 * - modules：steps nodeType 去重
 * - estimatedComplexity：≤3→simple, ≤5→medium, >5→complex
 */
import type {
  WorkflowPlan,
  PlanStep,
  WorkflowNodeType,
} from "@coze-workflow/shared";
import { PLAN_PROMPT } from "../prompts/plan-prompt";
import type { DeepSeekClient } from "../llm/deepseek.client";
import { LLMPlanOutputSchema, type LLMPlanOutput } from "./types";

export class WorkflowPlanner {
  constructor(private readonly client: DeepSeekClient) {}

  /**
   * 分析用户需求，生成 WorkflowPlan
   *
   * @param requirement - 用户需求描述
   * @returns 工作流规划结果
   */
  async plan(requirement: {
    description: string;
    constraints?: string[];
  }): Promise<WorkflowPlan> {
    // 1. 调用 LLM 分析需求（zod schema 自动保证输出格式和类型安全）
    const raw = await this.client.chatStructured(
      LLMPlanOutputSchema,
      PLAN_PROMPT,
      requirement.description,
    );

    // 2. 映射为 WorkflowPlan
    return this.mapToWorkflowPlan(raw);
  }

  /**
   * 将 LLM 输出映射为 WorkflowPlan
   *
   * 模板化优先：LLM 只做语义解析，结构组装交给代码
   */
  private mapToWorkflowPlan(input: LLMPlanOutput): WorkflowPlan {
    // name：goal 截断 30 字符
    const name = input.goal.length > 30 ? input.goal.slice(0, 30) : input.goal;

    // description：goal + constraints
    const constraintsSuffix =
      input.constraints.length > 0
        ? `；约束：${input.constraints.join("、")}`
        : "";
    const description = input.goal + constraintsSuffix;

    // steps：按建议顺序构建
    const steps: PlanStep[] = [];
    let order = 0;

    // 1. start — 接收用户输入
    order++;
    steps.push({
      order,
      description: "接收用户输入",
      nodeType: "start",
      dependencies: [],
    });
    const startOrder = order;

    // 2. database_query — 查询数据（条件性）
    if (input.needDatabaseNode) {
      order++;
      steps.push({
        order,
        description: "查询数据库获取相关数据",
        nodeType: "database_query",
        dependencies: [startOrder],
      });
    }

    // 3. code — 数据处理（条件性）
    if (input.needCodeNode) {
      order++;
      steps.push({
        order,
        description: "执行代码逻辑处理数据",
        nodeType: "code",
        dependencies: [order - 1],
      });
    }

    // 4. condition — 条件分支（条件性）
    if (input.needBranch) {
      order++;
      steps.push({
        order,
        description: "根据条件进行分支判断",
        nodeType: "condition",
        dependencies: [order - 1],
      });
    }

    // 5. llm — 核心处理（必须）
    order++;
    steps.push({
      order,
      description: "使用大模型进行核心推理",
      nodeType: "llm",
      dependencies: [order - 1],
    });

    // 6. end — 返回结果
    order++;
    steps.push({
      order,
      description: "返回最终结果",
      nodeType: "end",
      dependencies: [order - 1],
    });

    // modules：steps 里 nodeType 去重
    const modules = [...new Set(steps.map((s) => s.nodeType))];

    // estimatedComplexity：≤3→simple, ≤5→medium, >5→complex
    const stepCount = steps.length;
    const estimatedComplexity: "simple" | "medium" | "complex" =
      stepCount <= 3 ? "simple" : stepCount <= 5 ? "medium" : "complex";

    return {
      name,
      description,
      steps,
      modules,
      estimatedComplexity,
    };
  }
}
