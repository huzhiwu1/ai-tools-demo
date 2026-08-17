# 借鉴 DeepSeek Harness Agent 主循环设计

## 背景

当前 agent-coze-workflow 的 Agent 主循环基于 LangGraph `createReactAgent`，它是一个黑盒 ReAct 循环。我们从日志中看到几个核心问题：

1. **无 turn/step 边界**：Agent 不知道自己跑了多少轮、多少步，无法做步数限制或死循环检测
2. **无结构化错误处理**：所有错误都是 try/catch + 字符串返回，没有错误码分类
3. **无请求/响应边界**：LLM 调用和工具执行混在一起，没有明确的请求生命周期
4. **无进展检测**：Agent 连续 40 轮 accuracy=0% 也不会停

DeepSeek Harness 的 `ReactLoopAgent`（496 行）是生产级的 Agent 主循环实现，它的设计模式可以直接借鉴。本 prompt 的目标是：**将 Harness 的核心设计模式落地到当前项目中，但不重写整个主循环，而是渐进式增强现有 LangGraph ReAct 循环**。

## 参考源码

文件：`~/workspace/deepseek-harness-study/source/packages/core/agent-loop/src/agent.ts`

完整源码已附在本文末尾。

---

## 设计模式 1：Turn/Step 双层循环

### Harness 的设计

```
一次完整的 Agent 执行 = 1 个 driver
  driver 内包含 N 个 turn（用户交互边界）
    每个 turn 内包含 N 个 step（LLM 调用边界）
      每个 step = 1 次 LLM 调用 + 0~N 次工具调用
```

**turn 的定义**：一次用户消息触发的所有处理。如果 turn 内有工具调用，LLM 会自动继续下一步，直到没有工具调用了或达到终止条件。

**step 的定义**：一次 LLM 调用。一个 turn 内可能有多个 step（ReAct 循环），每个 step 之后如果有工具调用，工具结果注入 next-step 队列，触发下一个 step。

**关键代码**（agent.ts 的 `turn()` 方法，L231-327）：
```typescript
private async turn(): Promise<boolean> {
  const turn = phase.turn + 1;
  this.session.append('turn/start', { turn });
  let turnEnds: TurnEndReason | null = null;
  let target: InboxTarget = 'next-turn';

  while (true) {
    signal.throwIfAborted();
    const step = phase.step + 1;
    const decision = await this.preStep(target, { turn, step });
    if (decision.kind === 'reject') {
      turnEnds = { kind: 'blocked' };
      return false;
    }
    // 执行 step（LLM 调用 + 工具调用）
    const stepEnd = await this.step(decision.assembly);
    // max-tokens 是粘性的：一旦某步 hit 了，turn 的结果就锁定为 max-tokens
    if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd;
    // 没有更多工具调用 → turn 结束
    if (turnEnds && this.inbox.nextStep.length === 0) break;
    target = 'next-step';
  }
}
```

### 对当前项目的改造

在 `react-agent.service.ts` 中增加 turn/step 追踪：

```typescript
// 在 Session 中增加
interface AgentTurnState {
  currentTurn: number;      // 当前是第几轮对话
  currentStep: number;      // 当前 turn 内是第几步
  turnEndReason?: 'completed' | 'max_tokens' | 'error' | 'aborted' | 'blocked';
  maxStepsPerTurn: number;  // 每 turn 最多 25 步
}

// 在 streamAgentEvents 中追踪
// on_tool_start 时 step++
// LLM 不再调用工具时 turn 结束
// 每次 handleChat 调用时 turn++
```

**前端事件**：每个 turn 开始时发送 `{"type":"turn_start","turn":N}`，前端可以展示"第 N 轮对话，第 M 步"。

**死循环检测**：如果 `currentStep > maxStepsPerTurn`，注入 stop 消息给 LLM："你已执行超过 25 步，请立即总结当前进展并向用户汇报"。

---

## 设计模式 2：Phase 状态机

### Harness 的设计

```typescript
type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'maintenance'; abort: AbortController; lastTurn: number; wakeRequested: boolean }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }
```

三种状态：
- **idle**：没有活跃执行，可以接收新消息
- **running**：有活跃执行，新消息需要先 abort 再处理
- **maintenance**：执行后台维护任务（如 compaction），消息被 latch

### 对当前项目的改造

当前项目没有显式状态机，`graphDirty` 是一个 hack。改造方案：

```typescript
// 在 Session 中增加（已在 interrupt-and-send-fix.md 中定义）
phase: 'idle' | 'running';
abortController: AbortController | null;
runningPromise: Promise<void> | null;
```

**额外增加**：维护 phase 转换日志，每次转换打印 `[Agent] phase: idle → running (turn=3, step=0)`，方便排查问题。

