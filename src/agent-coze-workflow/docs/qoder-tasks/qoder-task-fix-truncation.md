# Qoder Task: 禁用 deepseek-v4-flash 思考模式，解决输出截断

## 背景

`agent-coze-workflow` 的 planner 使用 `deepseek-v4-flash`（思考模型）做结构化输出。
连续多次输出截断——JSON 被 `max_tokens` 切断。

**已尝试的修复（无效）**：
1. prompt 压缩 73%（4892→1334 字节）— 截断依旧
2. `maxTokens` 从默认调到 8192 → 16384 — 截断依旧

## 根因

`deepseek-v4-flash` 是思考模型，API 返回时会先产生 `reasoning_content`（思考过程），
然后是最终 JSON。**两者共享 `max_tokens` 预算**。

规划任务触发大量思考（reasoning 轻松吃掉 5-10K tokens），留给 JSON 的预算不够，
最终输出被截断。

**堆 `maxTokens` 治标不治本**：reasoning 可能无限膨胀，16000 也不一定够。

## 源码分析结论

LangChain `@langchain/openai` 1.5.6 的 `ChatOpenAI` 构造器支持 `modelKwargs` 字段。
在 `invocationParams()` 中（`completions.js:50`），`...this.modelKwargs` 被展开到
请求 body 中。

```js
// completions.js invocationParams 关键行
params = {
  model: this.model,
  ...
  ...this.modelKwargs,  // ← 任意额外参数被透传
  ...
};
```

DeepSeek API 的思考模式通过 `thinking: { type: "disabled" }` 控制：
```json
{
  "model": "deepseek-v4-flash",
  "messages": [...],
  "thinking": { "type": "disabled" }
}
```

另外注意：`isReasoningModel("deepseek-v4-flash")` 返回 `false`（LangChain 只识别
`o\d` 和 `gpt-5` 系列为推理模型），所以 LangChain 不会自动把 `maxTokens` 映射为
`max_completion_tokens`，这对 DeepSeek 来说是正确行为。

## 修改方案

**只改一个文件：`apps/api/src/llm/deepseek.client.ts`**

在 `ChatOpenAI` 构造器中添加 `modelKwargs`：

```typescript
this.model = new ChatOpenAI({
  apiKey,
  configuration: { baseURL },
  model: modelName,
  temperature: 0.2,
  maxRetries: 1,
  timeout: config?.timeout ?? 60_000,
  maxTokens: 8192,         // 关思考后 8K 够用，无需 16K
  // 禁用思考模式：deepseek-v4-flash 的 reasoning_content 与 JSON 输出
  // 共享 max_tokens 预算，reasoning 吃掉大量 token 导致 JSON 截断。
  // thinking: { type: "disabled" } 通过 modelKwargs 透传到请求 body，
  // 关闭思考后所有 token 预算都给 JSON 输出。
  modelKwargs: { thinking: { type: "disabled" } },
});
```

**同时删除重复的 `maxTokens` 行**（当前代码设了两次 8192 和 16384），只保留一个 8192。

## 不改的文件

- `apps/api/src/prompts/plan-prompt.ts` — 已压缩，无需动
- `apps/api/src/workflow-engine/planner.ts` — 无需动
- `apps/api/src/workflow-engine/types.ts` — 无需动
- `apps/api/src/agent/react-agent.service.ts` — 无需动（Agent 用的是另一个 ChatOpenAI 实例）

## 验收标准

1. `pnpm typecheck` 通过
2. 规划不再出现截断
3. 日志中不再出现 `reasoning_content`（或显著减少）
4. 结构化输出 JSON 完整可解析

## 备选方案（如果方案 A 不可行）

如果 `modelKwargs: { thinking: { type: "disabled" } }` 在 LangChain 1.5.6 中未被正确透传：

**方案 B：切换到 `deepseek-chat`（非思考模型）**

修改 `deepseek.client.ts` 的默认 model：
```typescript
const modelName = config?.model ?? process.env.LLM_MODEL ?? "deepseek-chat";
```
把 fallback 从 `deepseek-chat` 提升为默认。

`deepseek-chat` 不是思考模型，没有 `reasoning_content`，所有 token 预算都给输出。
代价是推理能力略弱于 v4-flash，但对结构化输出任务影响不大。

## 不要做的事

- 不要继续堆 `maxTokens`（治标）
- 不要改 `planner.ts` 或 `generator.ts`
- 不要回到手写 `json_schema` 方案
- 不要改 `react-agent.service.ts` 的 ChatOpenAI 实例（那是 Agent 用的，不是 planner 用的）