# Codex Review: Planner Prompt 改成“两段式：先确认输入/输出结构，再做短规划”

## 背景

当前 `agent-coze-workflow` 的规划链路是：

- `apps/api/src/prompts/plan-prompt.ts`：一次性要求 LLM 输出完整结构化 JSON
- `apps/api/src/workflow-engine/planner.ts`：把 LLM 输出映射为 `WorkflowPlan`
- `apps/api/src/llm/deepseek.client.ts`：现在已经切到 `withStructuredOutput(..., { method: "jsonMode" })`，只支持 DeepSeek 官网接口

最近实测暴露一个问题：

- 规划工具连续两次因为输出截断失败
- 一次性规划内容太长，DeepSeek 在思考模型上被 `max_tokens` 截断
- 这不是“模型能力不够”，而是“一个请求里塞了太多规划内容”

同时，用户对这类工作流的核心认知也更明确了：

- 工作流本质上就是一个程序
- 最重要的不是先写一大段规划，而是先搞清楚 **输入结构** 和 **输出结构**
- 这些信息应该优先向用户确认，而不是一股脑让 LLM 自己猜

---

## 当前实现事实

### 1. 结构化输出

`deepseek.client.ts` 已经改成：

- `ChatOpenAI.withStructuredOutput(schema, { method: "jsonMode", name: "extract" })`
- 只支持 DeepSeek 官网接口
- 不再保留手写 `json_schema` 主路径

因此当前结构化能力是稳定的，问题不是“怎么 parse”，而是“planner prompt 给得太重”。

### 2. 现有 planner prompt 过重

当前 `plan-prompt.ts` 要求 LLM 一次输出很多内容，包括：

- `mode`
- `name`
- `goal`
- `inputType`
- `outputType`
- `needBranch`
- `needCodeNode`
- `needDatabaseNode`
- `startInputs`
- `constraints`
- `riskHints`
- `nodeConfig`
- `steps`
- `contracts`

其中最容易膨胀、最容易被模型“自由发挥”的是：

- `steps`
- `contracts`
- `nodeConfig`

尤其当需求本身涉及输入/输出格式不明确时，模型会先试图把整个工作流都规划完，最终把 token 打爆。

### 3. planner.ts 的职责

`planner.ts` 现在做的是：

- 调 `chatStructured()` 拿 `LLMPlanOutput`
- 再把它映射成 `WorkflowPlan`
- 其中会补 start/end、拓扑顺序、默认描述等

这意味着：

- LLM 不需要承担“完整工作流生成器”的职责
- LLM 更适合做“需求澄清 + 轻量规划”
- 真正的结构拼装应该继续由代码完成

---

## 我准备的改动方向

### 方案：改成两段式

#### 第 1 段：先确认输入/输出结构

如果用户需求里的输入/输出结构不清楚，先问清：

- 输入是什么
- 输出是什么
- 字段名、类型、必填/可选
- 是否有数组、对象嵌套
- 是否有示例数据
- 是否有格式/校验约束

这一段的目标不是输出完整工作流，而是把“程序接口”定义清楚。

#### 第 2 段：再做短规划

在输入/输出结构明确后，再让 LLM 输出一个短规划，只保留：

- `mode`
- `name`
- `goal`
- `inputType`
- `outputType`
- `needBranch`
- `needCodeNode`
- `needDatabaseNode`
- `startInputs`
- `constraints`
- `riskHints`
- `steps`
- `contracts`
- `nodeConfig`

但要求：

- `steps` 尽量短
- `contracts` 尽量短
- `nodeConfig` 只保留必要字段
- 不要输出冗长解释
- 不要一次性把所有边界情况都铺开

---

## 需要 Codex 重点审查的问题

### 问题 1：这个“两段式”方向是否比现在的一次性规划更合理？

请判断：

- 是否应该先把输入/输出结构问清楚，再进入规划
- 是否应该让 planner 先返回“需要澄清的问题”，而不是直接尝试完整规划
- 这样做会不会比现在更稳、更符合工作流是“程序”的本质

### 问题 2：应该在哪一层实现“两段式”？

请判断应该改哪些文件：

- `apps/api/src/prompts/plan-prompt.ts`
- `apps/api/src/workflow-engine/planner.ts`
- 是否需要新增一个 clarification prompt / clarification schema

### 问题 3：怎么避免 prompt 再次过长？

请判断：

- 现有 prompt 里哪些描述应该删掉或大幅压缩
- 哪些规则应该下沉到代码校验，而不是继续堆在 prompt 里
- `steps/contracts/nodeConfig` 这三块应该保留到什么程度

### 问题 4：是否应该在需求不完整时直接问用户，而不是硬规划？

请判断：

- 当输入/输出结构不明确时，planner 是否应该返回澄清问题
- 还是继续尝试“猜一个默认结构”
- 哪种策略更符合这个项目的实际使用场景

---

## 审查时请注意的现有约束

1. 当前结构化输出只走 DeepSeek 官网接口
2. 当前 `chatStructured()` 已经用 `withStructuredOutput(..., { method: "jsonMode" })`
3. 不要建议回退到手写 `json_schema` 主路径
4. 不要建议继续把 prompt 无限制加长
5. 不要建议让 LLM 一次性输出更大的规划内容
6. 不要破坏 `planner.ts` 里现有的“结构组装交给代码”的思路

---

## 希望的审查输出格式

请按下面格式回答：

1. **结论**：支持 / 不支持 两段式规划
2. **理由**：为什么这样更稳，或者为什么不该这样做
3. **风险**：这个方案最可能踩的坑
4. **最小改动建议**：只列需要改的文件和方向，不要写实现代码
5. **prompt 压缩建议**：哪些内容该删、该保留、该下沉到代码

---

## 当前需要先确认的关键点

如果你认为这条路线不合理，请直接指出：

- 是否应该仍然保持“一次性规划”，只是在 prompt 里大幅删减内容
- 是否应该只把 `steps/contracts` 下沉到代码，不让 LLM 输出
- 是否应该先做一个“澄清问题”链路，再考虑规划

> 目标不是让 prompt 更长，而是让 planner 更稳定、输出更短、把接口（输入/输出结构）先问清楚。
