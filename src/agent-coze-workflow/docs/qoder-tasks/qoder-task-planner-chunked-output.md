# Qoder Task: 根治 Planner 输出截断 —— 分步生成 + 截断感知重试

> 创建时间：2026-08-14
> 前置讨论：`docs/deepseek-thinking-model-token-budget-discussion.md`
> 关联任务：`qoder-task-planner-two-stage.md`（prompt 两段式，已落地；本任务解决其未根治的截断问题）

## 背景与问题定位

deepseek-v4-flash 是思考模型：`reasoning_content`（思考 2-5K token）与最终 `content`（JSON）**共享同一个 max_tokens 预算**。当前 `DeepSeekClient` 已显式设 `maxTokens: 8192`，但 planner 的 `LLMPlanOutputSchema` 一次要求输出 `steps + contracts + nodeConfig` 全套嵌套 JSON，复杂工作流（多节点 + 参考数据）仍可能：

1. 思考吃掉大半预算 → JSON 截断 → `StructuredOutputParser` 解析失败
2. 重试一次仍失败 → `plan.tool.ts` catch 返回"规划失败"字符串 → Agent 行为失控

之前的"两段式 prompt"（澄清 → 短规划）只是压缩了 prompt 体积，**没有改变"单次 completion 输出整个大 JSON"的本质**，截断风险只是被缓解而非消除。

## 现状架构（调用链）

```
plan_workflow 工具 (agent/tools/plan.tool.ts，模块级单例)
  └─ WorkflowPlanner.plan() (workflow-engine/planner.ts)
       └─ DeepSeekClient.chatStructured(LLMPlanOutputSchema, PLAN_PROMPT, desc)
            └─ ChatOpenAI.withStructuredOutput(schema, { method: "jsonMode" })
                 // maxTokens: 8192（deepseek.client.ts:88），思考+JSON 共享
       └─ mapToWorkflowPlan(raw)   // 代码组装 start/end、依赖、复杂度
```

**约束（必须遵守）**：
- `WorkflowPlan` 对外形状不变 → `generator.ts`、`plan.tool.ts`、前端全部无感
- 结构化输出只能走 `jsonMode`（functionCalling/jsonSchema 官网 400，见 deepseek.client.ts 注释）
- jsonMode 不注入 schema，prompt 必须自带字段描述 + 输出端 zod 校验兜底
- 结构组装留在代码（planner 现有思路），LLM 只做语义解析

## 方案总览

| 阶段 | 内容 | 工作量 | 风险 |
|---|---|---|---|
| 阶段 1 | 参数层加固：按用途配置 maxTokens + 截断感知提额重试 | 0.5 天 | 低，立即缓解 |
| 阶段 2 | 架构根治：planner 拆为「骨架 → 逐节点细化」两次小 completion | 1-1.5 天 | 中，核心改动 |
| 阶段 3 | 对照实验：当前 / 关思考 / 分步生成三组 A/B 验证 | 0.5 天 | 低 |

**阶段 1 先上（当天下班前缓解），阶段 2 是根治方案（架构上消除截断），阶段 3 用数据定夺后续调优方向。**

---

## 阶段 1：参数层加固

### 1.1 改动 `apps/api/src/llm/deepseek.client.ts`

**a) `DeepSeekConfig` 增加 `maxTokens`，按用途差异化**：

```typescript
export interface DeepSeekConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /** 请求超时（毫秒），默认 60000；思考模型生成复杂 JSON 耗时较长 */
  timeout?: number;
  /** 输出 token 上限（思考+正文共享预算），默认 8192；大 JSON 调用方（planner）传更大值 */
  maxTokens?: number;
}
```

构造器内：`maxTokens: config?.maxTokens ?? 8192`。

**b) 截断感知重试：把 `describeError` 里的截断启发式提取为独立方法**：

```typescript
/**
 * 判断异常是否疑似 max_tokens 截断（JSON 以 { / [ 开头但未闭合）
 * 从 describeError 提取，供 chatStructured 决策是否提额重试
 */
private isTruncationError(e: unknown): boolean {
  const raw = (e as Error)?.message ?? String(e);
  const parseMatch = raw.match(
    /Failed to parse\. Text: "([\s\S]*?)"(?:\. Error: ([\s\S]*))?/,
  );
  if (!parseMatch) return false;
  const text = parseMatch[1].trimEnd();
  return (
    (text.startsWith("{") && !text.endsWith("}")) ||
    (text.startsWith("[") && !text.endsWith("]"))
  );
}
```

**c) `chatStructured` 内：解析失败且疑似截断时，用更大预算重试**（LangChain 支持 `.bind({ max_tokens })` 单次覆盖）：

