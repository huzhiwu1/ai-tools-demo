# Qoder 任务：AI 回复按语义段拆分多气泡（方案 B）

> 项目：`/Users/huzhiwu/workspace/ai-tools-demo/src/agent-coze-workflow`
> 技术栈：React 18 + Vite + Vercel AI SDK（useChat）+ NestJS
> **目标：AI 回复不再挤在一个大气泡里——按"工具调用前后"拆成多个气泡：思考文本一个气泡 → 工具卡片 → 结果文本一个气泡 → 最终总结一个气泡。工具调用天然成为分段边界。**

---

## 一、当前实现（先读这些文件）

- `apps/web/src/App.tsx` — useChat 集成 + `handleDataEvent`（处理 d: 事件）+ `handleAnswer`（resume 手写 fetch + parseDataStream）
- `apps/web/src/api/data-stream.ts` — `transformToDataProtocolStream`（后端 0:/d:/e: → AI SDK 协议）+ `parseDataStream`
- `apps/web/src/components/chat-message-list.tsx` — 消息渲染（assistant 一条消息一个气泡 + ToolCard 工具卡片）

**当前行为**：
- 后端 `0:"文本"` 增量 → `transformToDataProtocolStream` **直通**为 AI SDK 的 `0:"文本"` → useChat 自动把文本流式追加到**最后一条 assistant 消息的 content**（从头流到尾一个气泡）
- `d:{tool_start/tool_end}` → 转成 AI SDK `2:[事件]` → useChat 的 data 数组 → `handleDataEvent` 增量处理，渲染工具卡片
- 结果：AI 的"分析→调工具→总结"全部拼在一个气泡里

---

## 二、目标

AI 回复拆成多个气泡，分段规则：

```
气泡1：工具调用前的思考/说明文本
[工具卡片 plan_workflow]
[工具卡片 generate_workflow]
气泡2：工具调用后的结果/说明文本
[工具卡片 save_to_coze]
气泡3：最终总结
```

规则细化：
- **每个 `tool_start` 事件 = 分段边界**：收到 tool_start 时，当前正在累积的 assistant 文本气泡"封存"，之后的文本进入**新的气泡**
- 工具结束（tool_end）后 AI 继续说话 → 新气泡
- AI 在工具调用前没说话（content 为空）→ 不产生空气泡（跳过）
- 用户消息始终独立气泡（不变）
- 流式光标：只出现在**最后一条**正在流式的 assistant 气泡末尾

---

## 三、实现方案（照此做）

### 核心思路：文本不再走 useChat 自动拼接，改为前端手动分段管理

把后端 `0:"文本"` 也转成 `d:` 事件（`text_delta`），前端在 `handleDataEvent` 里手动追加到"当前分段"，收到 tool_start 时封存当前分段、开新分段。

### 1. data-stream.ts — transformToDataProtocolStream 改造

**`0:"文本"` 不再直通**，转成 data 事件：

```ts
if (trimmed.startsWith("0:")) {
  const text: unknown = JSON.parse(trimmed.slice(2));
  if (typeof text === "string" && text.length > 0) {
    return `2:${JSON.stringify([{ type: "text_delta", content: text }])}\n`;
  }
  return null;
}
```

（`d:` 事件处理不变；`3:` 错误行不变；`e:` 丢弃不变）

> 效果：useChat 的 messages 里不再有自动累积的 assistant 文本（因为没有 0: 直通了），消息内容完全由前端 `handleDataEvent` 手动控制。

### 2. App.tsx — 分段状态 + text_delta 处理

**新增状态：**

```tsx
// 当前正在累积文本的 assistant 消息 id（null = 当前没有开放的分段）
const currentAssistantIdRef = useRef<string | null>(null);
```

**handleDataEvent 增加 text_delta 分支：**

