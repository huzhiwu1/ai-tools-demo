# Qoder Task: 关思考 + 分步生成（修正版），根治 planner 输出截断

## 背景

当前 planner 用 deepseek-v4-flash 思考模型一次输出完整 JSON（steps+contracts+nodeConfig），频繁被截断，JSON.parse 失败 → 整个规划报废。太弱了，不健壮。

**Codex 已审查 Qoder 的分步方案，指出了三个致命缺陷。本任务修正后实施。**

## 需要做的事

### 改动 1：关思考（一行改动）

`apps/api/src/llm/deepseek.client.ts`，ChatOpenAI 构造器加：

```typescript
modelKwargs: { thinking: { type: "disabled" } },
```

同时删除重复的 `maxTokens`（当前设了两次 8192 和 16384），只保留一个 8192。

关思考后所有 token 预算给 JSON 输出，消除截断根因。

### 改动 2：分步生成（修正版，利用 Codex 审查结论）

**核心原则：contracts 留在骨架（保证全局变量命名一致性），只把 config 逐节点细化。**

#### 2.1 修改 `apps/api/src/workflow-engine/types.ts`

新增 `PlanSkeletonSchema`（轻量骨架，不含 config）：

```typescript
export const PlanSkeletonSchema = z.object({
  needClarification: z.boolean().optional(),
  clarificationQuestions: /* 同 LLMPlanOutputSchema */,
  name: z.string(),
  goal: z.string(),
  // ... inputType, outputType, needBranch, needCodeNode, needDatabaseNode 等
  startInputs: /* 同 LLMPlanOutputSchema */,
  constraints: z.array(z.string()),
  riskHints: z.array(z.string()),
  /** 节点步骤：含 nodeType + description + dependencies + contracts */
  steps: z.array(z.object({
    nodeType: z.enum(["llm","code","condition","database_query","http","text","merge"]),
    description: z.string(),
    dependencies: z.array(z.number()),
    /** contracts 留在骨架，保证跨节点变量名一致性 */
    contract: z.object({
      inputs: z.array(z.object({ name: z.string(), source: z.string() })).optional(),
      outputs: z.array(z.object({ name: z.string(), type: z.enum(["string","object","list","integer","number","boolean"]) })).optional(),
      batchMode: z.enum(["single","batch"]).optional(),
    }).optional(),
  })).optional(),
});
```

**关键：contracts 留在骨架里**，LLM 一次性输出时看着全局对齐变量名，不会出现下游 `inputs.name` 不匹配上游 `outputs.name` 的问题。

#### 2.2 修改 `apps/api/src/prompts/plan-prompt.ts`

新增 `NODE_CONFIG_PROMPT`（只生成单个节点的 config）：

```typescript
export const NODE_CONFIG_PROMPT = `你是 Coze 工作流节点配置生成器。
根据工作流骨架与当前节点，输出该节点的业务配置（nodeConfig）。

## 全局上下文
{SKELETON}

## 当前节点
类型: {nodeType}
描述: {description}
输入: {inputs}
输出: {outputs}

## 规则
- 只输出该节点的 nodeConfig 字段（如 llm 节点输出 { model, userPrompt, systemPrompt }）
- 禁止编造平台不存在的模型名
- 只输出 JSON 对象`;
```

#### 2.3 修改 `apps/api/src/workflow-engine/planner.ts`

```typescript
async plan(requirement) {
  // Stage 1：骨架（含 contracts，不含 nodeConfig）—— 输出 ~1-2K
  const skeleton = await this.client.chatStructured(
    PlanSkeletonSchema, PLAN_SKELETON_PROMPT, requirement.description,
  );

  if (skeleton.needClarification) {
    return this.mapToWorkflowPlan(skeleton as LLMPlanOutput);
  }

  // Stage 2：逐节点生成 nodeConfig（并行，每次输出 ~200 token）
  // 限并发 3，避免 429
  const steps = skeleton.steps ?? [];
  const configs = await this.refineConfigs(skeleton, steps);

  // 合并：contracts 来自骨架，nodeConfig 来自 Stage 2
  const raw: LLMPlanOutput = {
    ...skeleton,
    contracts: steps.map(s => s.contract),
    nodeConfig: this.aggregateConfigs(steps, configs),
  };
  return this.mapToWorkflowPlan(raw);
}

/** 逐节点并行生成 config，限并发 3 */
private async refineConfigs(skeleton, steps) {
  const results = [];
  // 分批执行，每批最多 3 个并发
  for (let i = 0; i < steps.length; i += 3) {
    const batch = steps.slice(i, i + 3);
    const batchResults = await Promise.all(
      batch.map(s => this.refineOneConfig(skeleton, s)),
    );
    results.push(...batchResults);
  }
  return results;
}

/** 单个节点 config 生成，失败降级为空对象 */
private async refineOneConfig(skeleton, step) {
  try {
    const prompt = NODE_CONFIG_PROMPT
      .replace("{SKELETON}", JSON.stringify(skeleton))
      .replace("{nodeType}", step.nodeType)
      .replace("{description}", step.description)
      .replace("{inputs}", JSON.stringify(step.contract?.inputs ?? []))
      .replace("{outputs}", JSON.stringify(step.contract?.outputs ?? []));
    return await this.client.chatStructured(
      NodeConfigSchema, NODE_CONFIG_PROMPT, prompt,
    );
  } catch (e) {
    this.logger.warn(`节点 config 生成失败 ${step.nodeType}: ${e.message}`);
    return {}; // 降级：无 config 的节点 generator 有兜底
  }
}
```

**关键修复（对照 Codex 审查）：**
- ✅ contracts 在骨架里，不拆开——保证变量名全局一致
- ✅ 降级返回 `{}` 而非 `undefined`——不会触发 TypeError
- ✅ 限并发 3 而非 Promise.all 全量——避免 429
- ✅ 只细化 config（每个 ~200 token），不切分 contracts

## 验收标准

1. `pnpm typecheck` 通过
2. 复杂需求（多节点）规划不再截断
3. JSON 完整可 JSON.parse
4. 单节点失败不拖垮整体（workflow 仍可生成/保存）
5. 简单需求行为与旧实现语义等价

## 不改的文件

- `apps/api/src/workflow-engine/generator.ts` — WorkflowPlan 形状不变
- `apps/api/src/agent/react-agent.service.ts` — Agent 不动
- `apps/api/src/agent/tools/plan.tool.ts` — 不动