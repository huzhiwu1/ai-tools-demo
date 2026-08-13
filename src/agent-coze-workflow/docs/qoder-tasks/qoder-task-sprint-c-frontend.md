# Qoder 任务：Sprint C — 前端改造（Vercel AI SDK 对话 + 文件上传 + 样式美化）

> 项目：`/Users/huzhiwu/workspace/ai-tools-demo/src/agent-coze-workflow`
> 技术栈：React 18 + Vite 5 + NestJS 11 + LangGraph + pnpm workspace
> **目标：把前端从"输入框 + 按钮 + JSON 预览"升级为"类 ChatGPT 对话界面"：流式对话、AI 提问时能回答、能上传文件、样式现代化。后端 SSE 协议改造成 Vercel AI SDK 标准 Data Stream Protocol。**

---

## 一、项目现状（先读这些文件）

**前端（apps/web/）：**
- `src/App.tsx` — 三栏布局：左侧 InputPanel（需求输入）| 中间 WorkflowCanvas（草图）| 右侧 JsonPreview + 保存按钮 + RunLogPanel（执行日志）
- `src/api/workflow.ts` — 原生 fetch 封装，`BASE_URL = "http://localhost:3000"`（**应该改成相对路径走 vite proxy**）
- `src/components/` — Header / InputPanel / WorkflowCanvas / JsonPreview / RunLogPanel
- `src/styles/global.css` — 508 行手写样式
- `vite.config.ts` — 已有 `/api` 代理到 `http://localhost:3000`（前端用相对路径 `/api/...` 即可）
- `package.json` — 只有 react/react-dom + shared，**没有 Vercel AI SDK**

**后端（apps/api/）：**
- `src/agent/react-agent.controller.ts` — `POST /api/agent/chat`（SSE）+ `POST /api/agent/chat/resume`
- `src/agent/react-agent.service.ts` — `streamAgentEvents()` 输出自定义 SSE 事件（`event: message/tool_start/tool_end/interrupt/done/session`）
- `src/agent/session.store.ts` — 内存会话管理

**当前 SSE 事件格式（即将改造）：**
```
event: session      → data: { sessionId }
event: message      → data: { content }        （LLM 文本增量）
event: tool_start   → data: { name, input }
event: tool_end     → data: { name, output }
event: interrupt    → data: { question, context?, sessionId }
event: done         → data: { final }
event: error        → data: { message }
```

---

## 二、目标

1. **后端协议改造**：SSE 输出改成 **Vercel AI SDK Data Stream Protocol**（`0:` 文本增量 / `d:` 结构化数据 / `e:` 结束），前端 `useChat` 开箱即用
2. **前端接入 Vercel AI SDK**：安装 `ai` + `@ai-sdk/react`，用 `useChat` 实现流式对话
3. **对话交互**：消息气泡（用户/AI）、流式打字效果、工具调用过程展示、**AI 提问时显示回答输入框（interrupt/resume）**
4. **文件上传**：上传按钮 + 拖拽，POST 到新后端接口，上传后显示文件列表，消息发送时携带文件引用
5. **样式美化**：现代化 AI 对话界面（参考 ChatGPT/Claude 风格），保留工作流 JSON/验证结果展示区

---

## 三、后端配套改动（Sprint C 的一部分）

### 1. SSE 改造成 AI SDK Data Stream Protocol（react-agent.service.ts）

Vercel AI SDK 流式协议格式（每行一个事件，`\n` 分隔）：

```
# 文本增量（拼接成消息内容）
0:"你"

# 结构化数据（useChat 的 data 数组收到）
d:{"type":"tool_start","name":"plan_workflow","input":{...}}
d:{"type":"tool_end","name":"plan_workflow","output":"..."}
d:{"type":"interrupt","question":"...","context":"...","sessionId":"..."}
d:{"type":"session","sessionId":"..."}
d:{"type":"done","final":"..."}

# 流结束标记
e:{"type":"finish"}
```

**改动点（react-agent.service.ts 的 streamAgentEvents）**：

```ts
// 文本增量（替代 event: message）
res.write(`0:${JSON.stringify(content)}\n`);

// 结构化事件（替代 event: tool_start/tool_end/interrupt/session/done）
res.write(`d:${JSON.stringify({ type: "tool_start", name, input })}\n`);
res.write(`d:${JSON.stringify({ type: "interrupt", question, context, sessionId })}\n`);

// 流结束
res.write(`e:${JSON.stringify({ type: "finish" })}\n`);
```

