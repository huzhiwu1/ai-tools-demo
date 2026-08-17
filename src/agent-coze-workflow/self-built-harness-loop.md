# 自建 Harness 式主循环重构文档（LangGraph 彻底移除）

> 日期：2026-08-17
> 范围：`apps/api/src/agent/` 下 4 个源文件 + 依赖清单
> 决策：激进方案——对齐 DeepSeek Harness 架构，删除一切阻碍代码，不在屎山上叠加修补

---

## 一、背景与动机

### 1.1 崩溃现象

用户实测：**只要 LLM 在思考中（主模型流式输出飞行中），打断并发送新消息，Node.js 进程必然崩溃**（Node v24.19.0，fatal error，非可捕获异常）。

### 1.2 根因

崩溃不是项目代码直接抛出的，而是 LangGraph 内部的同步信号转发链：

```
handleChat 打断 → abort("user-interrupt")
  → LangGraph combineAbortSignals（pregel/utils/index.ts）同步转发 listener
  → raceWithSignal（@langchain/core signal.js）同步 reject 底层 promise
  → 该 promise 的 rejection 在同步 abort 链中失去消费者
  → unhandled rejection → Node v24 严格策略 → 进程崩溃
```

**关键结论**：这是 LangGraph 编排层的内在缺陷，`try/catch` 包裹 `abort()` 调用点无法捕获（异常在异步链上抛出）。曾有两类尝试：

| 路径 | 触发方式 | 状态 |
| --- | --- | --- |
| 终止路径（步数上限/死循环/截断终止） | `stream.cancel()` | 已修复（commit 0127546） |
| **打断路径（用户主动打断）** | 外部 `abort("user-interrupt")` | **无法在 LangGraph 层修复** |

### 1.3 决策

在 LangGraph 层修补打断路径被证明无解后，选择**激进方案**：彻底移除 LangGraph 编排，自建 DeepSeek Harness 式 `kick → turn → step` 主循环。核心理由：

- **abort 在自建循环内是安全的**：所有 promise（LLM 流、工具调用、driver 收敛）都由本服务创建并在 turn 层捕获，没有第三方同步转发链
- **架构对齐 Harness**：Phase 状态机、Inbox 队列、双层循环、max_tokens 粘性等生产级模式直接落地
- **清除补偿代码**：LangGraph checkpoint 丢失 ToolMessage 等历史问题逼出的各类补丁（`summarizeToolResult`、`saveInterruptedState` 等）全部失去存在意义

---

## 二、改动内容

### 2.1 文件改动总览

| 文件 | 改动 | 旧行数 | 新行数 |
| --- | --- | --- | --- |
| `apps/api/src/agent/session.store.ts` | 重写 | 187 | 202 |
| `apps/api/src/agent/react-agent.service.ts` | 重写 | 1366 | 1134 |
| `apps/api/src/agent/tools/clarify.tool.ts` | 改造 | 44 | 46 |
| `apps/api/src/agent/tools/index.ts` | 清理 | 250 | 240 |
| `apps/api/package.json` | 删依赖 | - | -1 行 |
| `pnpm-lock.yaml` | 自动更新 | - | langgraph 相关条目清零 |

### 2.2 session.store.ts（重写）

**删除**：

- `graph: CompiledStateGraph` 字段（每个会话持有独立 graph + MemorySaver checkpointer 的整套机制）
- `AgentTurnState` 接口（`currentTurn/currentStep/turnEndReason/maxStepsPerTurn` 平铺结构）
- `SessionMessage` 接口（`role: "user" | "assistant" | "tool"` 自定义消息格式）
- 旧版 `Inbox` 接口（`nextStep` 用于存放工具结果摘要的补偿机制）
- `sessionStore.create(graph, sessionId)` 签名（返回 string）

**新增（对齐 Harness）**：

- `Phase` 联合类型：`{ kind: "idle"; lastTurn } | { kind: "running"; abort; turn; step; wakeRequested }`——状态与 AbortController 绑定，同一时刻最多一个 driver
- `Inbox` 类：`nextTurn`（用户消息）/ `nextStep`（系统注入警告）+ `claimTurn()/claimStep()/clear()/hasPending`
- `Session.history: BaseMessage[]`：**权威对话记录**，直接用 LangChain 消息类型，工具结果以 `ToolMessage` 写入，打断后不丢失
- `PendingClarify`：clarify 挂起状态（`question/context`）
- `Session.driverDone: Promise<void>`：打断方 await 它等待旧 driver 收敛
- `create(sessionId?)` 返回 `Session` 对象

### 2.3 react-agent.service.ts（重写）

**删除的 LangGraph 编排与补偿代码**：

