# Qoder 任务：Sprint A — ReAct Agent 核心骨架（createReactAgent + 基础工具 + SSE 流式）

> 项目：`/Users/huzhiwu/workspace/ai-tools-demo/src/agent-coze-workflow`
> 技术栈：NestJS 11 + LangGraph（@langchain/langgraph）+ pnpm workspace + Turborepo
> **目标：把 agent-coze-workflow 从"固定链路生成器"升级为"ReAct 自主工作流构建 Agent"——用户给需求，Agent 边思考边调工具，自主完成 设计→生成→部署→试运行。**

---

## 一、项目现状（先读这些文件）

- `apps/api/src/agents/graph.ts` — 现有固定链路 StateGraph（plan→sketch→generate→validate→repair），**本任务不动它**，新增独立的 ReAct Agent
- `apps/api/src/agents/workflow-planner.ts` — `WorkflowPlanner.plan()` 已接 DeepSeek 真实 LLM（withStructuredOutput + zod），返回 WorkflowPlan
- `apps/api/src/agents/workflow-generator.ts` — `WorkflowGenerator.generateWorkflow(plan)` 把 Plan 映射为 CozeWorkflow（模板化，支持 start/llm/code/condition/http/database_query/text/merge/end）
- `apps/api/src/mcp/cozeClient.ts` — CozeClient：createWorkflow / saveWorkflow / testRun / listWorkflows / updateMeta（cookie 认证 + 编辑锁 + 777777759 重试，已可用）
- `apps/api/src/mcp/schema-converter.ts` — `convertToPlatformSchema(workflow)` 项目格式 → 平台内部 schema JSON 字符串
- `apps/api/src/mcp/mcp-server.ts` — 已存在的标准 MCP server（stdio），**本任务不依赖它**，直接复用 CozeClient
- `apps/api/src/app.module.ts` — 根模块（WorkflowModule + AgentsModule + McpModule）
- `.env`（项目根）— DEEPSEEK_API_KEY / COZE_API_BASE_URL / COZE_SESSION_KEY / COZE_SPACE_ID 已配
- `packages/shared/src/types/index.ts` — WorkflowPlan / WorkflowSketch / UserRequirement 类型

**关键依赖（已安装，直接用）**：@langchain/langgraph ^1.4.9、@langchain/openai、@langchain/core、zod ^4.4.3

---

## 二、目标

新增 **ReAct Agent**，提供流式聊天接口，用户输入自然语言需求后：

1. Agent 用 LLM 思考，自主决定调用哪些工具（**ReAct 循环**：思考→行动→观察）
2. 工具集（本 Sprint 实现 5 个）：
   - `clarify_question` — **缺信息时主动提问，暂停等待用户回答**（human-in-the-loop）
   - `plan_workflow` — 需求 → WorkflowPlan（复用 WorkflowPlanner）
   - `generate_workflow` — Plan → CozeWorkflow（复用 WorkflowGenerator + 本地校验）
   - `save_to_coze` — 部署到平台（复用 CozeClient + schema-converter）
   - `test_run_workflow` — 试运行（复用 CozeClient.testRun）
3. `POST /api/agent/chat` 返回 **SSE 流**：agent 的 LLM 文本、工具调用、中断提问、最终结果全部流式推给前端
4. **澄清机制**：Agent 发现需求缺信息（如"歌曲库在哪""答案表格式"）时调用 clarify_question，SSE 推送问题，**用户回答后继续执行**（interrupt/resume 模式）

> 为什么用 createReactAgent？—— LangGraph 官方高层封装，内置 ReAct 循环（思考→工具调用→观察），省去手写状态机；interrupt() 支持 human-in-the-loop 暂停/恢复，天然适配"缺信息就问"。自建 StateGraph 循环的对比文章后续单独输出。

---

## 三、关键设计决策（照此实现）

### 1. 文件位置与模块结构

```
apps/api/src/agent/                     ← 新目录（区别于旧 agents/）
├── react-agent.module.ts               ← NestJS 模块
├── react-agent.service.ts              ← 会话管理 + graph 实例持有 + SSE 事件流
├── react-agent.controller.ts           ← POST /api/agent/chat（SSE）
├── tools/
│   ├── index.ts                        ← 工具注册列表（供 createReactAgent 使用）
│   ├── clarify.tool.ts                 ← clarify_question
│   ├── plan.tool.ts                    ← plan_workflow
│   ├── generate.tool.ts                ← generate_workflow
│   ├── save.tool.ts                    ← save_to_coze
│   └── test-run.tool.ts                ← test_run_workflow
└── session.store.ts                    ← 内存会话存储（sessionId → { graph, messages }）
```

### 2. createReactAgent 实例化（react-agent.service.ts）

```ts
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import { InMemorySaver } from "@langchain/langgraph";
import { tool } from "@langchain/core/tools";
```