```typescript
// 在 for 循环 catch 分支里，attempt 失败后：
if (this.isTruncationError(e) && !escalated) {
  escalated = true;
  // 截断根因是预算不足：单次以 2 倍预算重试（.bind 覆盖实例级 maxTokens）
  structured = this.model.bind({ max_tokens: this.maxTokens * 2 });
  lastError = this.describeError(e);
  this.logger.warn(`[DeepSeek] 疑似截断，提额到 ${this.maxTokens * 2} 重试 ...`);
  continue;  // 不消耗 maxRetries 次数，额外给一次机会
}
```

需要把构造器里的 `maxTokens` 提为类字段（`private readonly maxTokens: number`）。

### 1.2 改动 `apps/api/src/agent/tools/plan.tool.ts`

planner 单例改用大预算实例（planner 是全项目最大的 JSON 输出方）：

```typescript
// planner 输出 steps+contracts+nodeConfig 大 JSON，思考+正文共享预算，
// 需要比默认 8192 更大的 headroom
const planner = new WorkflowPlanner(new DeepSeekClient({ maxTokens: 16384 }));
```

### 1.3 验收标准（阶段 1）

- `pnpm --filter @coze-workflow/api typecheck` 通过
- 构造复杂需求（多节点 + 参考数据）跑 planner，截断时日志出现"疑似截断，提额重试"且最终成功
- 其他调用方（code-generator / update-workflow）行为不变（仍 8192）

---

## 阶段 2：架构根治 —— planner 分步生成

核心思想（来自讨论结论）：**不把大输出押在单次 completion 上**。把 planner 拆成两次小调用：

1. **Stage 1（骨架）**：mode/name/goal/澄清/startInputs/constraints/steps（仅 nodeType+description+dependencies 顺序）—— 输出约 1-2K，思考+JSON 远低于预算
2. **Stage 2（细化）**：对骨架中每个非 start/end 节点**并行**生成 contract + nodeConfig —— 每次输出几百 token，单点失败可独立重试/降级

### 2.1 改动 `apps/api/src/workflow-engine/types.ts`：拆分 schema

保留 `LLMPlanOutputSchema` 不变（合并结果的形状、`mapToWorkflowPlan` 的入参）。新增：

```typescript
/** Stage 1 骨架：不含 contracts/nodeConfig 的轻量规划 */
export const PlanSkeletonSchema = z.object({
  needClarification: z.boolean().optional().describe(
    "当用户输入/输出结构不明确时为 true，此时应返回 clarificationQuestions 而非完整规划",
  ),
  clarificationQuestions: /* 同 LLMPlanOutputSchema，原样保留 */,
  mode: z.string().describe("工作流模式，如 '问答'、'数据处理' 等"),
  name: z.string().describe("工作流英文名称：字母开头，仅字母数字下划线，≤50"),
  goal: z.string().describe("一句话描述工作流目标"),
  inputType: z.string().describe("用户输入的类型描述"),
  outputType: z.string().describe("工作流输出的类型描述"),
  needBranch: z.boolean().describe("是否需要条件分支节点"),
  needCodeNode: z.boolean().describe("是否需要代码节点"),
  needDatabaseNode: z.boolean().describe("是否需要数据库查询节点"),
  startInputs: /* 同 LLMPlanOutputSchema，原样保留 */,
  constraints: z.array(z.string()).describe("约束条件列表"),
  riskHints: z.array(z.string()).describe("潜在风险列表"),
  /** 节点步骤：仅顺序与类型，不含 contract/config（Stage 2 逐节点细化） */
  steps: z.array(z.object({
    nodeType: z.enum(["llm","code","condition","database_query","http","text","merge"])
      .describe("节点类型"),
    description: z.string().describe("该节点要完成的任务描述（一句话）"),
    dependencies: z.array(z.number()).describe(
      "依赖的上游步骤 index（从 0 开始），-1 表示依赖用户输入（start）",
    ),
  })).optional().describe("按执行顺序排列的节点步骤列表（不含 start/end）"),
});

/** 单个节点的 contract（与 LLMPlanOutputSchema 中 contracts 元素同构） */
const NodeContractSchema = z.object({
  inputs: z.array(z.object({
    name: z.string().describe("输入变量名"),
    source: z.string().describe("来源说明：如'用户输入'、'LLM 输出'"),
  })).optional().describe("该节点接收的输入参数列表"),
  outputs: z.array(z.object({
    name: z.string().describe("输出变量名"),
    type: z.enum(["string","object","list","integer","number","boolean"])
      .describe("输出变量类型"),
  })).optional().describe("该节点输出的字段列表"),
  batchMode: z.enum(["single","batch"]).optional().describe("单处理还是批处理"),
}).optional();

/** Stage 2 各类型节点的 detail schema：config 字段为类型专用配置 */
export const NodeDetailSchemas: Record<string, z.ZodTypeAny> = {
  llm: z.object({
    contract: NodeContractSchema,
    config: z.object({
      model: z.string().describe("LLM 节点模型名，必须从平台可用模型列表选择"),
      userPrompt: z.string().describe("完整的业务提示词"),
      systemPrompt: z.string().optional().describe("系统提示词，可选"),
    }).describe("LLM 节点业务配置"),
  }),
  code: z.object({
    contract: NodeContractSchema,
    config: z.object({
      logicDescription: z.string().describe("代码节点要实现的业务逻辑描述，要具体"),
      inputs: z.array(z.string()).optional().describe("代码节点需要的输入变量名列表"),
    }).describe("代码节点业务配置"),
  }),
  condition: /* branches 配置，同现有 LLMPlanOutputSchema.nodeConfig.condition */,
  database_query: /* connectionId + queryDescription */,
  http: /* method + url + description */,
  text: /* concatResult */,
  merge: z.object({ contract: NodeContractSchema }).describe("变量聚合节点只需契约"),
};

export type PlanSkeleton = z.infer<typeof PlanSkeletonSchema>;
```