| 删除项 | 旧用途 | 删除原因 |
| --- | --- | --- |
| `createReactAgent` / `MemorySaver` / `createGraph()` | 每会话建 graph + checkpointer | 编排层整体移除 |
| `Command({ resume })` | LangGraph interrupt 恢复 API | 改为自建挂起协议 |
| `graph.streamEvents()` | 事件拦截式流式迭代 | 改为直连 `llm.stream()` |
| `graph.getState()` | interrupt 检测 / 最终消息提取 | 无 graph 可查 |
| `cancelStream()` | 终止底层 graph 执行流 | 无底层流可取消 |
| `saveInterruptedState()` | 中断前从 checkpoint 抢救 AI 回复 | AI 消息直接落 history，无需抢救 |
| `extractInterruptData()` | 解析 `state.tasks[].interrupts[]` | interrupt 由标记协议替代 |
| `extractFinalContent()` | 从 state 提取最终消息 | 由 `lastAssistantText(history)` 替代 |
| `extractToolContent()` | 解析 ToolMessage 序列化格式 | 工具结果直接可读，无需反序列化 |
| `summarizeToolResult()` | 12 个工具各自的摘要策略（打断恢复记忆） | 工具结果已在 history，打断不丢 |
| 打断后的 `session.graph = createGraph()` 重建 | checkpoint 残留半截状态的补救 | 无 checkpoint |
| 消息重复防护（打断后传全历史 vs 正常只传增量） | checkpoint 与手动历史并存导致的重复 | 单一 history 来源，无重复问题 |

**新增的自建主循环**：

```
handleChat / handleResume（对外入口）
  └─ abortAndAwait()         打断旧 driver + 等待收敛（5s 超时兜底）
  └─ runDriver()             driver 生命周期 = 本次 HTTP 请求
       ├─ kick()              主循环边界（包含一切失败）
       ├─ turn()              turn 循环：claim 消息 → step 循环 → SSE 收尾
       ├─ step()              单步：llm.stream 流式累积 + 落 history
       ├─ executeToolCalls()  工具顺序执行 + 死循环拦截 + clarify 挂起
       ├─ invokeTool()        按名调用注册工具（传 signal）
       └─ buildMessages()     滑动窗口 + 孤儿 ToolMessage 自愈
```

**模块级辅助函数**：`parseToolArguments`（JSON 解析保底）、`extractTextContent`（string/content blocks 兼容）、`stringifyToolOutput`、`errorChainText`（cause 链拼接）、`isClarifyMarker`（类型守卫）、`lastAssistantText`。

**保留不动**：`SYSTEM_PROMPT`（完整原文）、`llm` 实例（模型/网关/thinking 关闭/maxTokens 16384/timeout 60s/maxRetries 1 全部配置）、`setSSEHeaders`、`appendEvent`（事件日志）、25 步上限、死循环 4 次拦截、max_tokens 粘性语义。

### 2.4 clarify.tool.ts（改造）

- **旧**：`import { interrupt } from "@langchain/langgraph"`，工具内 `await interrupt({question, context})` 阻塞等待，resume 时 LangGraph 把 answer 注入为返回值
- **新**：工具立即返回 `{ __clarify: true, question, context }` 标记，不阻塞。挂起/恢复由服务层驱动（见 3.3）

### 2.5 tools/index.ts（清理）

- 删除 `withToolLog` 中 `e.name === "GraphInterrupt"` 特判分支（interrupt 已不存在于工具层）
- 更新过时注释（"供 createReactAgent 使用" → "供自建主循环 bindTools 使用"）
- `withToolTimeout` / `withToolLog` 包装机制、`ALL_TOOLS` 12 个工具、`DEFAULT_TOOL_TIMEOUT_MS`/`TOOL_TIMEOUT_OVERRIDES` 全部保留

### 2.6 依赖

- `apps/api/package.json`：移除 `"@langchain/langgraph": "^1.4.9"`
- `pnpm-lock.yaml`：`langgraph` / `langgraph-checkpoint` / `langgraph-sdk` 条目全部清零（grep 0 匹配）
- 源码全局 grep `@langchain/langgraph`：仅剩历史文档（markdown），无代码引用

---

## 三、改动后的效果

### 3.1 崩溃消除

```
旧链路：abort → LangGraph 同步转发链 → 无消费者 rejection → Node v24 崩溃
新链路：abort → 自建循环内 signal.throwIfAborted() → AbortError 被 turn 层 catch
        → 分类为 aborted → driver 边界收尾 → 安全退出
```

每个 promise 的创建者与消费者都在 `react-agent.service.ts` 内，`AbortError` 的传播路径完全可控。**没有 LangGraph，就没有转发链，崩溃无从发生**。

### 3.2 打断行为语义