- **LLM**：`new ChatOpenAI({ model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat", apiKey: process.env.DEEPSEEK_API_KEY, configuration: { baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1" } })`
- **Checkpointer**：`new InMemorySaver()`（interrupt/resume 必须），每个会话一个独立 graph 实例（InMemorySaver 不支持跨实例恢复，所以 **session.store.ts 里每个 sessionId 缓存一个编译后的 graph**）
- **编译**：`createReactAgent({ llm, tools, checkpointer }).compile()`，注意 tools 里要有 `interrupt` 相关的支持（createReactAgent 原生支持工具内调用 `interrupt()`，无需额外配置）

### 3. 澄清机制（human-in-the-loop，核心）

`clarify_question` 工具实现：

```ts
import { interrupt } from "@langchain/langgraph";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

export const clarifyQuestionTool = tool(
  async ({ question, context }) => {
    // interrupt 暂停图执行，把问题抛给外部；resume 传入用户回答后继续
    const answer = await interrupt({ question, context });
    return `用户回答: ${answer}`;
  },
  {
    name: "clarify_question",
    description:
      "当用户需求信息不完整时调用（例如缺少数据源、格式约定、输出要求、验收标准等）。调用后工作流暂停，等待用户回答，收到回答后自动继续。",
    schema: z.object({
      question: z.string().describe("向用户提出的具体问题（一次只问一个最关键的）"),
      context: z.string().optional().describe("补充说明为什么需要这个信息"),
    }),
  }
);
```

**SSE 流程**：
1. Agent 调 clarify_question → graph 执行到 interrupt 处暂停
2. `graph.streamEvents()` 产生 `on_chat_model_stream` / 工具事件，**interrupt 时流会结束**（pending）
3. 后端从 stream 结果拿到 `interruptInfo`（`graph.getState(config)` 或 stream 返回的 `__interrupt__`），把问题通过 SSE `event: interrupt` 推给前端
4. 前端展示问题 + 回答输入框；用户提交回答后，调用 `POST /api/agent/chat/resume`（body: `{ sessionId, answer }`）
5. resume 接口执行 `graph.invoke(null, { config, command: new Command({ resume: answer }) })`（**LangGraph Command API**，`import { Command } from "@langchain/langgraph"`），图从 interrupt 处继续

### 4. SSE 接口（react-agent.controller.ts）

```
POST /api/agent/chat
Body: { sessionId?: string, message: string }
响应: text/event-stream

POST /api/agent/chat/resume
Body: { sessionId: string, answer: string }
响应: text/event-stream
```

**事件格式约定（前端 Sprint C 会按此解析，现在定死）：**

```
event: message         → Agent 的 LLM 文本增量（data: { content: "..." }）
event: tool_start      → 工具开始（data: { name, input }）
event: tool_end        → 工具结束（data: { name, output }）
event: interrupt       → 澄清提问（data: { question, context?, sessionId }）
event: done            → 全部完成（data: { final: "..." }）
event: error           → 异常（data: { message }）
```

**实现要点**：
- 用 `@Res()` 手动写 SSE（POST 场景 @Sse() 只支持 GET），设置 `res.setHeader("Content-Type", "text/event-stream")`、`"Cache-Control": "no-cache"`、`"Connection": "keep-alive"`，`res.flushHeaders()`
- 用 `graph.streamEvents(input, { version: "v2", config: { configurable: { thread_id: sessionId } } })` 迭代事件：
  - `on_chat_model_stream` → 解析 `event.data.chunk` 文本 → `event: message`
  - `on_tool_start` / `on_tool_end` → `event: tool_start/tool_end`
  - 流结束后检查是否 interrupt（`await graph.getState(config)` 的 `next` 非空或存在 interrupt 值）→ 发 `event: interrupt`
  - 无 interrupt → 取最后消息 → `event: done`
- 客户端断开时（`res.destroyed` / abort 事件）停止迭代，避免内存泄漏
- **10 秒无事件发心跳注释**（`event: ping`）可选，先不做也行

### 5. 其余 4 个工具（薄封装，复用现有逻辑）

**⚠️ 所有工具使用模块级单例，不要在工具函数内 new！**（避免每次调用重建 ChatOpenAI/CozeClient 连接池）

```ts
// ✅ 推荐：模块顶层创建单例（文件加载时执行，晚于 main.ts 的 dotenv.config，env 已就绪）
const planner = new WorkflowPlanner();          // 内部 new DeepSeekClient()，无状态，可安全共享
const generator = new WorkflowGenerator();      // 无状态
const cozeClient = new CozeClient({             // 内部管理锁状态，save 前自动 ensureLock
  baseUrl: process.env.COZE_API_BASE_URL ?? "",
  sessionKey: process.env.COZE_SESSION_KEY ?? "",
  spaceId: process.env.COZE_SPACE_ID ?? "",
});

// ❌ 不要：const workflowId = await new CozeClient(config).createWorkflow(...)
```

