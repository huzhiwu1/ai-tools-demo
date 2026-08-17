# Agent Coze Workflow 主循环重写（从零开始，不堆屎山）

## 当前状态

经过多轮修补，`react-agent.service.ts` 和 `session.store.ts` 已经变成屎山。核心问题：

1. **消息重复**：正常多轮对话时，`handleChat` 把 `session.messages` 全部历史拼给 LangGraph，但 checkpoint 里已经有一份 → 每条消息出现两次 → LLM 看到畸形上下文 → 返回空回复 → 前端无显示
2. **cancelStream 崩溃**：终止路径调用 `stream.cancel()` 触发 LangGraph 内部 abort，异步抛出 Error，进程崩溃
3. **终止路径无善后**：stepLimitHit/loopDetected/maxTokensTerminated 直接 return，AI 的回复没保存到 session.messages
4. **graphDirty 到 Phase 的迁移不完整**：旧逻辑残留，消息传递规则不统一

## 要求

**删除 `react-agent.service.ts` 和 `session.store.ts` 的全部内容，从零重写。不要保留任何旧代码，不要新旧并存。**

## 保留的设计（这些是对的，要保留）

1. **Phase 状态机**：`idle` / `running`，`handleChat` 入口检测 phase=running 时 abort 旧 driver 并等待
2. **AbortController**：每次 `handleChat` 创建新的 AbortController，通过 `config.signal` 传给 LangGraph
3. **Turn/Step 追踪**：`turnState.currentTurn` / `currentStep`，`maxStepsPerTurn: 25`
4. **死循环检测**：同工具同参数连续 4 次 → `loop_detected` 终止
5. **max_tokens 粘性**：`finish_reason === "length"` 检测，连续 2 次终止
6. **结构化错误**：`TurnEndReason` 类型（completed / max_tokens / aborted / error / step_limit）
7. **工具超时**：`tools/index.ts` 的 `withToolTimeout` 和 `withToolLog`（不改这个文件）
8. **批量测试并发**：`batch-validate.tool.ts` 的 worker pool（不改这个文件）

## 核心规则（必须严格遵守）

### 规则 1：消息传递规则

**LangGraph 的 checkpoint 按 `thread_id` 自动恢复历史消息。** 所以：

- **正常多轮对话**（graph 未重建）：只传本轮新增的消息（工具摘要 + 新用户消息），不传历史。checkpoint 里已有完整历史。
- **打断恢复**（graph 已重建，checkpoint 已清空）：传全部历史消息（从 `session.messages` 重建）。

```typescript
// 判断逻辑
if (graphWasRebuilt) {
  // 传全部历史：SystemMessage(工具摘要) + 全部 HumanMessage + 全部 AIMessage
} else {
  // 只传本轮新增：SystemMessage(工具摘要) + HumanMessage(新消息)
}
```

### 规则 2：不要调用 cancelStream

`stream.cancel()` 内部会触发 LangGraph 的 abort，导致异步抛出 Error 崩溃进程。**终止路径（stepLimitHit / loopDetected / maxTokensTerminated）直接 return 即可**，`for await` 循环退出后 stream 自然停止。

`cancelStream` 只保留在客户端断开兜底路径（`res.destroyed` 检测），且必须用 try/catch 包裹。

### 规则 3：终止路径必须善后

三个终止路径在 return 之前，必须把 AI 已输出的消息保存到 `session.messages`：

```typescript
// 从 graph checkpoint 提取最后一条 AI 消息
const state = await graph.getState(config);
const finalContent = extractFinalContent(state.values);
if (finalContent && finalContent !== "处理完成") {
  session.messages.push({ role: "assistant", content: finalContent });
}
```

### 规则 4：session.messages 只存最终结果

- `session.messages`：只存 user/assistant 的最终消息（用于前端展示和打断恢复）
- `inbox.nextStep`：存工具结果摘要（用于注入上下文）
- 不要混用

