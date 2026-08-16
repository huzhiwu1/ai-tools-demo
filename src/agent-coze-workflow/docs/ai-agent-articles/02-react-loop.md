# ReAct 循环：Agent 的心脏

## 什么是 ReAct

ReAct 是 **Reason + Act（推理 + 行动）** 的缩写，由 Shunyu Yao 等人在 2022 年提出。核心思想：让 LLM 交替进行"思考"和"行动"，并把行动结果（观察）喂回给下一次思考，形成循环。

```
思考(Thought) → 行动(Action) → 观察(Observation) → 思考 → 行动 → 观察 → ... → 回答
```

为什么这个简单的循环这么重要？因为单次 LLM 调用有两个致命短板：

1. **知识截止**：模型不知道平台当前的接口、你上传的文件内容。
2. **一步到位的幻觉**：让模型"一次生成完美结果"，复杂任务几乎必错。

ReAct 用"小步快跑 + 每步看反馈"化解了这两个问题。

## 循环的四个状态

| 状态 | 做什么 | 谁执行 |
| ---- | ------ | ------ |
| Thought | 分析现状、决定下一步 | LLM |
| Action | 调用一个工具（带参数） | LLM 输出 → 代码执行 |
| Observation | 拿到工具返回的结果 | 工具代码 |
| Final Answer | 没有下一步动作时，给出最终回答 | LLM |

关键点：**Thought 和 Action 是 LLM 生成的，Observation 是真实代码执行的**。这保证了 Agent 的"手脚"是确定性的，只有"脑袋"是概率性的。

## 本项目中的 ReAct 实现

项目用 LangGraph 的 `createReactAgent` 实现循环，核心在 `apps/api/src/agent/react-agent.service.ts`：

```ts
import { createReactAgent } from "@langchain/langgraph/prebuilt";

const agent = await createReactAgent({
  llm,
  tools: ALL_TOOLS,
  checkpointer: new MemorySaver(),
  stateModifier: systemPrompt,
});
```

一次真实对话中，Agent 的循环长这样：

```text
Thought: 用户没说数据源，信息不完整
Action:  调用 clarify_question("请提供数据源")
← interrupt 暂停，等用户回答
Observation: 用户回答: 使用 lyrics 表
Thought: 信息齐了，先规划工作流
Action:  调用 plan_workflow(需求描述)
Observation: planId=xxx, steps=[...]
Thought: 规划完成，生成工作流 JSON
Action:  调用 generate_workflow(planId=xxx)
...
Final Answer: 工作流已创建，workflowId=xxx，准确率 100%
```

这就是一个标准的 ReAct 循环，只不过每个 Action 都对应项目里的真实业务工具。

## 循环什么时候结束？

这是排查 Agent 问题最实用的知识点。LangGraph 的判定逻辑只有一条（`react_agent_executor.js`）：

> 最后一条消息是 AI 消息，且**没有 tool_calls** → 结束循环。

换句话说：Agent 停止，永远是因为 **LLM 自己决定不再调用工具了**。理解这一点，很多"Agent 半路停了"的困惑就能解开——不是超时、不是异常，是模型"认为"任务完成了。

那模型为什么会误判"完成"？常见原因：

1. 规划完就以为做完了（规划 ≠ 交付）
2. 上下文太长，模型"忘了"后续步骤
3. 下一步要背一大段 JSON，模型直接放弃
4. 提示词没有约束住"信息不全时必须澄清"

本项目的对策：

- 系统提示词明确要求"规划 → 生成 → 部署 → 试运行 → 验证"按顺序执行（[react-agent.service.ts](../../apps/api/src/agent/react-agent.service.ts)）
- 工具参数用**句柄**（planId / workflowId）而不是大 JSON，降低模型负担
- 关键工具配**迭代上限**（如 batch_validate 最多 3 轮），防止无限循环

## 循环中的暂停与恢复：interrupt / resume

纯 ReAct 循环有个问题：Agent 需要**问用户**时怎么办？LangGraph 提供了 `interrupt()`：

```ts
// apps/api/src/agent/tools/clarify.tool.ts
const answer = await interrupt({ question, context });
return `用户回答: ${answer}`;
```

`interrupt()` 会暂停图执行，把控制权交回外部（本项目通过 SSE 推送 `interrupt` 事件给前端），用户回答后再用 `Command({ resume: answer })` 恢复。这解决了 Agent 交互中一个经典难题：**Agent 的循环不是只能自己跑，它还能"停下来等人"**。

## 工程要点

### 流式输出

ReAct 的每一步都应该让用户看见：思考文本增量推送、工具调用事件（`tool_start` / `tool_end`）、中断事件。本项目用 Vercel AI SDK 的 Data Stream Protocol 实现，前端 `useChat` 直接消费。

### 超时与上限

循环没有上限会变成"死循环烧钱"。除了工具级迭代上限，还要考虑整体轮次上限和超时兜底。

### 错误回灌

工具报错不应直接中断，而是作为 Observation 喂回 LLM，让它"换个思路再来"。比如 JSON 参数解析失败，LangGraph 会把错误作为 ToolMessage 回灌，模型会尝试修正参数。

## 核心要点

- ReAct = 思考 + 行动 + 观察的循环，行动是代码执行，思考是模型推理
- 循环终止条件只有一个：最后一条消息没有 tool_calls
- "Agent 半路停了"的排查方向：模型误判完成，而不是怀疑框架
- interrupt/resume 让 Agent 可以暂停下来问用户，这是真实产品必不可少的
- 工具参数越小越好（句柄化），大 JSON 会诱发模型放弃

## 延伸思考

- 如果 Agent 连续 3 次调用同一个工具且结果一样，应该怎么办？（提示：需要"循环检测"）
- interrupt 除了问用户，还能用在哪些地方？比如人工审批、多 Agent 交接。