**具体映射规则：**
- `on_chat_model_stream` 的文本 → `0:"..."`（保持增量，前端自动拼接）
- `on_tool_start` → `d:{"type":"tool_start","name":...,"input":...}`
- `on_tool_end` → `d:{"type":"tool_end","name":...,"output":<纯文本>}`（**结合小修复 1，output 必须是 kwargs.content 纯文本**）
- interrupt 检测到 → `d:{"type":"interrupt","question":...,"context":...,"sessionId":...}` 然后结束流（`e:` 可不发或发）
- 无 interrupt → `d:{"type":"done","final":...}` + `e:{"type":"finish"}`
- 会话创建 → 流开始前先发 `d:{"type":"session","sessionId":...}`
- 错误 → `d:{"type":"error","message":...}` + 结束
- **注意**：SSE 响应的 Content-Type 保持 `text/event-stream`（Vercel AI SDK 的 useChat 用 fetch 读流，兼容）

**resume 接口（react-agent.controller.ts）不改路径**，同样输出 Data Stream 格式。

### 2. 新增文件上传接口（react-agent.controller.ts + 依赖）

```
POST /api/agent/upload        （multipart/form-data，字段名 file）
响应: { fileId, name, size, mimeType, path }
```

**实现要点：**
- 用 NestJS 内置 `FileInterceptor`（`@nestjs/platform-express` 自带 multer，**不需要新装 multer**）
- 文件保存到 `apps/api/uploads/` 目录（相对项目根 `uploads/`，gitignore）
- `fileId` 用 `crypto.randomUUID()`，返回给前端
- 文件信息和文件内容由后续 Sprint B（答案表解析）使用，**本任务只做到"能上传、能存、能返回 fileId"**
- 控制器里加：
  ```ts
  @Post("upload")
  @UseInterceptors(FileInterceptor("file", { dest: uploadDir }))
  upload(@UploadedFile() file: Express.Multer.File) {
    return { fileId: crypto.randomUUID(), name: file.originalname, size: file.size, mimeType: file.mimetype, path: file.path };
  }
  ```
- 上传目录不存在则创建（`fs.mkdirSync(uploadDir, { recursive: true })`）

### 3. 前端 API 改造（src/api/workflow.ts）

- `BASE_URL` 改为相对路径（去掉 `http://localhost:3000`），走 vite proxy：`/workflow/run`、`/api/agent/chat` 等
- 新增 `uploadFile(file: File)` 函数（FormData POST /api/agent/upload）

---

## 四、前端改造（重点）

### 1. 安装依赖

```bash
pnpm --filter @coze-workflow/web add ai @ai-sdk/react
```

### 2. 对话界面结构（App.tsx 重构）

```
┌─────────────────────────────────────────────────────┐
│ Header（标题 + 状态）                                │
├──────────────────────────────┬──────────────────────┤
│ 对话主区（左侧，flex:1）      │ 右侧面板（360px）     │
│  ┌────────────────────────┐  │ ├─ 工具调用链         │
│  │ 消息列表（滚动）         │  │ │   plan_workflow ✓  │
│  │  - 用户气泡             │  │ │   generate ✓       │
│  │  - AI 气泡（流式打字）   │  │ │   save_to_coze ✓   │
│  │  - 工具调用卡片          │  │ ├─ 工作流 JSON       │
│  │  - ⚠️ AI 提问卡片 + 输入框│  │ ├─ 校验结果          │
│  └────────────────────────┘  │ └─ 保存到 Coze 按钮   │
│  ┌────────────────────────┐  │                      │
│  │ 输入区：textarea + 上传  │  │                      │
│  │ 按钮 + 文件列表 + 发送   │  │                      │
│  └────────────────────────┘  │                      │
└──────────────────────────────┴──────────────────────┘
```

### 3. useChat 集成（核心）

```tsx
import { useChat } from "@ai-sdk/react";

const { messages, input, handleInputChange, handleSubmit, data, setMessages, isLoading } =
  useChat({
    api: "/api/agent/chat",
    body: { sessionId },  // sessionId 从 data 事件里提取后回填
  });
```

- `data` 数组包含所有 `d:` 事件，用 `useEffect` 监听：
  - `type === "session"` → 保存 sessionId 到 state，之后 body 带上
  - `type === "interrupt"` → 设置 `pendingQuestion = data`，消息流末尾渲染提问卡片
  - `type === "tool_start"/"tool_end"` → 追加到右侧工具调用链
  - `type === "done"` → 更新状态
- `messages` 里 AI 消息 content 自动流式拼接（useChat 内置）

### 4. interrupt/resume 交互（关键）

```
AI 提问卡片渲染在消息流末尾：
┌─────────────────────────────┐
│ 🤔 AI 需要确认：              │
│ "训练营歌曲具体指什么？..."    │
│ [回答输入框            ]      │
│ [提交回答]                    │
└─────────────────────────────┘
```