- `plan_workflow({ requirement })` → `planner.plan(...)`，输出 `plan`（WorkflowPlan）
- `generate_workflow({ plan })` → `generator.generateWorkflow(plan)`，输出 workflow；**返回前先跑校验**，`validateWorkflow` 必须从 `@coze-workflow/workflow-schema` 导入（**不要从 apps/api/src/validator/ 导入**，那是 TODO 空壳）：`import { validateWorkflow } from "@coze-workflow/workflow-schema";`；若 invalid 把 errors 附在输出里（`{ workflow, validation }`）
- `save_to_coze({ workflow })` → `convertToPlatformSchema(workflow)`（从 `../mcp/schema-converter` 导入）→ `cozeClient.createWorkflow` + `saveWorkflow`，输出 `{ workflowId, saved: true }`
- `test_run_workflow({ workflowId, input })` → `cozeClient.testRun(workflowId, input)`，输出 `{ executeId }`

**⚠️ 所有工具函数必须 try/catch，错误以友好字符串返回给 LLM（不要抛异常）**：

```ts
export const saveToCozeTool = tool(
  async ({ workflow }) => {
    try {
      const schemaJson = convertToPlatformSchema(workflow as unknown as CozeWorkflow);
      const workflowId = await cozeClient.createWorkflow(
        workflow.meta.name,
        workflow.meta.description,
      );
      await cozeClient.saveWorkflow(workflowId, schemaJson);
      return `工作流已保存到 Coze 平台，workflowId: ${workflowId}`;
    } catch (e) {
      // 返回错误文本而非抛异常：LLM 能看到错误并决定下一步（重试/换方案/告知用户）
      return `保存失败: ${(e as Error).message}`;
    }
  },
  { name: "save_to_coze", description: "...", schema: z.object({ ... }) },
);
```

**工具 schema 用 zod 定义**，description 写清楚（Agent 靠 description 决定何时调用，写详细！）。

### 6. 会话管理（session.store.ts）

```ts
interface Session {
  graph: ReturnType<typeof createReactAgent>["compile"] extends infer G ? G : never;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  createdAt: number;
}
```

- `Map<string, Session>` 内存存储（简单可靠，重启即清，可接受）
- sessionId 由前端传或首次自动生成（`crypto.randomUUID()`），SSE 响应里带回
- **多轮对话**：每次 chat 把历史 messages 拼进输入（`{ messages: [...history, { role: "user", content: message }] }`），createReactAgent 的输入格式就是 `{ messages: BaseMessage[] }`

---

## 四、验收标准（必须全部通过）

1. `pnpm typecheck` 全绿；`pnpm build` 全绿
2. 启动后端 `pnpm --filter @coze-workflow/api dev`
3. **curl 冒烟测试**（SSE 流）：
   ```bash
   curl -N -X POST http://localhost:3000/api/agent/chat \
     -H "Content-Type: application/json" \
     -d '{"message":"帮我做一个简单问答工作流：用户输入问题，LLM 回答"}'
   ```
   预期：依次看到 `event: tool_start`(plan_workflow) → `event: tool_end` → `event: message` → `event: done`
4. **澄清测试**：发消息 `"帮我做一个判断音频是否训练营歌曲的工作流"`（故意缺歌曲库/输出格式信息）
   预期：Agent 调用 clarify_question → SSE 收到 `event: interrupt` 带问题 → 调 resume 接口带回答 → 继续执行直到 done
   **⚠️ interrupt 实测确认**：createReactAgent 遇到 interrupt() 时 streamEvents 正常结束流（不抛异常），interrupt 值通过 `graph.getState(config)` 读取（next 数组 / interrupt 字段）——**实现时务必实测验证这个行为**，若与预期不符（如流抛异常或拿不到 interrupt 值），调整事件发送逻辑并记录实际行为
5. **全链路测试**：连续对话让 Agent 完成 plan → generate → save_to_coze，返回真实 workflowId（Coze 平台能看到新工作流）
6. 现有功能不回归：`POST /workflow/run`（旧链路）仍正常

---

## 五、红线（不要做）

- ❌ 不改 `apps/api/src/agents/graph.ts` 旧链路（新旧共存）
- ❌ 不迁 Next.js / Turbopack（保持 React + NestJS + Turborepo）
- ❌ 不加新依赖（@langchain/* 全家桶已够；如需 @nestjs/event-emitter 之类先注释说明再问）
- ❌ 不把凭证写进代码（COZE_* / DEEPSEEK_* 都从 .env 读）
- ❌ 不实现答案表解析/批量验证/自动迭代（那是 Sprint B）
- ❌ 不改前端（前端 Sprint C 接）

---

## 六、实现顺序建议

1. session.store.ts（数据结构）
2. tools/ 5 个工具（先 clarify 后 4 个业务工具）
3. react-agent.service.ts（graph 实例化 + streamEvents 迭代 + interrupt 检测）
4. react-agent.controller.ts（SSE + resume）
5. react-agent.module.ts 注册，app.module.ts imports
6. curl 冒烟 + 澄清测试 + 全链路测试