1. 新消息到达（`handleChat`）→ 若 phase=running：`abort("user-interrupt")` + await `driverDone`（最长 5s）
2. 旧 driver 在最近的 chunk 检查点退出：半截 AI 输出**不落 history**（保持上下文干净）
3. 已落 history 的半截工具序列（AIMessage 有 tool_calls 但 ToolMessage 不全）由 `buildMessages` 自愈补位
4. 新消息入队 → 新 driver 启动 → 前端收到 `aborted` 提示 + 新 turn 开始

**关键改进**：旧实现打断后必须重建 graph、靠 `summarizeToolResult` 摘要恢复记忆；新实现工具结果直接写在 history 里，打断**零丢失**、**零补偿代码**。

### 3.3 clarify 挂起/恢复流程（替代 LangGraph interrupt）

```
LLM 调用 clarify_question
  → 工具返回 { __clarify: true, question, context }
  → 服务层：写占位 ToolMessage「（等待用户回答中）」+ pendingClarify 保存
  → SSE 推送 d:{type:"interrupt", question, context, sessionId}（协议不变）
  → driver 收尾（turn 不记结束，等待回答）

用户回答 → POST /api/agent/chat/resume
  → 占位 ToolMessage 替换为「用户回答: xxx」（含文件引用）
  → 重启 driver 继续原 turn
  → LLM 看到 clarify_question 的工具结果即用户回答（与原 interrupt 语义等价）
```

### 3.4 前端零改动

SSE Data Stream 协议完全不变：`0:` 文本增量、`d:` 结构化事件（session/turn_start/tool_start/tool_end/reasoning_delta/interrupt/done/aborted/error/step_limit/loop_detected）、`e:finish` 结束标记，以及 `/api/agent/chat`、`/api/agent/chat/resume`、`/api/agent/upload` 三个端点全部保持原样。

---

## 四、具备的能力

新架构自建主循环完整具备以下能力（均对齐 Harness 语义）：

| 能力 | 实现 | 说明 |
| --- | --- | --- |
| **Phase 状态机** | `idle{lastTurn} \| running{abort, turn, step}` | 同一时刻最多一个 driver，状态与 AbortController 绑定 |
| **双层循环** | `kick → turn → step` | turn = 用户交互边界，step = 一次 LLM 调用边界 |
| **安全打断** | 自建 abort + turn 层分类 | chunk 级检查点（LLM 流中逐 chunk `throwIfAborted`） |
| **driver 收敛保护** | identity guard + 5s 超时 | 超时未收敛的旧 driver 不会破坏新 driver 的 phase |
| **步数上限** | `MAX_STEPS_PER_TURN = 25` | 每 turn 最多 25 次 LLM 调用，防止死循环 |
| **死循环拦截** | 同工具同参数连续 4 次 | 第 4 次不执行，警告注入下轮上下文 |
| **max_tokens 粘性** | `finish_reason === "length"` | 截断时跳过其 tool_calls（参数不可靠）；曾截断的 turn 不被降级；连续 2 次截断终止 |
| **clarify 挂起/恢复** | `__clarify` 标记 + `pendingClarify` | 不依赖任何编排框架，语义与原 interrupt 等价 |
| **孤儿 ToolMessage 自愈** | `buildMessages` | 打断/截断留下的半截 tool_calls 自动补合成 aborted 结果 |
| **滑动窗口** | `MAX_HISTORY_MESSAGES = 40` | 控制 LLM 上下文长度，窗口头孤立 ToolMessage 裁剪 |
| **空回复保护** | 无内容且无 tool_calls 拦截 | 静默空回复 bug 的根因拦截 |
| **事件日志** | 9 种事件类型，1000 条上限 | turn/step/tool/llm/error/aborted 全生命周期可回溯 |
| **工具超时隔离** | `withToolTimeout` 包装保留 | 单工具 120s（batch_validate 300s），超时不影响主循环 |
| **客户端断开兜底** | `res.on("close")` + `res.destroyed` 双检查 | 关标签页即时补发 abort |
| **多轮对话** | 单一 history 来源 | 无 checkpoint 与手动历史并存导致的重复消息问题 |

---

## 五、与之前对比

### 5.1 架构对比

