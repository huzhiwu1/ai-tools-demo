# 前端 AI 回复完全不可见的根因分析与修复

> 日期：2026-08-17
> 修复文件：`apps/web/src/App.tsx`
> 现象：后端日志显示 `turn=1 ended kind=completed` 一切正常，但前端「一点反应都没有」——用户消息能显示，AI 回复零渲染、零报错。

## 一、问题现象

终端日志显示后端完整跑完了整个 Agent 循环：

```
[HTTP] POST /api/agent/chat session=new msgLen=2
[Agent] chat session=new msg=你好
[Agent] phase: idle → running (turn=1, step=0)
[Agent] turn=1 step=1 llm_call (model=ChatOpenAI)
[Agent] turn=1 done
[Agent] turn=1 ended kind=completed
[Agent] phase: running → idle (turn=1, reason=completed)
```

但前端界面上：用户消息气泡正常显示，AI 回复**一个气泡都不出现**，控制台无任何 JS 报错，状态栏很快回到「就绪」。

## 二、诊断过程（证据链）

按「后端 → 代理 → 转换层 → useChat → 渲染」逐层排查：

1. **后端正常**：`curl -N POST /api/agent/chat` 直连，响应流完整包含 `d:session`、`d:turn_start`、大量 `0:"文本增量"`、`d:done`、`e:finish`，无异常。
2. **Vite 代理正常**：浏览器内 `fetch('/api/agent/chat')` 直读原始流，339 行事件全部到达（`Content-Type: text/event-stream`）。
3. **transform 转换正常**：`transformToDataProtocolStream` 输出的 `2:[...]` 行全部是合法 JSON 数组。
4. **决定性证据**：给 App.tsx 加临时调试日志后，console 显示 `[debug handleDataEvent] text_delta` 被调用了 **130+ 次**——data 事件全部到达 `handleDataEvent`，`setMessages` 也执行了，但 DOM 里最终一个 AI 气泡都没有，`[debug useChat error]` 从未触发。

结论：**问题不在传输链路，而在 useChat 内部的状态管理覆盖了前端手动 setMessages 的结果。**

## 三、根因分析

三层链路共同导致：

### 第 1 层：0: 文本行全部被转成 2: data 事件

前端自定义 fetch（`transformToDataProtocolStream`）把后端所有 `0:"text"` 行转换成 `2:[{type:"text_delta",content}]` data 事件，目的是让前端 `handleDataEvent` 手动分段管理气泡。

副作用：useChat 内部的 `processChatResponse` **从未收到任何 `0:` 行**（0: 行才是它累积 assistant 消息文本的来源），因此它自己累积的 assistant 消息 `currentMessage` **恒为 undefined**。

### 第 2 层：useChat 在每个 data 事件时用快照重置 messages

`@ai-sdk/react@1.0.13` 的 `processChatResponse` 里，每个事件都会触发 `execUpdate`：

```js
// 简化版（@ai-sdk/react 1.0.13 + @ai-sdk/ui-utils 1.0.12）
onUpdate(merged, data) {
  // merged = [...previousMessages, copiedMessage]
  // 由于没有 0: 行，merged 恒为 []
  mutate([...chatRequest.messages, ...merged], false);   // 用请求快照重置 messages！
  if (data?.length) mutateStreamData([...existingData ?? [], ...data], false);
}
```

`chatRequest.messages` 是**发送时的消息快照**（不含 AI 回复）。所以每个 data 事件都会把整个 messages 重置回「只有用户消息」的状态。

### 第 3 层：前端 setMessages 添加的气泡被反复覆盖

`handleDataEvent` 的 `text_delta` 分支用 `setMessages(prev => [...prev, assistant气泡])` 添加消息，但下一个 data 事件的快照 mutate 立刻把它覆盖掉。流期间的添加全部无效。

**最后一击**：`done` 是流的最后一个 data 事件，它的 execUpdate 照例执行快照重置，而 `done` 分支本身不调 `setMessages`。流结束后不再有 mutate，最终 messages = 发送时快照 = 只有用户消息。AI 回复完全不可见，且整个过程无任何异常抛出（所以零报错）。