**resume 实现**（两个方案二选一，推荐 A）：

- **方案 A（推荐，简单）**：提交回答时手动 fetch `POST /api/agent/chat/resume`（body: `{ sessionId, answer }`），用 `fetch + ReadableStream` 解析返回的 Data Stream，把 AI 回复追加到 messages。写一个 `parseDataStream(response, handlers)` 工具函数（约 40 行），支持 `0:` 文本拼接和 `d:` 事件分发。
- 方案 B：用第二个 useChat 实例（api 指向 resume），但需要处理消息合并，复杂度高，不推荐。

**提交回答后**：
1. 把用户回答作为一条 user 消息 `setMessages([...prev, { role: "user", content: answer }])`
2. 调 resume 接口，流式追加 AI 回复
3. 清除 pendingQuestion 状态
4. 后续若再次收到 interrupt 事件，重复上述流程（多轮澄清）

### 5. 文件上传

```tsx
// 上传按钮 + 拖拽区（input type=file / drag-drop）
const [files, setFiles] = useState<UploadedFile[]>([]);

async function handleUpload(file: File) {
  const res = await workflowApi.uploadFile(file);
  setFiles((prev) => [...prev, res]);
}

// 发送消息时携带文件引用
function handleSubmitWithFiles(e) {
  const fileNote = files.length
    ? `\n\n[用户上传了文件]\n${files.map(f => `- ${f.name} (fileId: ${f.fileId})`).join("\n")}`
    : "";
  handleSubmit(e, { data: undefined });  // 或自定义拼接
  // 消息内容 = input + fileNote
}
```

- 上传后显示文件 chip（文件名 + 移除按钮）
- 发送后清空文件列表
- 文件引用以文本形式附加在消息里（Sprint B 做真正的解析，本任务先传递 fileId）

### 6. 样式美化（styles/global.css 或新增）

- 现代化设计：圆角卡片、柔和阴影、渐变色主题（保留现有 CSS 变量风格）
- 消息气泡：用户右侧蓝色系 / AI 左侧浅色系
- 流式打字：光标闪烁效果（`@keyframes blink`）
- 工具调用链：时间线样式（节点 + 状态色）
- 提问卡片：醒目边框 + 输入框样式
- 输入区：固定底部，textarea 自适应高度，发送按钮
- 响应式：窄屏时右侧面板可折叠（简单实现即可）

---

## 五、验收标准

1. `pnpm typecheck` 全绿；`pnpm build` 全绿
2. **后端协议验证**（curl）：
   ```bash
   curl -N -s -X POST http://localhost:3000/api/agent/chat \
     -H "Content-Type: application/json" \
     -d '{"message":"帮我做一个简单问答工作流"}'
   ```
   预期输出格式：`0:"..."`、`d:{"type":"tool_start",...}`、`d:{"type":"done",...}`、`e:{"type":"finish"}`（不再是 `event: message` 格式）
3. **前端功能验证**（浏览器 http://localhost:5173）：
   - 输入需求 → 发送 → AI 消息流式打字输出 → 右侧工具调用链实时更新 → 完成后显示工作流 JSON/校验结果
   - 发一个缺信息需求（如"判断音频是否训练营歌曲"）→ AI 提问卡片出现 → 输入回答提交 → AI 继续执行
   - 上传一个文件 → 显示文件 chip → 消息里带文件引用
   - 多轮对话正常（sessionId 保持）
4. 旧功能不回归：`/workflow/run` 相关按钮（如果保留）仍可用；`/api/agent/chat` 用新协议后，旧前端代码若还按 `event:` 解析会失效——**前端整体切换，不留旧解析代码**

---

## 六、红线

- ❌ 不迁 Next.js（保持 React + Vite）
- ❌ 不加 UI 框架（不用 Tailwind / antd / MUI，手写 CSS）
- ❌ 不改后端 agent 逻辑（只改 SSE 输出格式 + 加 upload 接口）
- ❌ 不实现答案表解析/批量验证（那是 Sprint B）
- ❌ 不把凭证写进前端代码
- ✅ 可以删掉不再使用的旧组件（InputPanel 等），但 WorkflowCanvas/JsonPreview 的展示逻辑要保留（嵌入右侧面板）

---

## 七、实现顺序建议

1. 后端：react-agent.service.ts 改 Data Stream 协议 + controller 加 upload 接口
2. 后端验证：curl 确认新协议格式
3. 前端：装依赖 → workflow.ts 改相对路径 + uploadFile
4. 前端：App.tsx 重构为对话布局 + useChat 集成
5. 前端：interrupt/resume 交互 + parseDataStream 工具
6. 前端：文件上传 UI
7. 前端：样式美化
8. 全量验收（typecheck/build/浏览器三场景）