> 实现提示：`NodeDetailSchemas` 各类型直接复用现有 `LLMPlanOutputSchema` 里 `nodeConfig` 对应字段的定义（复制迁移即可，不改原 schema 内容）。

### 2.2 改动 `apps/api/src/prompts/plan-prompt.ts`：拆成两个 prompt

```typescript
/** Stage 1 骨架 prompt：只输出轻量骨架，不输出 contracts/nodeConfig */
export const PLAN_SKELETON_PROMPT = `你是 Coze 工作流需求分析器。
请把用户需求转成结构化 JSON。

## 两段式流程
1. 输入/输出结构不明确 → needClarification=true + clarificationQuestions（1-3 个关键问题）
2. 结构已明确 → 返回完整骨架（needClarification=false）

## 工作流命名规则
name 必须是英文：字母开头，仅字母、数字、下划线，长度 ≤ 50。

## 节点类型
llm | code | condition | http | database_query | text | merge

## 规则
- steps 按执行顺序排列（不含 start/end，系统自动添加），依赖正确无循环
- steps 只写 nodeType + description + dependencies，不要输出 contracts/nodeConfig
- startInputs 定义工作流入口参数（多输入时列出全部）
- 禁止输出：模型名、prompt 全文、代码逻辑、节点 JSON 结构`;

/** Stage 2 节点细化 prompt：给定骨架上下文，为单个节点生成契约与配置 */
export const NODE_DETAIL_PROMPT = `你是 Coze 工作流节点配置生成器。
根据工作流骨架与当前节点，输出该节点的数据契约（contract）与业务配置（config）。

## 骨架上下文（工作流全局，供理解节点定位）
{SKELETON}

## 当前节点
类型: {nodeType}
描述: {description}

## 规则
- contract 的 inputs 来源写"用户输入"/上游节点名；outputs 命名要具体（如 matched、result）
- 配置只保留必要字段，禁止编造平台不存在的模型名
- 只输出 JSON 对象，不要输出其他内容`;
```

### 2.3 改动 `apps/api/src/workflow-engine/planner.ts`：两阶段编排

`plan()` 改为（`mapToWorkflowPlan` 保持不变）：

```typescript
async plan(requirement: { description: string; constraints?: string[] }): Promise<WorkflowPlan> {
  // Stage 1：骨架（小输出，思考+JSON 远低于预算）
  const skeleton = await this.client.chatStructured(
    PlanSkeletonSchema, PLAN_SKELETON_PROMPT, requirement.description,
  );

  // 澄清路径：不走 Stage 2，直接交给既有 mapToWorkflowPlan 的澄清分支
  if (skeleton.needClarification) {
    return this.mapToWorkflowPlan(skeleton as LLMPlanOutput);
  }

  // Stage 2：逐节点并行细化（每次调用只输出一个节点的 contract+config）
  const steps = skeleton.steps ?? [];
  const details = await Promise.all(
    steps.map((s) => this.refineNodeDetail(skeleton, s)),
  );

  // 合并回 LLMPlanOutput 形状（contracts 与 steps 一一对应，nodeConfig 按类型聚合）
  const raw: LLMPlanOutput = {
    ...skeleton,
    contracts: details.map((d) => d?.contract),
    nodeConfig: this.aggregateConfigs(steps, details),
  };
  return this.mapToWorkflowPlan(raw);
}

/** 单个节点细化：按 nodeType 选专用 schema；失败降级为 undefined（节点无配置也能保存） */
private async refineNodeDetail(skeleton: PlanSkeleton, step: PlanStepItem) {
  const schema = NodeDetailSchemas[step.nodeType] ?? NodeDetailSchemas.merge;
  const prompt = NODE_DETAIL_PROMPT
    .replace("{SKELETON}", JSON.stringify(skeleton, null, 2))
    .replace("{nodeType}", step.nodeType)
    .replace("{description}", step.description);
  try {
    return await this.client.chatStructured(schema, NODE_DETAIL_PROMPT_HEAD, prompt);
  } catch (e) {
    // 单节点失败不拖垮整体：无 contract/config 的节点仍可生成可保存的工作流
    this.logger.warn(`[Planner] 节点细化失败 nodeType=${step.nodeType}: ${(e as Error).message}`);
    return undefined;
  }
}
```

