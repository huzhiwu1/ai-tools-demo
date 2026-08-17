# 打断并发送：借鉴 DeepSeek Harness kick/wake 模式，修复前端交互断裂

## ⚠️ 铁律：先删后建，不在屎山上堆代码

本 prompt 要求你对现有代码做**替换**，不是叠加。具体规则：

1. **删除旧代码再写新代码**：不要保留旧的 `graphDirty` hack、`res.on('close')` 逻辑，全部用新方案替代
2. **不要新旧并存**：不要出现 `if (newWay) ... else { oldWay }` 的兼容代码，旧代码直接删
3. **不要保留注释掉的旧代码**：删干净，git 历史里有旧版本可以回看
4. **改动范围**：只改 `session.store.ts` 和 `react-agent.service.ts` 两个文件

---

## 问题描述

当前「打断并发送」功能存在三个致命问题：

1. **用户打断后，后端仍在跑旧任务**：Agent 在 `streamAgentEvents` 里执行 LLM 调用 + 工具调用，可能持续数分钟。用户点击「打断并发送」后，前端关闭了 SSE 连接，但后端 `for await` 循环仍在阻塞等待 LLM 响应 / 工具返回，资源泄漏。

2. **新消息被忽略**：用户打断后输入的新消息，`handleChat` 被调用，但此时旧 `streamAgentEvents` 可能还在跑。两个并发执行会竞争同一个 session 的 graph 和 checkpoint，新消息的上下文被旧执行污染，AI 看起来"没理会新消息"。

3. **前端无反馈**：打断后前端不知道后端是否已停止，不知道 Agent 是否已开始处理新消息。只能看到「处理中」一直转圈。

## 参考设计：DeepSeek Harness 的 kick/wake 模型

源码：`C:\Users\Administrator\Desktop\deepseek-harness\packages\core\agent-loop\src\agent.ts`（496 行）

### 核心架构

```
外部消息进来
  → send(message, target, wakeup)
    → inbox.splice(target, ...)     // 消息入队
    → wakeDriver()                  // 唤醒 agent

Phase 状态机:
  idle ──kick()──→ running ──完成/abort──→ idle
                    ↑
                    │ 新消息到达
                    │ phase=running 时 abort 旧 driver
                    │ 等待 runningPromise 收敛
                    │ 重建 graph → 启动新 driver
```

### 三种消息注入方式

| 方式 | Inbox Target | 唤醒？ | 场景 |
|------|-------------|--------|------|
| followup | next-turn | 是 | 用户发新消息（正常流程） |
| steer | next-step | 是 | **打断当前步，立刻处理新消息** |
| inject | next-step | 否 | 注入上下文但不打断 |

**你的「打断并发送」对应 `steer`**：消息进入 `next-step`，当前 step 完成后立即处理新消息，而不是继续原来的工具调用链。

### 关键代码片段（agent.ts，可直接抄）

**Phase 状态机**（agent.ts L46-56）：
```typescript
type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }
  | { kind: 'maintenance'; abort: AbortController; lastTurn: number; wakeRequested: boolean }
```

**wakeDriver 入口**（agent.ts L163-183）：
```typescript
private wakeDriver(wakeAfterAbort = false): void {
  if (this.phase.kind !== 'idle') {
    // 如果正在 running，latch 唤醒标记，等当前 driver 收敛后重放
    if (this.phase.kind === 'maintenance' || wakeAfterAbort) {
      this.phase.wakeRequested = true;
    }
    return;
  }
  // idle 状态：直接启动新 driver
  this.setPhase({ kind: 'running', abort: new AbortController(), turn: this.phase.lastTurn, step: 0, wakeRequested: false });
  this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject);
}
```

**kick 收敛后重放**（agent.ts L197-210）：
```typescript
private async kick(): Promise<void> {
  try {
    while (await this.turn()) {}
  } catch (_error) {
    // 包含在 driver 边界内
  } finally {
    if (this.phase.kind === 'running') {
      const { turn, wakeRequested } = this.phase;
      this.setPhase({ kind: 'idle', lastTurn: turn });
      // 收敛后检查 latch 的 wake → 重放
      if (wakeRequested && this.inbox.hasPending) this.wakeDriver();
    }
  }
}
```

**AbortController 全程传递**（每个关键边界）：
```typescript
signal.throwIfAborted();  // preStep 入口
signal.throwIfAborted();  // LLM 调用前
signal.throwIfAborted();  // 工具调用前
signal.throwIfAborted();  // 每个 chunk 到达时
```

## 改动方案

### 文件 1：`apps/api/src/agent/session.store.ts`

删除 `graphDirty` 字段，新增三个字段：

```typescript
export interface Session {
  // ... 保留现有字段 graph / messages / createdAt ...

  // 删除 graphDirty? 字段

  /** Phase 状态机：idle 或 running，同一时刻只有一个 driver */
  phase: 'idle' | 'running';
  /** 当前活跃 driver 的 AbortController，用于从外部打断执行 */
  abortController: AbortController | null;
  /** 当前活跃 driver 的完成 Promise，handleChat 用 await 等旧 driver 退出 */
  runningPromise: Promise<void> | null;
}
```

