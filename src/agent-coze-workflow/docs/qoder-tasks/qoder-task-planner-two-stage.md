# Qoder Task: Planner Prompt 两段式改造 —— 先确认输入/输出结构，再做短规划

## 背景

当前 `plan-prompt.ts`（4892 字节）要求 LLM 一次性输出完整结构化 JSON，包括：
`mode`、`name`、`goal`、`inputType`、`outputType`、`needBranch`、`needCodeNode`、
`needDatabaseNode`、`startInputs`、`constraints`、`riskHints`、`nodeConfig`、`steps`、`contracts`

**实测问题**：规划工具连续两次因输出截断失败。DeepSeek 思考模型被 `max_tokens` 截断，
不是模型能力不够，是「一个请求里塞了太多规划内容」。

**正确认知**：工作流本质是一个程序，最重要的不是先写一大段规划，而是先搞清楚**输入结构**和**输出结构**。

**现有能力**：Agent 层已有 `clarify_question` 工具（`apps/api/src/agent/tools/clarify.tool.ts`），
可通过 `interrupt()` 暂停图执行向用户提问。但 planner 内部没有复用它。

---

## 改动目标

把 planner 从「一次性生成完整规划」改成「两段式」：

1. **第 1 段：先确认输入/输出结构** — 如果用户需求里输入/输出结构不清楚，先问清
2. **第 2 段：再做短规划** — 输入/输出明确后，输出轻量规划，只保留必要字段

---

## 改动文件

### 1. `apps/api/src/prompts/plan-prompt.ts`（核心改动）

**删掉：**

- 平台可用模型列表（25 个，约 600 字节）—— 模型选择由 generator 代码自动匹配，不靠 LLM
- 平台可用数据库列表（3 个，约 200 字节）—— 数据库选择由 `get_platform_facts` 工具提供
- `nodeConfig` 的详细生成规则（llm.model / llm.userPrompt / code.logicDescription / condition.branches / text.concatResult / database 规则）—— 这些规则下沉到 generator 代码
- `steps` 的完整描述和依赖说明 —— 缩减为简要约束
- `contracts` 的完整描述 —— 缩减为简要约束

**保留（压缩后）：**

- 工作流命名规则
- 节点类型枚举（llm / code / condition / http / database_query / text / merge）
- 简要约束：`steps` 按执行顺序排列、`contracts` 与 `steps` 一一对应、`startInputs` 定义入口参数
- 禁止输出：模型名、prompt 全文、代码逻辑、节点 JSON 结构

**新增：**

- 两段式指令：如果输入/输出结构不明确，先输出 `needClarification: true` 和 `clarificationQuestions`
- 短规划指令：`steps` 尽量短、`contracts` 尽量短、`nodeConfig` 只保留必要字段
- 不要一次性铺开所有边界情况

**新的 prompt 结构（约 1200 字节，比现有 4892 字节压缩 75%）：**

```typescript
export const PLAN_PROMPT = `你是 Coze 工作流需求分析器。
请把用户需求转成结构化 JSON。

## 两段式流程
1. 如果输入/输出结构不明确，先返回 needClarification=true + clarificationQuestions（1-3 个关键问题）
2. 如果输入/输出结构已明确，返回完整规划（needClarification=false）

## 工作流命名规则
name 必须是英文：只允许字母、数字、下划线，以字母开头，长度 ≤ 50。

## 节点类型
llm | code | condition | http | database_query | text | merge

## 规则
- steps 按执行顺序排列（不含 start/end，系统自动添加），依赖正确无循环
- contracts 与 steps 一一对应（steps[0]↔contracts[0]）
- startInputs 定义工作流入口参数（多输入时列出全部）
- steps 尽量短，contracts 尽量短，nodeConfig 只保留必要字段
- 禁止输出：模型名、prompt 全文、代码逻辑、节点 JSON 结构`;
```

---

### 2. `apps/api/src/workflow-engine/types.ts`（新增澄清字段）

在 `LLMPlanOutputSchema` 的 zod schema 里新增两个字段：

```typescript
needClarification: z.boolean().optional().describe(
  "当用户输入/输出结构不明确时为 true，此时应返回 clarificationQuestions 而非完整规划"
),
clarificationQuestions: z.array(z.object({
  field: z.string().describe("需要澄清的字段（如 input_type / output_type / input_fields）"),
  question: z.string().describe("向用户提出的具体问题"),
  hint: z.string().optional().describe("可选的提示信息"),
})).optional().describe("需要向用户澄清的问题列表（1-3 个），仅 needClarification=true 时填写"),
```

---

### 3. `apps/api/src/workflow-engine/planner.ts`（新增澄清逻辑）

在 `mapToWorkflowPlan` 方法**开头**新增判断：

```typescript
// 如果 LLM 认为需要澄清，返回一个只有基础信息的 plan，
// 让调用方（Agent）通过 clarify_question 工具向用户提问
if (input.needClarification && input.clarificationQuestions?.length > 0) {
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
      questions: input.clarificationQuestions,
    },
  } as WorkflowPlan & { _clarification?: object };
}
```

注意：`WorkflowPlan` 类型定义里没有 `_clarification` 字段。可以：
- 方案 A：在 `packages/shared/src/types/index.ts` 的 `WorkflowPlan` 接口加上 `_clarification?: { questions: Array<{ field: string; question: string; hint?: string }> }`
- 方案 B：用 `as any` 绕过（不推荐，但改动最小）

---

## 不改的文件

- `apps/api/src/llm/deepseek.client.ts` — 已是 `withStructuredOutput`，无需动
- `apps/api/src/workflow-engine/generator.ts` — 生成逻辑不变，仍然从 plan 映射节点
- `apps/api/src/agent/react-agent.service.ts` — Agent 已有 `clarify_question` 工具，无需动
- `apps/api/src/agent/tools/clarify.tool.ts` — 无需动

---

## 验收标准

1. `pnpm typecheck` 全部通过
2. 新的 `plan-prompt.ts` 体积明显小于旧版（目标 < 1500 字节）
3. 当给一个输入/输出不明确的需求时，LLM 返回 `needClarification: true`
4. 当给一个输入/输出明确的需求时，LLM 正常返回完整规划
5. 不再出现「输出截断」错误

---

## 不要做的事

- 不要保留旧 prompt 的完整内容
- 不要把模型列表/数据库列表放回 prompt（它们应由 `get_platform_facts` 工具提供）
- 不要改 `nodeConfig` 的 zod schema 结构（只新增 `needClarification` 和 `clarificationQuestions`）
- 不要改 `generator.ts` 的生成逻辑
- 不要改 `clarify.tool.ts` 的实现