```tsx
case "text_delta": {
  const content = event.content ?? "";
  if (!content) break;

  setMessages((prev) => {
    // 没有开放分段 → 新建一条 assistant 消息
    if (!currentAssistantIdRef.current) {
      const newId = crypto.randomUUID();
      currentAssistantIdRef.current = newId;
      return [...prev, { id: newId, role: "assistant", content }];
    }
    // 有开放分段 → 追加
    return prev.map((m) =>
      m.id === currentAssistantIdRef.current
        ? { ...m, content: m.content + content }
        : m,
    );
  });
  break;
}
```

**tool_start / tool_end / done 处理中封存分段：**

```tsx
case "tool_start": {
  // 分段边界：封存当前文本分段，后续文本进新气泡
  currentAssistantIdRef.current = null;
  // ...现有 tool_start 逻辑（工具卡片）不变
  break;
}

case "tool_end": {
  // 工具结束后 AI 若继续说话 → 新气泡（也封存，保持干净）
  currentAssistantIdRef.current = null;
  // ...现有 tool_end 逻辑不变
  break;
}

case "done": {
  currentAssistantIdRef.current = null;
  break;
}
```

**handleSend（发新消息）时重置：**

```tsx
function handleSend(text: string) {
  currentAssistantIdRef.current = null;
  // ...现有逻辑不变
}
```

### 3. App.tsx — handleAnswer（resume 流程）统一用同一套分段逻辑

当前 resume 的 `parseDataStream` 用 `onText` 直接拼到固定 assistantId。**改造**：resume 的响应流也用统一的 `text_delta` 事件驱动（复用 handleDataEvent）：

```tsx
// 方案：resume 的 onText 不再直接拼，而是转成事件
await parseDataStream(response, {
  onText: (delta) => {
    // 复用 handleDataEvent 的 text_delta 分支
    handleDataEvent({ type: "text_delta", content: delta } as DataStreamEvent);
  },
  onEvent: (event) => handleDataEvent(event),
});
```

> 这样 resume 的文本也走"分段管理"，与 chat 行为一致。注意：resume 开始前 `currentAssistantIdRef.current = null`（确保回答后的文本从新气泡开始）。

### 4. chat-message-list.tsx — 渲染微调

- 现有"一条 assistant 消息一个气泡"逻辑**保持不变**（分段已经在前端数据层完成，渲染层不用动）
- 光标逻辑保持：`isLast && msg.role === "assistant" && isLoading`
- **可选优化**：`msg.content` 为空且非最后一条的 assistant 消息不渲染（防空气泡残留）

### 5. 类型补充

`DataStreamEvent` 接口加 `text_delta` 类型 + `content` 字段：

```ts
export interface DataStreamEvent {
  type: "session" | "tool_start" | "tool_end" | "interrupt" | "done" | "error" | "text_delta";
  // ...
  content?: string;  // text_delta 用
}
```

---

## 四、验收标准

1. `pnpm typecheck` 全绿；`pnpm build` 全绿
2. **浏览器实测**（触发一个会调多个工具的完整流程）：
   - AI 回复拆成多个气泡：工具调用前的文本单独一个气泡，工具调用后的文本/总结各自成气泡
   - 工具卡片正常显示在对应位置
   - 流式打字正常（光标在最后一段末尾）
   - 没有空气泡
   - 用户消息不受影响
3. **resume 流程实测**：AI 提问 → 回答 → 继续执行，回答后的文本从新气泡开始，多轮澄清也能正确分段
4. 无回归：上传文件、工具链面板、保存按钮正常

---

## 五、红线

- ❌ 不改后端（SSE 协议、工具、agent 逻辑一个不动）
- ❌ 不加新依赖
- ❌ 不引入 markdown 渲染库（分段是纯文本气泡，不做富文本）
- ✅ 只改：data-stream.ts（0:→text_delta 转换）+ App.tsx（分段管理）+ chat-message-list.tsx（空气泡过滤）+ 类型定义
- ✅ 保持现有样式体系（新气泡复用 .msg-bubble / .msg-ai 样式）
