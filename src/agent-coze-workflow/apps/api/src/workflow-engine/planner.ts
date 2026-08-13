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

/**
 * 生成合法工作流名：字母开头 + 字母/数字/下划线，超长截断
 *
 * 平台硬性约束（update_meta 接口实测）：工作流名称只允许字母、数字、
 * 下划线，且必须以字母开头。LLM 负责语义（输出英文名），此函数代码兜底：
 * 非法字符转下划线、去重下划线、去前导非字母、截断 50、空名降级 workflow。
 *
 * @param name - LLM 输出的原始名称（可能含中文/空格等非法字符）
 * @returns 平台合法的英文工作流名
 */
function sanitizeWorkflowName(name: string): string {
  // 只保留字母数字下划线
  let clean = name.replace(/[^a-zA-Z0-9_]/g, "_");
  // 去重下划线
  clean = clean.replace(/_+/g, "_");
  // 必须以字母开头
  clean = clean.replace(/^[^a-zA-Z]+/, "");
  // 截断 50
  clean = clean.slice(0, 50);
  // 空兜底
  if (!clean) clean = "workflow";
  return clean;
}

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
    // name：LLM 语义英文名 + sanitize 代码兜底（平台只允许字母数字下划线）
    const name = sanitizeWorkflowName(input.name || input.goal);

    // description：goal + constraints
    const constraintsSuffix =
      input.constraints.length > 0
        ? `；约束：${input.constraints.join("、")}`
        : "";
    const description = input.goal + constraintsSuffix;

    // steps：按 LLM 输出的 contracts 顺序构建（非固定模板）
    // LLM 的 contracts 数组已经隐含了执行顺序（如：llm→code→condition）
    const steps: PlanStep[] = [];
    let order = 0;

    // 1. start — 接收用户输入（支持多输入：LLM 通过 startInputs 定义入口参数）
    order++;
    steps.push({
      order,
      description: "接收用户输入",
      nodeType: "start",
      dependencies: [],
      // start 的输出 = 工作流入口参数（LLM 定义，默认 user_input）
      contract: {
        outputs:
          input.startInputs && input.startInputs.length > 0
            ? input.startInputs.map((s) => ({
                name: s.name,
                type: s.type,
                default: s.default,
              }))
            : [{ name: "user_input", type: "string" }],
      },
    });
    const startOrder = order;

    // 构建步骤：优先用 LLM 显式输出的 steps（顺序权威），无则兜底
    const contracts = input.contracts ?? [];
    let contractIndex = 0;

    /** 取下一个可用的数据契约（与 steps 顺序一一对应） */
    const nextContract = (): PlanStep["contract"] | undefined => {
      const idx = contractIndex;
      contractIndex++;
      if (idx < contracts.length) {
        const c = contracts[idx];
        return {
          inputs: c.inputs,
          outputs: c.outputs,
          batchMode: c.batchMode,
        };
      }
      return undefined;
    };

    /** 从 nodeConfig 按节点类型取配置（不依赖键顺序） */
    const configFor = (nodeType: string): unknown => {
      const nc = input.nodeConfig as Record<string, unknown> | undefined;
      const keyByType: Record<string, string> = {
        llm: "llm",
        code: "code",
        condition: "condition",
        database_query: "database",
        http: "http",
      };
      const key = keyByType[nodeType];
      return key && nc ? nc[key] : undefined;
    };

    const explicitSteps = input.steps ?? [];
    let prevOrder = startOrder;

    if (explicitSteps.length > 0) {
      // 权威路径：LLM 显式输出 steps，顺序 + 依赖直接照抄
      for (let i = 0; i < explicitSteps.length; i++) {
        const s = explicitSteps[i];
        order++;
        const deps = (s.dependencies ?? [])
          .map((d) => (d === -1 ? startOrder : d + 2)) // steps index → order（start=1，steps[0]=2）
          .filter((d) => d >= startOrder && d < order);
        if (deps.length === 0) deps.push(startOrder); // 无依赖兜底连 start
        const cfg = configFor(s.nodeType);
        steps.push({
          order,
          description: s.description || this.defaultDescForType(s.nodeType),
          nodeType: s.nodeType as WorkflowNodeType,
          dependencies: deps,
          contract: nextContract(),
          nodeConfig: cfg ? ({ [s.nodeType]: cfg } as any) : undefined,
        });
        prevOrder = order;
      }
    } else {
      // 兜底：按布尔标志决定（旧逻辑，LLM 未输出 steps 时）
      const fallbackTypes: string[] = [];
      if (input.needDatabaseNode) fallbackTypes.push("database_query");
      if (input.needCodeNode) fallbackTypes.push("code");
      if (input.needBranch) fallbackTypes.push("condition");
      fallbackTypes.push("llm");

      for (const nodeType of fallbackTypes) {
        order++;
        const cfg = configFor(nodeType);
        steps.push({
          order,
          description: this.defaultDescForType(nodeType),
          nodeType: nodeType as WorkflowNodeType,
          dependencies: [prevOrder],
          contract: nextContract(),
          nodeConfig: cfg ? ({ [nodeType]: cfg } as any) : undefined,
        });
        prevOrder = order;
      }
    }

    // end — 返回结果
    order++;
    steps.push({
      order,
      description: "返回最终结果",
      nodeType: "end",
      dependencies: [prevOrder],
    });

    // modules：steps 里 nodeType 去重
    const modules = [...new Set(steps.map((s) => s.nodeType))];

    // estimatedComplexity：≤3→simple, ≤5→medium, >5→complex
    const stepCount = steps.length;
    const estimatedComplexity: "simple" | "medium" | "complex" =
      stepCount <= 3 ? "simple" : stepCount <= 5 ? "medium" : "complex";

    // 安全保险：确保 start 排第一、end 排最后（覆盖 LLM 输出异常顺序的情况）
    const startIdx = steps.findIndex((s) => s.nodeType === "start");
    const endIdx = steps.findIndex((s) => s.nodeType === "end");
    if (startIdx > 0) {
      // 把 start 移到第一位
      const [start] = steps.splice(startIdx, 1);
      steps.unshift(start);
    }
    if (endIdx >= 0 && endIdx < steps.length - 1) {
      // 把 end 移到最后一位
      const [end] = steps.splice(
        steps.findIndex((s) => s.nodeType === "end"),
        1,
      );
      steps.push(end);
    }

    return {
      name,
      description,
      steps,
      modules,
      estimatedComplexity,
    };
  }

  /**
   * 根据节点类型返回默认描述（当 LLM 未提供具体描述时使用）
   */
  private defaultDescForType(type: string): string {
    const descs: Record<string, string> = {
      llm: "使用大模型进行核心推理",
      code: "执行代码逻辑处理数据",
      condition: "根据条件进行分支判断",
      database_query: "查询数据库获取相关数据",
      http: "发送 HTTP 请求",
      text: "文本处理",
      merge: "变量聚合",
    };
    return descs[type] ?? `执行 ${type} 处理`;
  }
}