```
时间线：
text_delta 事件 → mutate(快照, 无AI消息) → effect → setMessages(加AI气泡)
text_delta 事件 → mutate(快照, 无AI消息) → effect → setMessages(加AI气泡)   ← 上一个被覆盖
...
done 事件      → mutate(快照, 无AI消息) → effect → done 分支（不渲染）
────────────────────────────────────────────────────────────────
流结束，最终 messages = 快照（只有用户消息）
```

## 四、修复方案

核心思路：**分段累积 + 流尾重建**。`done` / `interrupt` 是流的最后一个 data 事件，之后不再有 mutate 覆盖，此时重建气泡是安全的。

### 1. 新增文本分段累积 ref

```typescript
/** 本轮文本分段累积（每个分段 = 一个 AI 气泡的完整文本） */
const textSegmentsRef = useRef<Array<{ id: string; content: string }>>([]);
```

`text_delta` 分支在原有 setMessages 逻辑（保留流式尝试）之外，把内容同步累积到 `textSegmentsRef`；分段边界（tool_start/tool_end/interrupt）只切新分段，不截断数组。

### 2. 新增重建函数（泛型兼容两种消息类型）

```typescript
function rebuildAssistantSegments<T extends { id: string; content: string }>(
  prev: T[],
  segments: Array<{ id: string; content: string }>,
): T[] {
  let next = prev;
  for (const seg of segments) {
    const idx = next.findIndex((m) => m.id === seg.id);
    if (idx === -1) {
      // 气泡被快照重置覆盖 → 重建
      next = [...next, { id: seg.id, role: "assistant", content: seg.content } as unknown as T];
    } else if (next[idx].content !== seg.content) {
      // 部分残留（覆盖竞态中间态）→ 补齐完整文本
      next = next.map((m) => m.id === seg.id ? { ...m, content: seg.content } : m);
    }
  }
  return next;
}
```

### 3. done / interrupt 分支调用重建

```typescript
case "done": {
  const segments = textSegmentsRef.current;
  if (segments.length > 0) {
    setMessages((prev) => rebuildAssistantSegments(prev, segments));
  }
  textSegmentsRef.current = [];
  currentAssistantIdRef.current = null;
  currentReasoningIdRef.current = null;
  break;
}
```

`interrupt` 分支同理：先重建文本气泡，再追加提问卡片。`sendNewMessage` 里重置 `textSegmentsRef.current = []`。

### 4. 附带改进

- useChat 增加 `onError` 回调打 console：前端此前未解构 useChat 的 error 状态，内部错误完全静默，加兜底便于后续定位。

## 五、验证结果

浏览器实测（Chrome DevTools 驱动）：

| 场景 | 结果 |
| --- | --- |
| 普通对话（done 分支） | AI 回复完整显示 |
| 工具调用多分段 + interrupt 提问卡片 | 分段气泡、工具卡片、提问卡片全部正常 |
| 多轮对话（同会话 3 轮） | 每轮 AI 回复都显示 |
| `tsc --noEmit` | 通过 |
| 浏览器 Console | 无任何 error/warn |

## 六、已知权衡与后续建议

1. **流式打字效果丢失**：覆盖竞态在流期间持续存在，文本气泡现在在流结束时一次性完整出现；工具调用卡片仍是实时更新。
2. **reasoning 气泡未补偿**：thinking 已禁用（LLM 配置 `thinking: { type: "disabled" }`），当前无 reasoning_delta 事件，暂不处理。
3. **要恢复真流式的正确方向**（改动较大，需评估）：
   - 让 `0:` 行直通 useChat（它自己累积 assistant 消息，快照 mutate 不再造成覆盖）；
   - 前端放弃手动 `text_delta` 分段，或利用 Data Stream 协议的 `8:`（message id）行让 useChat 在工具调用边界自动开新消息；
   - 后端需在 `tool_start` 前后配合发 `8:` 行。
4. **版本组合提示**：项目当前 `@ai-sdk/react@1.0.13`（其解析器来自 `@ai-sdk/ui-utils@1.0.12`，配 ai 4.x 设计）与 `ai@3.4.33` 混装，属历史遗留；后续升级 AI SDK 大版本时需重新验证本修复逻辑。
