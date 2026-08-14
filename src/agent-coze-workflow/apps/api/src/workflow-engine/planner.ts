/**
 * WorkflowPlanner - 工作流规划 Agent
 *
 * 职责：
 * 接收用户自然语言需求，通过 DeepSeek LLM 推理生成 WorkflowPlan
 *
 * 流程（分步生成，从架构上消除思考模型输出截断）：
 * 1. Stage 1：调用 DeepSeekClient.chatStructured() 生成轻量骨架
 *    （元信息 + steps 内嵌 contracts，不含 nodeConfig，输出约 1-2K）
 * 2. Stage 2：逐节点并行生成 nodeConfig（限并发 3 防限流，单节点失败降级）
 * 3. 合并回 LLMPlanOutput 形状后映射为 WorkflowPlan
 *    （模板化优先：LLM 只做语义解析，结构组装交给代码）
 *
 * 关键细节：
 * - 骨架的 contract 内嵌在 steps 里，保证跨节点变量名全局一致
 * - 每个 LLM 调用输出都很小，思考+JSON 远低于 max_tokens 预算，不会截断
 * - 单节点 config 失败降级为空对象，不拖垮整体规划
 * - LLM 调用失败时由 WorkflowService 降级为 mock 计划
 *
 * 映射规则（mapToWorkflowPlan，与旧一次性输出完全一致）：
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
import { Logger } from "@nestjs/common";
import {
  PLAN_SKELETON_PROMPT,
  NODE_CONFIG_PROMPT,
} from "../prompts/plan-prompt";
import type { DeepSeekClient } from "../llm/deepseek.client";
import {
  PlanSkeletonSchema,
  NodeConfigSchema,
  type LLMPlanOutput,
  type PlanSkeleton,
  type NodeConfig,
} from "./types";

/** 骨架中的单个步骤（含内嵌 contract） */
type SkeletonStep = NonNullable<PlanSkeleton["steps"]>[number];