`create()` 方法初始化新字段为 `phase: 'idle'`、`abortController: null`、`runningPromise: null`。

### 文件 2：`apps/api/src/agent/react-agent.service.ts`

#### 2.1 handleChat 重写（核心改动）

**当前流程**（有问题）：
```
1. 获取 session
2. 检查 graphDirty → 重建 graph
3. 添加用户消息到 messages
4. 调用 streamAgentEvents → 直接跑
```

**新流程**（借鉴 Harness）：
```typescript
async handleChat(sessionId, message, res) {
  // 1. 获取或创建会话
  let session = sessionId ? sessionStore.get(sessionId) : undefined;
  if (!session) {
    const graph = this.createGraph();
    const newId = sessionStore.create(graph, sessionId);
    session = sessionStore.get(newId)!;
    sessionId = newId;
  }

  // 2. 如果 session 正在 running，先 abort 旧 driver
  const wasInterrupted = session.phase === 'running';
  if (wasInterrupted) {
    this.logger.log(`[Agent] 打断旧 driver (session=${sessionId})`);
    // 发出 abort 信号
    session.abortController?.abort('user-interrupt');
    // 等待旧 driver 完全退出（最多等 5 秒）
    try {
      await Promise.race([
        session.runningPromise,
        new Promise(r => setTimeout(r, 5000)),
      ]);
    } catch {
      // 旧 driver 可能已经抛异常，忽略
    }
    // 重建 graph：旧 execution 被 abort，checkpoint 已脏，必须重建
    session.graph = this.createGraph();
    this.logger.log(`[Agent] 旧 driver 已退出，graph 已重建 (session=${sessionId})`);
  } else {
    // 正常流程：检查 graphDirty（兼容旧逻辑，以后可删）
    if (session.graphDirty) {
      session.graph = this.createGraph();
      session.graphDirty = false;
    }
  }

  // 3. 设置新 driver 的 phase 和 AbortController
  session.phase = 'running';
  session.abortController = new AbortController();

  // 4. 添加用户消息到历史
  session.messages.push({ role: 'user', content: message });

  // 5. 构建 LangChain 消息（保持现有逻辑不变）
  const langchainMessages: BaseMessage[] = [];
  // ... 现有 tool 摘要注入 + user/assistant 消息转换 ...

  // 6. 设置 SSE 响应头并发送 sessionId
  this.setSSEHeaders(res);
  res.write(`d:${JSON.stringify({ type: "session", sessionId })}\n`);

  // 7. 如果是打断场景，发送 aborted 事件给前端
  if (wasInterrupted) {
    res.write(`d:${JSON.stringify({ type: "aborted", message: "已打断上一轮任务，正在处理新消息..." })}\n`);
  }

  // 8. 发送 turn 事件（新增，前端可展示"第 N 轮对话"）
  const turnCount = session.messages.filter(m => m.role === 'user').length;
  res.write(`d:${JSON.stringify({ type: "turn_start", turn: turnCount })}\n`);

  // 9. 创建 runningPromise 并启动执行
  let resolvePromise: () => void;
  session.runningPromise = new Promise<void>(resolve => { resolvePromise = resolve; });

  const config = {
    configurable: { thread_id: sessionId },
    recursionLimit: 100,
    // 关键：把 AbortSignal 传给 LangGraph
    signal: session.abortController.signal,
  } as RunnableConfig & { recursionLimit: number; signal?: AbortSignal };

  try {
    await this.streamAgentEvents(
      session.graph,
      { messages: langchainMessages },
      config,
      session,
      sessionId,
      res,
    );
  } finally {
    // 无论正常结束还是异常退出，都收敛到 idle
    session.phase = 'idle';
    session.abortController = null;
    resolvePromise!();
  }
}
```

#### 2.2 streamAgentEvents 改造

**核心改动**：用 `AbortSignal` 替代 `res.on('close')` hack，在关键边界检查。

```typescript
private async streamAgentEvents(
  graph: Session['graph'],
  input: any,
  config: RunnableConfig,
  session: Session,
  sessionId: string,
  res: SSEResponse,
): Promise<void> {
  const signal = (config as any).signal as AbortSignal | undefined;
  let finished = false;

  // 保留 res.on('close') 作为兜底：如果客户端直接关浏览器（不发 abort），
  // 至少能检测到并标记。但不再依赖它做 graphDirty——用 signal 做主路径。
  const onClose = () => {
    if (!finished) {
      // 客户端断开 → 发 abort 信号（如果还没发）
      session.abortController?.abort('client-disconnect');
    }
  };
  res.on('close', onClose);

  try {
    try {
      // PregelOptions extends RunnableConfig，signal 会传递给底层 LLM 调用
      const stream = graph.streamEvents(input, {
        version: 'v2',
        ...config,
      });

      for await (const event of stream) {
        // 检查点 1：AbortSignal（主路径，比 res.destroyed 更及时）
        if (signal?.aborted) {
          // 主动取消底层流
          try {
            await (stream as any).cancel?.(signal.reason ?? 'aborted');
          } catch {}
          break;
        }

        // 检查点 2：res.destroyed（兜底，客户端已经断开但没发 abort）
        if (res.destroyed) {
          session.abortController?.abort('client-disconnect');
          try {
            await (stream as any).cancel?.('client-disconnect');
          } catch {}
          break;
        }

        // ... 现有 event 处理逻辑不变（on_chat_model_stream / on_tool_start / on_tool_end）...
      }

      // 如果是被 abort 打断的，发送 aborted 事件并退出
      if (signal?.aborted) {
        res.write(`d:${JSON.stringify({ type: "aborted" })}\n`);
        res.end();
        return;
      }

      // 客户端断开时不继续处理
      if (res.destroyed) return;

      // ... 现有 interrupt 检测 / done 逻辑不变 ...

    } catch (e) {
      // 如果是 AbortError，视为正常打断，不报错
      if (signal?.aborted || (e as Error).name === 'AbortError') {
        res.write(`d:${JSON.stringify({ type: "aborted" })}\n`);
        res.end();
        return;
      }
      // ... 现有错误处理不变 ...
    }
  } finally {
    finished = true;
    res.removeListener('close', onClose);
  }
}
```