## 文件 1：session.store.ts

```typescript
import type { CompiledStateGraph } from "@langchain/langgraph";

export interface SessionMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
}

export type TurnEndReason =
  | { kind: "completed" }
  | { kind: "max_tokens"; message: string }
  | { kind: "aborted"; reason: string }
  | { kind: "error"; code: string; message: string }
  | { kind: "step_limit"; maxSteps: number };

export interface AgentTurnState {
  currentTurn: number;
  currentStep: number;
  turnEndReason?: TurnEndReason;
  maxStepsPerTurn: number;  // 默认 25
}

export interface Inbox {
  nextTurn: SessionMessage[];
  nextStep: SessionMessage[];
}

export interface AgentEvent {
  timestamp: number;
  type: "turn_start" | "turn_end" | "step_start" | "step_end" | "tool_start" | "tool_end" | "llm_call" | "error" | "aborted";
  data: Record<string, unknown>;
}

export interface Session {
  graph: CompiledStateGraph<any, any, any, any, any>;
  messages: SessionMessage[];
  phase: "idle" | "running";
  abortController: AbortController | null;
  runningPromise: Promise<void> | null;
  turnState: AgentTurnState;
  inbox: Inbox;
  events: AgentEvent[];
  createdAt: number;
}

class SessionStore {
  private sessions = new Map<string, Session>();

  create(graph: Session["graph"], sessionId?: string): string {
    const id = sessionId ?? crypto.randomUUID();
    this.sessions.set(id, {
      graph,
      messages: [],
      phase: "idle",
      abortController: null,
      runningPromise: null,
      turnState: { currentTurn: 0, currentStep: 0, maxStepsPerTurn: 25 },
      inbox: { nextTurn: [], nextStep: [] },
      events: [],
      createdAt: Date.now(),
    });
    return id;
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }
}

export const sessionStore = new SessionStore();
```

## 文件 2：react-agent.service.ts

### 结构要求

```
ReactAgentService 类：
├── handleChat()          ← 入口：Phase 状态机 + 消息构建 + 启动执行
├── handleResume()        ← 入口：Phase 状态机 + Command resume
├── createGraph()         ← 创建 LangGraph 实例
├── streamAgentEvents()   ← 核心：for await 迭代 + 6 个拦截点
├── setSSEHeaders()       ← SSE 响应头
├── cancelStream()        ← 仅客户端断开兜底，有 try/catch
├── saveInterruptedState()← 终止路径善后
├── appendEvent()         ← 事件日志
├── extractToolContent()  ← 工具结果提取
├── summarizeToolResult() ← 工具结果摘要
├── extractInterruptData()← interrupt 检测
├── extractFinalContent() ← 提取最终 AI 消息
```

### handleChat 完整流程