| 维度 | 旧（LangGraph 编排） | 新（自建 Harness 主循环） |
| --- | --- | --- |
| 编排方式 | `createReactAgent` 黑盒 ReAct 图 | 自建 `kick → turn → step` 显式循环 |
| 状态存储 | MemorySaver checkpointer（按 thread_id） | `Session.history: BaseMessage[]` 内存记录 |
| 流式输出 | `graph.streamEvents()` 事件拦截（6 处 switch case） | `llm.stream()` 直连，chunk 级控制 |
| interrupt | LangGraph `interrupt()` + `Command(resume)` | `__clarify` 标记 + `pendingClarify` 挂起协议 |
| abort 安全 | ❌ 崩溃（combineAbortSignals 同步转发链） | ✅ 安全（全部 promise 自建自捕获） |
| 打断后恢复 | graph 重建 + 工具摘要补偿（`summarizeToolResult`） | 工具结果已在 history，零补偿 |
| 依赖 | `@langchain/langgraph` + checkpoint + sdk（3 个包） | 仅 `@langchain/core` + `@langchain/openai` |
| 消息传递 | checkpoint 自动恢复 vs 手动 history 并存 → 曾致重复消息 | 单一 history 来源，`buildMessages` 统一组装 |

### 5.2 关键行为对比

| 场景 | 旧行为 | 新行为 |
| --- | --- | --- |
| LLM 思考中打断并发送 | **进程崩溃**（unhandled rejection） | 旧 driver 安全收敛，新 turn 立即开始 |
| 工具执行中打断 | 可存活（工具链有 catch），但 checkpoint 残留半截状态需重建 graph | 已完成的工具结果留在 history，半截序列自愈 |
| 打断后的上下文恢复 | 靠 `summarizeToolResult` 摘要（有损、需 12 个工具各写策略） | 完整 ToolMessage 原文（无损） |
| clarify 提问 | 图执行挂起于 interrupt 点，靠 checkpoint 恢复 | 占位 ToolMessage + 挂起状态，resume 替换为回答 |
| 步数上限/死循环终止 | 需 `saveInterruptedState` 抢救 AI 回复（曾致静默空回复） | AI 消息逐步落 history，无抢救需求 |
| 终止路径 | `cancelStream` 调用底层流的 `cancel()`（曾致崩溃） | turn 层直接 break，无底层流 |
| 多轮对话 | checkpoint 与手动 messages 并存，曾出现消息重复 → 空回复 | 单一 history 组装，无重复可能 |

### 5.3 代码量对比

| 文件 | 旧 | 新 | 变化 |
| --- | --- | --- | --- |
| react-agent.service.ts | 1366 行 | 1134 行 | -232 行（-17%） |
| session.store.ts | 187 行 | 202 行 | +15 行（接口更完整） |
| clarify.tool.ts | 44 行 | 46 行 | +2 行 |
| tools/index.ts | 250 行 | 240 行 | -10 行（删特判） |

净减少 225 行，且删掉的正是最复杂、最易出错的补偿逻辑（事件拦截 6 点、12 工具摘要策略、checkpoint 抢救三件套）。

### 5.4 删除清单（LangGraph 时代遗留，全部清除）

`createReactAgent`、`MemorySaver`、`Command`、`streamEvents`、`getState`、`cancelStream`、`saveInterruptedState`、`extractInterruptData`、`extractFinalContent`、`extractToolContent`、`summarizeToolResult`、`Session.graph` 字段、`AgentTurnState`、`SessionMessage`、graph 重建逻辑、GraphInterrupt 特判。grep 验证：`turnState/AgentTurnState/session.messages/session.graph/createGraph/streamAgentEvents` 等旧标识符 **0 匹配**。

---

## 六、验证结果

| 验证项 | 结果 |
| --- | --- |
| `pnpm typecheck`（tsc --noEmit） | ✅ 零错误 |
| `nest build`（install postinstall） | ✅ 通过 |
| 旧 API 引用 grep | ✅ 0 匹配 |
| `@langchain/langgraph` 源码引用 | ✅ 0 匹配（仅历史文档残留） |
| pnpm-lock.yaml langgraph 条目 | ✅ 0 匹配 |
| 前端协议 | ✅ 未触碰（App.tsx 零改动） |

**待实测**：重启 dev server 后，验证「LLM 思考中打断并发送」不再崩溃、clarify 提问卡片的 resume 流程正常。

---

## 七、后续维护注意事项

1. **不要再引入 LangGraph**：若未来需要多 Agent 编排或跨进程 checkpoint 持久化，需重新评估并在引入前验证其 abort 行为（本文档 1.2 的崩溃根因是硬约束）
2. **工具结果直接写 history 是设计保证**：新增工具时不要回到"摘要记忆"思路，ToolMessage 完整落库是打断无损恢复的基础
3. **driver 收敛依赖 identity guard**：修改 `runDriver` 的 finally 时保持 `session.phase === phase` 判定，超时接管场景依赖它
4. **`buildMessages` 是唯一组装入口**：修改消息窗口策略（40 条）或新增消息类型时，自愈逻辑必须同步评估
5. **SSE 协议是前端契约**：新增事件类型需同步改 `apps/web/src/App.tsx` 的 data 事件处理