#### 2.3 handleResume 同样改造

`handleResume` 也需要加 phase 检查，防止用户在 interrupt 等待回答时又发新消息打断：

```typescript
async handleResume(sessionId, answer, fileIds, res) {
  const session = sessionStore.get(sessionId);
  if (!session) { /* 现有错误处理 */ }

  // 如果 session 正在 running（用户在上一个 resume 还没跑完时又发了消息），
  // 先 abort 旧 driver
  if (session.phase === 'running') {
    session.abortController?.abort('user-interrupt');
    try {
      await Promise.race([
        session.runningPromise,
        new Promise(r => setTimeout(r, 5000)),
      ]);
    } catch {}
    session.graph = this.createGraph();
  }

  // 设置新 phase
  session.phase = 'running';
  session.abortController = new AbortController();

  // ... 现有 fileRefs / resumeText / Command 逻辑 ...

  let resolvePromise: () => void;
  session.runningPromise = new Promise<void>(resolve => { resolvePromise = resolve; });

  const config = {
    configurable: { thread_id: sessionId },
    recursionLimit: 100,
    signal: session.abortController.signal,
  } as RunnableConfig & { recursionLimit: number; signal?: AbortSignal };

  try {
    await this.streamAgentEvents(session.graph, command, config, session, sessionId, res);
  } finally {
    session.phase = 'idle';
    session.abortController = null;
    resolvePromise!();
  }
}
```

## 改动文件清单

| 文件 | 改动范围 | 预估行数 |
|------|----------|----------|
| `apps/api/src/agent/session.store.ts` | Session 接口：删 graphDirty，加 phase/abortController/runningPromise | ~15 行 |
| `apps/api/src/agent/react-agent.service.ts` | handleChat 重写 + handleResume 加 phase 检查 + streamAgentEvents 加 signal 检查 | ~80 行 |

## 验收标准

改动完成后，按以下流程验收：

1. **正常对话**：发送消息 → Agent 正常回复 → 再发消息 → Agent 正常回复（多轮不丢上下文）
2. **打断并发送**：
   - 发送一个复杂任务（如"帮我创建一个歌词识别工作流"）
   - Agent 开始执行（LLM 思考 + 工具调用）
   - 点击「打断并发送」，输入新消息「算了，列出我已有的工作流」
   - 前端应收到 `{"type":"aborted"}` 事件
   - Agent 应立即处理新消息，列出工作流列表
   - 旧任务不应继续执行（服务端日志中不应出现旧任务的后续工具调用）
3. **连续打断**：打断 → 发新消息 → 再打断 → 再发新消息，Agent 每次都处理最新消息
4. **resume 打断**：Agent 调了 clarify_question 等待回答 → 用户不回答，直接「打断并发送」新需求 → Agent 应处理新需求而非继续等答案

## 关键设计决策（为什么这么做）

1. **为什么用 runningPromise 而不是 while 循环等 phase？**
   - `while (session.phase === 'running') await sleep(100)` 会阻塞事件循环，且无法确定等待时间。用 Promise 可以精确等待 driver 退出。

2. **为什么等 5 秒超时？**
   - 极端情况下旧 driver 可能卡在无法被 abort 的系统调用中（如文件 I/O）。5 秒超时防止新请求永远被阻塞，超时后强制重建 graph 启动新 driver。

3. **为什么重建 graph 而不是保留 checkpoint？**
   - 旧 execution 被 abort 时，LangGraph 的 checkpoint 留下半截状态（部分 tool 结果已写入，部分未写入）。如果复用同一个 graph，新 execution 会从脏 checkpoint 恢复，导致状态混乱。重建 graph 是安全做法，消息记忆由 session.messages 保留。

4. **为什么保留 res.on('close') 作为兜底？**
   - AbortSignal 是主路径，但用户可能直接关浏览器标签页，此时没有新的 handleChat 调用来发 abort。res.on('close') 作为兜底，至少能标记并尝试取消底层流。但不再依赖它做 graphDirty——那个 hack 已被 phase 状态机替代。