```typescript
async handleChat(sessionId, message, res) {
  // 1. 获取或创建会话
  let session = sessionId ? sessionStore.get(sessionId) : undefined;
  const graphWasRebuilt = !session;
  if (!session) {
    const graph = this.createGraph();
    const newId = sessionStore.create(graph, sessionId);
    session = sessionStore.get(newId)!;
    sessionId = newId;
  }

  // 2. Phase 状态机：如果 running，先 abort 旧 driver
  if (session.phase === "running") {
    session.abortController?.abort("user-interrupt");
    await Promise.race([
      session.runningPromise ?? Promise.resolve(),
      new Promise(r => setTimeout(r, 5000)),
    ]);
    session.graph = this.createGraph();
    // 注意：打断后 graph 重建，下一轮需要传全部历史
  }

  // 3. 设置新 driver
  session.turnState.currentTurn += 1;
  session.turnState.currentStep = 0;
  session.turnState.turnEndReason = undefined;
  session.phase = "running";
  session.abortController = new AbortController();

  // 4. 记录用户消息
  session.messages.push({ role: "user", content: message });

  // 5. 构建 LangChain 消息（规则 1）
  const langchainMessages: BaseMessage[] = [];
  
  // 工具摘要始终注入
  if (session.inbox.nextStep.length > 0) {
    const contextText = "【系统记录：以下是此前会话已完成的工具操作结果】\n" +
      session.inbox.nextStep.map(m => `- ${m.content}`).join("\n");
    langchainMessages.push(new SystemMessage(contextText));
  }

  // 关键：根据 graph 是否重建决定传多少历史
  if (graphWasRebuilt) {
    // graph 重建了，checkpoint 为空，传全部历史
    for (const m of session.messages) {
      if (m.role === "user") langchainMessages.push(new HumanMessage(m.content));
      if (m.role === "assistant") langchainMessages.push(new AIMessage(m.content));
    }
  } else {
    // checkpoint 有完整历史，只传本轮新消息
    langchainMessages.push(new HumanMessage(message));
  }

  // 6. SSE 头 + 初始事件
  this.setSSEHeaders(res);
  res.write(`d:${JSON.stringify({ type: "session", sessionId })}\n`);
  res.write(`d:${JSON.stringify({ type: "turn_start", turn: session.turnState.currentTurn })}\n`);

  // 7. 启动执行
  let resolvePromise: () => void;
  session.runningPromise = new Promise<void>(r => { resolvePromise = r; });

  const config: RunnableConfig = {
    configurable: { thread_id: sessionId },
    recursionLimit: 100,
    signal: session.abortController.signal,
  };

  try {
    await this.streamAgentEvents(session.graph, { messages: langchainMessages }, config, session, sessionId, res);
  } finally {
    session.phase = "idle";
    session.abortController = null;
    resolvePromise!();
  }
}
```

### streamAgentEvents 关键点

1. 在 for await 循环开头检查 `signal.aborted` 和 `res.destroyed`
2. `on_chat_model_start`：step++，超过 maxStepsPerTurn → stepLimitHit
3. `on_tool_start`：同工具同参数连续 4 次 → loopDetected
4. `on_chat_model_stream`：finish_reason=length → stickyMaxTokens
5. `on_chat_model_end`：finish_reason=length 连续 2 次 → maxTokensTerminated
6. 终止路径（stepLimitHit/loopDetected/maxTokensTerminated）：
   - 设置 turnEnd
   - 调用 saveInterruptedState（规则 3）
   - 发送 error 事件
   - res.end()
   - return（不调 cancelStream！规则 2）

7. 错误分类：
   - AbortError → aborted
   - Recursion limit → step_limit
   - 其他 → error with code

8. 正常完成：
   - getState → interrupt? → 发送 interrupt 事件
   - 否则 → 提取 finalContent → 保存到 session.messages → 发送 done 事件

## 验收标准

1. 发送「你好」→ 前端收到 AI 回复（文本显示正常）
2. 发送「你好」→ 再发送「你刚才说了什么」→ AI 能记住上一轮对话（多轮记忆正常）
3. 发送复杂任务 → 点击打断并发送 → 新消息被处理，旧任务停止
4. 死循环场景 → 4 次重复后拦截，进程不崩溃
5. 步数超限 → 终止，下一轮能正常对话（不静默空回复）
6. 进程不崩溃（无 unhandled rejection）

## 改动文件

只改两个文件：
- `apps/api/src/agent/session.store.ts`（完全重写）
- `apps/api/src/agent/react-agent.service.ts`（完全重写）

不改其他任何文件。

## 补充说明

1. SYSTEM_PROMPT 和 LLM 实例（`ChatOpenAI`）保持不变，照抄现有代码
2. `extractToolContent` / `summarizeToolResult` / `extractInterruptData` / `extractFinalContent` 四个辅助方法保持不变，照抄现有代码
3. `handleResume` 的逻辑与 `handleChat` 类似，需要同样的 Phase 检查 + 消息构建规则
4. 不要引入任何新的 npm 依赖
5. 代码注释用中文，保持与项目一致的风格