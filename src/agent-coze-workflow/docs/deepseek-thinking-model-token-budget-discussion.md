# DeepSeek 思考模型 Token 预算截断问题讨论

> 记录时间：2026-08-14
> 相关文件：`apps/api/src/llm/deepseek.client.ts`、`apps/api/src/workflow-engine/planner.ts`
> 性质：问题讨论与架构分析（未改代码）

## 背景

agent-coze-workflow 使用 dachensky 网关的 `deepseek-v4-flash`（思考模型）。三类 LLM 调用中，`plan_workflow`（planner 输出完整 steps + contracts + nodeConfig 结构化 JSON）最容易出现 JSON 截断，导致 `StructuredOutputParser` 解析失败。

已确认的根因：**思考模型的 `reasoning_content` 与最终 `content` 共享同一个 max_tokens（completion）预算**。ChatOpenAI 未显式设置 `maxTokens` 时走服务端默认值（DeepSeek 系默认约 4K），规划任务的思考过程轻松吃掉 2-5K token，剩余预算不足以输出完整 JSON，被硬切后 `JSON.parse` 失败。

---

## 一、关键概念：两种「不输出思考过程」

「不输出思考过程」有歧义，效果完全不同：

| 做法 | 是否解决截断 | 原因 |
|---|---|---|
| 客户端忽略/不展示 `reasoning_content` | ❌ 没用 | 思考 token 已在服务端生成，照样占预算、计费、占延迟 |
| 让模型跳过思考阶段（thinking disabled） | ✅ 明显改善 | completion 预算 100% 留给 JSON，截断根因消失 |

## 二、思考模型的预算机制

一次 completion 分两段生成：

1. `reasoning_content`：内部推理链，规划任务轻松吃掉 2-5K token
2. `content`：最终答案（结构化 JSON）

两段**共享同一个 max_tokens 预算**，这就是截断的完整链路：思考吃掉大半 → JSON 写到一半被硬切 → 解析失败。

## 三、候选方案对比

### 方案 A：禁用思考，保持 v4-flash

```typescript
modelKwargs: { thinking: { type: "disabled" } }
```

- **收益**：截断消失、成本下降、延迟下降、降低 token 型限流压力
- **代价**：规划任务恰恰是 CoT 收益最大的场景（任务分解、依赖分析、多步权衡都靠推理链），关思考等于自废武功；两段式 prompt 语义理解可能退化；复杂 JSON 错误率可能上升，需 schema 约束 + 解析失败重试兜底
- **风险**：`thinking` 参数在网关层可能被静默忽略，改完必须验证（响应里 `reasoning_content` 是否还在、JSON 是否完整）

### 方案 B：切换到 deepseek-chat（非思考模型）

- **收益**：简单可靠，一行改动；无 reasoning_content，输出全是 JSON
- **代价**：本质是「更弱的模型 + 同样没有思考」，planner 场景通常劣于方案 A

### 方案 C：保留思考 + 显式提额

- 截断根因是「共享预算 + 预算太小」，而非「思考本身」
- 显式设大 `maxTokens`（如 16000）：思考吃 5K，还剩 11K 给 JSON，推理质量与完整输出兼得
- **代价**：延迟更长、单次费用更高；思考长度与质量存在边际递减

> 注：当前项目已采用显式 `maxTokens: 8192`（见 deepseek.client.ts），属于方案 C 的保守版本，已实测验证 8192 被网关接受且足够长 JSON 输出。

### 建议

- JSON 输出只有 1-2K → 方案 A 更划算（思考收益 < 完整 JSON 收益）
- 规划质量下降不可接受 → 方案 C（提额保思考）
- 决策方式：同一批 prompt 做对照实验（A vs C），对比 JSON 完整率 + plan 质量

## 四、为什么 Qoder 能看到思考过程却不被截断

Qoder（编码 Agent）与一次性 planner 的核心区别：**单次 completion vs Agent 循环**。

| 维度 | 一次性 planner | Agent 类产品（如 Qoder） |
|---|---|---|
| 输出形态 | 一次 completion 吐完整 JSON | 多轮小 completion + 工具分块 |
| 预算 | 思考 + JSON 共享一次预算 | 每轮独立预算，单轮输出很小 |
| 截断后果 | 致命（JSON.parse 失败） | 可恢复（下一轮续写） |

具体机制（行业通用架构）：

1. **每步独立预算**：Agent 循环中每轮 LLM 调用是全新 completion，各有各的 max_tokens。上一轮思考吃掉多少，不影响下一轮。单轮只产出一个小决策（调哪个工具 / 写哪段代码），几乎不可能超预算。
2. **长内容分块落盘**：不让模型一次吐完大文件，而是多轮输出「Write 工具 + 小段内容」，几百行代码拆成十几个小 completion，每个都远低于预算上限。
3. **截断可恢复**：即使某轮命中上限，下一轮基于上下文「接着写」即可无损续上；而一次性 JSON.parse 没有第二次机会。
4. **思考只是展示层**：`reasoning_content` 增量流式渲染，不参与解析；真正执行的动作（工具调用参数）在 `content` 里，且很短。
5. **产品侧显式配置预算**：对 reasoning 模型显式设置较大的 max output tokens，或优先选支持「思考预算与输出预算分离」的 API（如 Anthropic thinking budget、OpenAI reasoning_effort）。

**本质**：不是「Qoder 的思考不占预算」，而是「Qoder 从不把大输出押在单次 completion 上」。

## 五、对 planner 的启示

与其纠结 maxTokens 设多大，不如考虑架构解法：

- 把 planner 从「一次吐完整 plan JSON」改为**分步/流式输出**（先 steps 骨架 → 逐个补 details），或用工具调用逐段写入
- 这样每个小输出的预算需求远低于上限，截断风险从架构上消除，而不是靠参数兜底
- 架构上的解法比参数上的解法更彻底