---

## 设计模式 3：Inbox 消息队列

### Harness 的设计

```typescript
// 三种消息注入方式
send(message, target, wakeup):
  - target: 'next-turn'  → 下一轮处理（用户新消息）
  - target: 'next-step'  → 当前轮下一步处理（工具结果）
  - wakeup: true         → 唤醒 agent
```

**核心价值**：区分"用户消息"和"工具结果"，两者进入不同的队列。工具结果在 `next-step` 中，不会污染用户消息序列。

### 对当前项目的改造

当前项目把所有消息混在 `session.messages` 数组里。改造方案：

```typescript
// 在 Session 中增加
interface Inbox {
  nextTurn: SessionMessage[];   // 下一轮处理的用户消息
  nextStep: SessionMessage[];   // 当前轮下一步处理的工具结果
}

// 工具结果 → inbox.nextStep
// 用户消息 → inbox.nextTurn
// 打断消息 → inbox.nextStep（steer 语义）
```

**好处**：
- 工具结果不会出现在用户消息序列中
- 打断消息可以精准插入当前步
- 清理时只清理 nextStep，不丢用户消息

---

## 设计模式 4：Structured Turn End Reasons

### Harness 的设计

```typescript
type TurnEndReason =
  | { kind: 'completed' }           // 正常完成
  | { kind: 'max-tokens' }          // token 截断（粘性）
  | { kind: 'aborted'; reason }     // 被 abort 打断
  | { kind: 'error'; error }        // 执行出错
  | { kind: 'blocked' }             // 被 pre-step 拒绝
```

**max-tokens sticky**（关键）：一旦某个 step 触发 max-tokens，turn 的结束原因就被锁定为 max-tokens，后续 step 即使正常完成也不能降级。这防止了"token 截断导致部分输出 → 下一步正常完成 → 掩盖了截断问题"。

### 对当前项目的改造

```typescript
// 在 streamAgentEvents 中增加
type TurnEndReason = 
  | { kind: 'completed' }
  | { kind: 'max_tokens'; message: string }
  | { kind: 'aborted'; reason: string }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'step_limit'; maxSteps: number };

// 在 LLM 流式输出中检测 finish_reason === 'length'
// 如果是 → 标记 turnEndReason = 'max_tokens'
// 如果连续 2 步 max_tokens → 直接终止，向用户报告

// 在 try/catch 中分类错误
// RECURSION_LIMIT → step_limit
// AbortError → aborted
// LLM 返回错误 → error with code
```

---

## 设计模式 5：Pre-step Waterfall（插件拦截点）

### Harness 的设计

```typescript
const decision = await this.dispatch.waterfall(
  'agent/pre-step', { messages: claimed, turn, step, signal },
  (): Promise<PreStepDecision> => Promise.resolve({
    kind: 'enter',
    messages: claimed,
  }),
);
// decision.kind === 'reject' → 跳过这一步
// decision.kind === 'enter' → 正常执行，decision.messages 是注入的消息
```

**核心价值**：插件可以在每一步执行前拦截，修改消息、注入上下文、或直接拒绝执行。这是 Harness 的扩展点，允许外部逻辑（如权限检查、上下文注入、限流）在每步前介入。

### 对当前项目的改造

在 LangGraph 架构下，`pre-step` 不是天然存在的。但我们可以模拟：

```typescript
// 在 streamAgentEvents 的 on_tool_start 之前，检查是否需要拦截
// 例如：检测到死循环 → 注入 stop 消息 → 跳过工具调用
// 例如：检测到 max_tokens → 注入截断警告 → 让 LLM 自己决定下一步

// 伪代码：
if (detectedLoop) {
  // 不调用工具，而是注入一条 system 消息给 LLM
  session.messages.push({
    role: 'tool',
    toolName: 'system',
    content: '检测到重复工具调用，请改变策略或向用户汇报当前结果',
  });
  // 这个「不调用工具」的操作就是 pre-step 的 reject
}
```

---

## 设计模式 6：Session Log（追加式不可变日志）

### Harness 的设计

```typescript
// 所有事件追加到 session log，不可变，可重放
this.session.append('turn/start', { turn });
this.session.append('step/start', { turn, step });
this.session.append('user/message', message);
this.session.append('assistant/chunk', { turn, step, chunk });
this.session.append('assistant/message', { turn, step, message });
this.session.append('step/end', { turn, step });
this.session.append('turn/end', { turn, reason });
```

**核心价值**：
- 日志是完整的时间线，可以从中重建任何时刻的 Agent 状态
- 不同与 messages 数组（只保留最终结果），日志保留了所有中间状态
- 可以按 turn/step 过滤，精确定位问题

