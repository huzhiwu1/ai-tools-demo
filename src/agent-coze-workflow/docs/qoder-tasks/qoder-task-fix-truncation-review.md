# Codex Review: deepseek-v4-flash 思考模型输出截断问题

## 背景

`agent-coze-workflow` 的 planner 使用 `deepseek-v4-flash`（思考模型）做结构化输出。

**现象**：规划工具连续多次输出截断，JSON 被 `max_tokens` 切断。

**已尝试的修复**：
1. prompt 压缩 73%（4892→1334 字节）— 无效，截断依旧
2. `maxTokens` 从默认值调到 8192 → 16384 — 无效，截断依旧

**根因推断**：`deepseek-v4-flash` 是思考模型，`reasoning_content`（思考过程）和最终 JSON 共享 `max_tokens` 预算。规划任务会触发大量思考，reasoning 吃掉大部分 token 预算，留给 JSON 的不够，导致截断。

## 需要审查的代码

- `apps/api/src/llm/deepseek.client.ts`：ChatOpenAI 构造 + withStructuredOutput 调用
- `apps/api/src/workflow-engine/planner.ts`：调用 chatStructured 的地方
- 用户 env：`LLM_MODEL=deepseek-v4-flash`，`DEEPSEEK_MODEL=deepseek-chat`

## 需要排查的问题

### 问题 1：确认根因

当前 `deepseek.client.ts` 的 ChatOpenAI 构造中 `maxTokens` 被重复设了两次（8192 和 16384），最终有效值是 16384。但截断依旧。

请确认：
- 思考模型的 `reasoning_content` 是否确实和输出共享 `max_tokens` 预算？
- 16384 是否仍不够（reasoning 本身可能超过 10K）？
- 更大的 `maxTokens`（如 32K）能否解决？还是根本治标不治本？

### 问题 2：禁用思考的可行性

DeepSeek API 支持 `thinking: { type: "disabled" }` 参数来关闭思考模式。

请确认：
- 这个参数在 LangChain `ChatOpenAI` 中如何传递？（`modelKwargs`？`configuration`？还是需要自定义 header？）
- 禁用思考后，`withStructuredOutput(jsonMode)` 是否仍然正常工作？
- 关闭思考后，模型（v4-flash）的 JSON 输出质量是否会明显下降？

### 问题 3：切换到非思考模型

用户 env 已备好 `DEEPSEEK_MODEL=deepseek-chat`（非思考模型）。

请确认：
- `deepseek-chat` 在结构化输出任务上的表现是否足够？
- 是否应该让 planner 用 `deepseek-chat`，其他任务（如代码生成）用 `deepseek-v4-flash`？

### 问题 4：最小改动策略

请给出一个明确的方案，满足以下条件：
1. 不再出现截断
2. 改动最小
3. 不影响其他 LLM 调用（如代码生成、Agent 推理）
4. 不改 `planner.ts` / `generator.ts` 等业务逻辑

## 约束

- 只改 `deepseek.client.ts`（如果方案需要）
- 不保留手写 `json_schema` 主路径
- 不回到旧的手动 `response_format` 方案
- 不破坏 `withStructuredOutput` 的稳定性

## 希望的输出格式

1. **根因确认**：一句话说清为什么截断
2. **推荐方案**：A 禁用思考 / B 切 deepseek-chat / C 其他
3. **理由**：为什么这个方案最稳
4. **风险**：这个方案可能的副作用
5. **改动清单**：只列需要改的文件和具体字段，不要写实现代码

---

> 目标：找一个不靠堆 `maxTokens` 的治本方案。思考模型的 reasoning 是规划任务的噪声，关掉它或换非思考模型才是正解。