关键设计点：
- **并行 `Promise.all`**：N 个节点 N 次小调用并发执行，总延迟约等于单次小调用，不劣于原一次性调用；但**限流压力变大**（阶段 3 观察，必要时改串行或限并发）
- **单点降级**：某个节点细化失败 → 该节点无 contract/nodeConfig，工作流仍可生成/保存（代码节点由 generator 兜底），Agent 后续验证迭代可修复
- **`mapToWorkflowPlan` 零改动**：合并结果形状与旧 `LLMPlanOutput` 一致，`configFor`/`nextContract` 逻辑原样复用

### 2.4 验收标准（阶段 2）

- `pnpm --filter @coze-workflow/api typecheck` 通过
- `WorkflowPlan` 类型与 `generator.ts`、`plan.tool.ts` 零改动
- 复杂需求（多节点 + 参考数据）规划成功，不再出现"疑似截断"日志
- 简单需求（单 LLM 节点）结果与旧实现语义等价（人工对比 3-5 个用例）
- 澄清路径（needClarification=true）行为与旧实现一致

---

## 阶段 3：对照实验与验证

### 3.1 网关参数验证（curl，先做）

```bash
# 验证网关是否支持关闭思考（决定后续是否需要方案 A 的开关）
curl -s $LLM_BASE_URL/chat/completions -H "Authorization: Bearer $LLM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"说一个字"}],
       "max_tokens":100,"thinking":{"type":"disabled"}}' | head -c 500
```

预期：HTTP 200 且响应中**无** `reasoning_content` 字段 → 参数被支持；若 400 或仍有 reasoning_content → 网关静默忽略，放弃方案 A 路线。

### 3.2 三组对照实验（复用 test-plan 脚本模式）

| 组 | 配置 | 观察指标 |
|---|---|---|
| 基线 | 当前实现（8192 一次性） | 成功率、截断率、耗时 |
| A | thinking disabled + 一次性 | 成功率、plan 质量（人工） |
| C | 分步生成（阶段 2） | 成功率、总耗时、API 调用次数、限流情况 |

实验脚本：`apps/api/test-plan.ts`（临时文件，跑完删除），同一批 5-10 个真实需求（含"音频识别歌曲"类多节点用例）。

### 3.3 决策规则（数据说话）

- 阶段 2 成功率 ≥ 95% → 分步生成定稿，删除旧一次性路径
- 组 A 质量不劣于基线 → 可考虑把骨架 stage 用 thinking disabled（小任务思考浪费预算）
- 出现 429 限流 → Stage 2 改限并发（如 p-limit 并发 3）

---

## 验收标准汇总

1. 阶段 1 后：截断场景自动提额重试成功，日志可观测
2. 阶段 2 后：planner 在复杂需求下不再截断，`WorkflowPlan` 对外形状不变
3. 阶段 3 后：对照实验报告写入 `docs/qoder-tasks/`（数据 + 结论 + 最终配置定稿）
4. typecheck 全程通过；不引入新依赖（除非阶段 3 决定限并发，用 p-limit）

## 风险与回滚

| 风险 | 缓解 |
|---|---|
| Stage 2 并行调用触发限流 | 阶段 3 观测；限并发或改串行（planner 内部编排，调用方无感） |
| 分步生成丢失全局一致性（contract 语义与骨架脱节） | Stage 2 prompt 注入完整骨架上下文（见 NODE_DETAIL_PROMPT） |
| 小任务上思考占比更高（相对浪费） | 阶段 3 组 A 数据决定是否对 Stage 2 关思考 |
| 节点细化失败导致 plan 缺配置 | 已设计单点降级；generator 对缺失配置有既有兜底 |

回滚：阶段 2 改动全部集中在 planner 内部（types/prompt/planner 三个文件），`git revert` 单 commit 即可回到一次性路径，`LLMPlanOutputSchema` 保留不删可随时切回。

## 不改的文件

- `apps/api/src/workflow-engine/generator.ts`、`code-generator.ts` — WorkflowPlan 形状不变
- `apps/api/src/agent/react-agent.service.ts` — Agent 循环与流式展示不动（其 llm 输出为短工具参数，8192 足够；若日志出现工具参数截断再另开任务）
- `apps/api/src/agent/tools/plan.tool.ts` — 除阶段 1.2 的 maxTokens 配置外不动
- 前端全部文件