### 对当前项目的改造

不需要完全实现 session log，但可以增加一个轻量版的事件日志：

```typescript
// 在 Session 中增加
interface AgentEvent {
  timestamp: number;
  type: 'turn_start' | 'turn_end' | 'step_start' | 'step_end' | 
        'tool_start' | 'tool_end' | 'llm_call' | 'error' | 'aborted';
  data: Record<string, unknown>;
}

// 在 streamAgentEvents 中记录关键事件
// 限制最多 1000 条，超过就淘汰旧的
// 前端可以通过 API 查询事件日志（调试用）
```

---

## 实施计划

### Phase 1：Turn/Step 追踪 + 死循环检测（核心）

改动文件：`react-agent.service.ts` 的 `streamAgentEvents` 方法

改动内容：
1. 在 Session 中增加 `turnState: AgentTurnState`
2. 在 `handleChat` 入口增加 turn 计数
3. 在 `streamAgentEvents` 中追踪 step 计数
4. 在 `on_tool_start` 时检查是否达到 maxStepsPerTurn（25）
5. 达到上限时注入 stop 消息，不抛异常

预估：~50 行新增

### Phase 2：结构化错误处理

改动文件：`react-agent.service.ts` 的异常处理

改动内容：
1. 定义 `TurnEndReason` 类型
2. 在 catch 块中分类错误（AbortError / RecursionLimit / LLM error）
3. 不同的错误码发送不同的事件给前端

预估：~30 行新增

### Phase 3：Inbox 消息队列

改动文件：`session.store.ts` + `react-agent.service.ts`

改动内容：
1. Session 增加 `inbox: { nextTurn[], nextStep[] }`
2. 工具结果写入 `inbox.nextStep`
3. 用户消息写入 `inbox.nextTurn`
4. 打断消息写入 `inbox.nextStep`（steer）

预估：~40 行新增

### Phase 4：Pre-step 拦截点

改动文件：`react-agent.service.ts` 的 `streamAgentEvents`

改动内容：
1. 在 `on_tool_start` 之前检查是否需要拦截（死循环检测、进展停滞检测）
2. 需要拦截时注入 stop 消息到 session.messages，不走工具调用
3. 利用 LangGraph 的 `interrupt()` 机制暂停执行（如果支持）

预估：~30 行新增

### Phase 5：事件日志

改动文件：`session.store.ts`

改动内容：
1. Session 增加 `events: AgentEvent[]`
2. 在关键节点追加事件

预估：~20 行新增

---

## 全部改动的文件清单

| 文件 | 改动 | 预估行数 |
|------|------|----------|
| `apps/api/src/agent/session.store.ts` | Session 增加 turnState/inbox/events 字段 | ~30 行 |
| `apps/api/src/agent/react-agent.service.ts` | handleChat + streamAgentEvents 改造 | ~150 行 |

总计约 180 行，不会破坏现有功能。

---

## 验收标准

1. **Turn/Step 追踪**：前端收到 `turn_start` 事件，日志中能看到 `[Agent] turn=3 step=5`
2. **死循环检测**：同一工具同一参数连续调用 3 次 → 第 4 次被拦截，Agent 收到警告
3. **步数限制**：单 turn 超过 25 步 → Agent 终止并向用户报告
4. **结构化错误**：不同错误类型发送不同的事件码（`error` / `step_limit` / `aborted`）
5. **Inbox 分离**：工具结果不污染用户消息序列
6. **max_tokens 检测**：LLM 输出截断时被检测到，Agent 提示用户简化需求

---

## 参考源码：DeepSeek Harness ReactLoopAgent 完整代码

文件：`~/workspace/deepseek-harness-study/source/packages/core/agent-loop/src/agent.ts`

完整的 496 行 TypeScript 源码请直接读取该文件。以下是关键部分的行号索引：

| 模块 | 行号 | 说明 |
|------|------|------|
| Phase 类型定义 | L46-56 | 三种状态 |
| 构造函数 + Inbox 初始化 | L68-98 | 从 session log 恢复 lastTurn |
| send / followup / steer / inject | L121-132 | 三种消息注入 |
| cancel | L134-139 | 取消当前执行 |
| wakeDriver | L163-183 | 唤醒或 latch |
| kick | L197-210 | driver 主循环，收敛后重放 latch |
| preStep | L212-230 | 每步前的拦截点 |
| turn | L231-327 | 单轮对话的完整生命周期 |
| step | L329-368 | 单步执行（LLM 调用 + 工具调用） |
| buildRequest | L370-496 | 构建 LLM 请求（含配置协商） |

请在动手前完整阅读 `agent.ts` 全文件，然后对照上述 Phase 1-5 逐步实施。