/** Stage 2 并发上限：单次批内最多并行 3 个节点 config 请求，防 429 限流 */
const CONFIG_CONCURRENCY = 3;

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
  private readonly logger = new Logger("WorkflowPlanner");

  constructor(private readonly client: DeepSeekClient) {}

  /**
   * 分析用户需求，生成 WorkflowPlan（分步生成：骨架 → 逐节点 config）
   *
   * @param requirement - 用户需求描述
   * @returns 工作流规划结果
   */
  async plan(requirement: {
    description: string;
    constraints?: string[];
  }): Promise<WorkflowPlan> {
    // Stage 1：轻量骨架（含 steps 内嵌 contracts，不含 nodeConfig，输出约 1-2K）
    const skeleton = await this.client.chatStructured(
      PlanSkeletonSchema,
      PLAN_SKELETON_PROMPT,
      requirement.description,
    );

    // 澄清路径：直接走既有映射的澄清分支，跳过 Stage 2
    if (skeleton.needClarification) {
      return this.mapToWorkflowPlan(skeleton as LLMPlanOutput);
    }

    // Stage 2：逐节点并行生成 nodeConfig（限并发防限流，单节点失败降级）
    const steps = skeleton.steps ?? [];
    const configs = await this.refineConfigs(skeleton, steps);

    // 合并回 LLMPlanOutput 形状：contracts 来自骨架，nodeConfig 来自 Stage 2
    const raw = {
      ...skeleton,
      // 骨架的 contract 内嵌在 steps 里，这里平铺成顶层 contracts 数组
      // （与 mapToWorkflowPlan 的 nextContract 读取方式对齐）；无 contract 时给空对象防 TypeError
      contracts: steps.map((s) => s.contract ?? { inputs: [], outputs: [] }),
      nodeConfig: this.aggregateConfigs(steps, configs),
    } as LLMPlanOutput;
    return this.mapToWorkflowPlan(raw);
  }

  /**
   * 逐节点并行生成 nodeConfig，限并发 3 防 429 限流
   *
   * 分批执行：批内最多 CONFIG_CONCURRENCY 个并发，批间串行。
   * 每次调用只输出单节点 config（约 200 token），远低于 max_tokens 预算。
   *
   * @param skeleton - Stage 1 骨架（作为全局上下文注入每个节点 prompt）
   * @param steps - 骨架中的步骤列表
   * @returns 与 steps 一一对应的 config 数组（失败项为 {}，不抛错）
   */
  private async refineConfigs(
    skeleton: PlanSkeleton,
    steps: SkeletonStep[],
  ): Promise<NodeConfig[]> {
    const results: NodeConfig[] = [];
    for (let i = 0; i < steps.length; i += CONFIG_CONCURRENCY) {
      const batch = steps.slice(i, i + CONFIG_CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map((s) => this.refineOneConfig(skeleton, s)),
      );
      results.push(...batchResults);
    }
    return results;
  }

  /**
   * 生成单个节点的业务配置（nodeConfig）
   *
   * 注入完整骨架上下文 + 该节点的 contract，LLM 只需输出该节点的配置字段。
   * 失败降级返回 {}：无 config 的节点由 generator 兜底，不拖垮整体规划。
   *
   * @param skeleton - 全局骨架上下文
   * @param step - 当前节点（含内嵌 contract）
   * @returns 该节点的扁平配置对象；失败时返回空对象
   */
  private async refineOneConfig(
    skeleton: PlanSkeleton,
    step: SkeletonStep,
  ): Promise<NodeConfig> {
    try {
      // 占位符替换：完整指令作 systemPrompt，userPrompt 只做简短定位
      const completedPrompt = NODE_CONFIG_PROMPT.replace(
        "{SKELETON}",
        JSON.stringify(skeleton, null, 2),
      )
        .replace("{nodeType}", step.nodeType)
        .replace("{description}", step.description)
        .replace("{inputs}", JSON.stringify(step.contract?.inputs ?? []))
        .replace("{outputs}", JSON.stringify(step.contract?.outputs ?? []));

      const cfg = await this.client.chatStructured(
        NodeConfigSchema,
        completedPrompt,
        `为节点「${step.description}」生成 nodeConfig`,
      );
      // inputs 规范化：模型可能输出对象数组（照搬 contract 的 { name, source }），
      // 下游 generator 需要字符串变量名列表，统一取 name
      if (cfg.inputs) {
        cfg.inputs = cfg.inputs.map((i) =>
          typeof i === "string" ? i : i.name,
        );
      }
      return cfg;
    } catch (e) {
      this.logger.warn(
        `[Planner] 节点 config 生成失败 nodeType=${step.nodeType}: ${(e as Error).message}`,
      );
      return {};
    }
  }

  /**
   * 把各节点的扁平 config 聚合成按类型分组的 nodeConfig
   *
   * 与 LLMPlanOutputSchema.nodeConfig 形状对齐（{ llm: {...}, code: {...} }）。
   * 同类型多节点时后者覆盖前者（与旧一次性输出语义一致：每类型仅一份配置）。
   * 全部为空时返回 undefined（nodeConfig 可选）。
   *
   * @param steps - 骨架步骤列表
   * @param configs - refineConfigs 返回的扁平配置数组（与 steps 一一对应）
   * @returns 分组后的 nodeConfig；无任何配置时 undefined
   */
  private aggregateConfigs(
    steps: SkeletonStep[],
    configs: NodeConfig[],
  ): LLMPlanOutput["nodeConfig"] {
    // nodeType → nodeConfig 键名映射（与 mapToWorkflowPlan 的 configFor 一致）
    const keyByType: Record<string, string> = {
      llm: "llm",
      code: "code",
      condition: "condition",
      database_query: "database",
      http: "http",
      text: "text",
    };

    const result: Record<string, unknown> = {};
    steps.forEach((s, i) => {
      const key = keyByType[s.nodeType];
      const cfg = configs[i];
      if (key && cfg && Object.keys(cfg).length > 0) {
        result[key] = cfg;
      }
    });

    return Object.keys(result).length > 0
      ? (result as LLMPlanOutput["nodeConfig"])
      : undefined;
  }

  /**
   * 将 LLM 输出映射为 WorkflowPlan
   *
   * 模板化优先：LLM 只做语义解析，结构组装交给代码
   */
  private mapToWorkflowPlan(input: LLMPlanOutput): WorkflowPlan {
    // 如果 LLM 认为需要澄清，返回一个只有基础信息的 plan，
    // 让调用方（Agent）通过 clarify_question 工具向用户提问
    // 规范化：schema 兼容字符串/对象两种输出，这里统一转为 { field, question }
    const clarificationQuestions = (input.clarificationQuestions ?? []).map(
      (q) => (typeof q === "string" ? { field: "", question: q } : q),
    );
    if (input.needClarification && clarificationQuestions.length > 0) {
      return {
        name: sanitizeWorkflowName(input.name || "pending"),
        description: input.goal || "待补充需求",
        steps: [
          {
            order: 1,
            description: "接收用户输入",
            nodeType: "start" as const,
            dependencies: [],
          },
          {
            order: 2,
            description: "返回结果",
            nodeType: "end" as const,
            dependencies: [1],
          },
        ],
        modules: ["start", "end"],
        estimatedComplexity: "simple" as const,
        // 把澄清问题附在 description 上，方便 Agent 读取
        _clarification: {
          questions: clarificationQuestions,
        },
      };
    }

    // name：LLM 语义英文名 + sanitize 代码兜底（平台只允许字母数字下划线）
    const name = sanitizeWorkflowName(input.name || input.goal);

    // description：goal + constraints
    // constraints 在 PlanSkeleton 中为 optional（澄清路径可不填），
    // superRefine 保证正常路径存在，这里再加 ?? [] 防御断言绕过后的 undefined
    const constraintsSuffix =
      (input.constraints ?? []).length > 0
        ? `；约束：${input.constraints!.join("、")}`
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
        text: "text",
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
