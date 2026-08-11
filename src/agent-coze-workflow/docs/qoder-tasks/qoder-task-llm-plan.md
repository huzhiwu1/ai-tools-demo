# Qoder 任务：plan 接口接入 DeepSeek LLM 真实规划

> 项目：`/Users/huzhiwu/workspace/ai-tools-demo/src/agent-coze-workflow`
> 技术栈：NestJS 11 + pnpm workspace + Turborepo
> 原则：**最小改动、不引 LangChain/LangGraph（骨架注释里的旧设想，依赖太重）、不新增重型依赖；只装 dotenv（或 @nestjs/config，二选一，dotenv 优先）**

---

## 一、项目现状（先读这些文件）

- `apps/api/src/workflow/workflow.service.ts` — `plan()` 目前返回**写死的 mock WorkflowPlan**
- `apps/api/src/workflow/workflow.module.ts` — 注册了 WorkflowService/WorkflowController
- `apps/api/src/prompts/plan-prompt.ts` — 已落地的 `PLAN_PROMPT` 常量（需求解析 prompt，输出结构化 JSON）
- `apps/api/src/agents/workflow-planner.ts` — 骨架空壳（TODO 注释，类都没方法），**任务是把 `WorkflowPlanner.plan()` 实现出来**
- `apps/api/src/agents/agents.module.ts` — 空壳模块，providers/exports 全是 TODO 注释
- `apps/api/src/app.module.ts` — 根模块，只 imports 了 WorkflowModule（agents 模块未接入）
- `.env`（项目根目录，已 gitignore）— 已有 OPENAI_API_KEY / COZE_* 等配置，**还没有 DEEPSEEK_API_KEY，且整个项目没有任何 dotenv 加载逻辑**（`process.env` 目前只读系统环境变量）
- `apps/api/src/main.ts` — 启动入口，未加载 .env

## 二、目标

`POST /workflow/plan` 从"返回 mock 计划"变为：
1. 调 DeepSeek API（原生 fetch，OpenAI 兼容协议）
2. 用 `PLAN_PROMPT` 作为 system prompt，用户需求作为 user message
3. LLM 输出结构化 JSON → 后端**映射为 `WorkflowPlan`**（shared 包类型：name / description / steps[{order, description, nodeType, dependencies}] / modules / estimatedComplexity）
4. **LLM 调用失败时必须降级**：返回现有 mock 计划 + `console.warn`，接口不挂、前端不白屏

> 为什么 LLM 不直接输出 WorkflowPlan？—— 结构组装交给代码，LLM 只做语义解析（模板化优先原则）。LLM 输出的是"结构化需求"，service 负责翻译成 WorkflowPlan。

## 三、LLM 输出契约（PLAN_PROMPT 要求的字段）

```json
{
  "mode": "问答",
  "goal": "一句话描述工作流目标",
  "inputType": "用户输入类型描述",
  "outputType": "输出类型描述",
  "needBranch": false,
  "needCodeNode": false,
  "needDatabaseNode": false,
  "constraints": ["约束1"],
  "riskHints": ["风险提示1"]
}
```

**后端映射规则（写进代码注释）：**

- `name`：goal 截断 30 字符
- `description`：goal（constraints 非空时追加 "；约束：..."）
- `steps`（建议顺序，order 从 1 递增，dependencies = 前一步的 order）：
  1. `start` — 接收用户输入
  2. `needDatabaseNode === true` → `database_query` — 查询数据
  3. `needCodeNode === true` → `code` — 数据处理
  4. `needBranch === true` → `condition` — 条件分支
  5. `llm` — 核心处理（必须）
  6. `end` — 返回结果
- `modules`：steps 里出现的 nodeType 去重
- `estimatedComplexity`：节点数 ≤3 → `simple`；≤5 → `medium`；否则 `complex`

## 四、任务清单

### 任务 1：环境变量加载

- `pnpm --filter @coze-workflow/api add dotenv`
- `main.ts` 顶部（import "reflect-metadata" 之后）加载根目录 `.env`：
  ```ts
  import * as dotenv from "dotenv";
  import * as path from "path";
  // 从 dist/main.js 出发定位到项目根 .env（turbo 跑 dev 时 cwd 是包目录，必须用 __dirname 定位）
  dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
  ```
  > 注意：dev 模式（nest start --watch）编译产物在 `apps/api/dist/`，`__dirname` 是 `apps/api/dist`，`../../../.env` 正好到项目根。启动时打印一行日志确认：`console.log("[API] 加载 .env:", !!process.env.DEEPSEEK_API_KEY)`（只打印是否存在，**不要打印 key 本身**）。
- 根目录 `.env` 追加三个占位（**key 值留空让用户自己填，不要写死、不要编造 key**）：
  ```
  DEEPSEEK_API_KEY=
  DEEPSEEK_BASE_URL=https://api.deepseek.com
  DEEPSEEK_MODEL=deepseek-chat
  ```
- `.env.example`（如果存在）同步加这三个字段的示例

### 任务 2：LLM 客户端

新建 `apps/api/src/llm/deepseek.client.ts`（目录不存在就建）：

- 类 `DeepSeekClient`，构造参数从 `process.env` 读：apiKey（必填）、baseUrl（默认 `https://api.deepseek.com`）、model（默认 `deepseek-chat`）
- 方法 `chat(systemPrompt: string, userPrompt: string): Promise<string>`：
  - 原生 fetch `POST {baseUrl}/chat/completions`
  - headers：`Content-Type: application/json`、`Authorization: Bearer {apiKey}`
  - body：`{ model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }], temperature: 0.2, response_format: { type: "json_object" } }`
  - 超时：AbortController 10s
  - 非 2xx：抛错带状态码和响应体摘要
  - 返回 `choices[0].message.content`
- 方法 `chatJson<T>(systemPrompt, userPrompt): Promise<T>`：
  - 调 `chat` 拿字符串
  - **容错解析**：先剥 ```json ... ``` 代码块 → 找不到就截取第一个 `{` 到最后一个 `}` → `JSON.parse` → 解析失败抛错

### 任务 3：实现 WorkflowPlanner

改造 `apps/api/src/agents/workflow-planner.ts`：

- 类 `WorkflowPlanner`，构造函数注入 `DeepSeekClient`（或直接接收 client 实例）
- 方法 `async plan(requirement: { description: string; constraints?: string[] }): Promise<WorkflowPlan>`
- 逻辑：
  1. `const raw = await client.chatJson<LLMPlanOutput>(PLAN_PROMPT, requirement.description)`（PLAN_PROMPT 从 `../prompts` 导入）
  2. 按第三节映射规则组装 WorkflowPlan
  3. 用 `generateId()` 或固定字符串给步骤描述，不涉及 Coze 节点 ID（那是 generate 阶段的事）

### 任务 4：装配

- `apps/api/src/agents/agents.module.ts`：注册 `DeepSeekClient` 和 `WorkflowPlanner` 到 providers + exports（useFactory 或直接 new，任选，代码注释说明为什么）
- `apps/api/src/agents/index.ts`：导出 DeepSeekClient、WorkflowPlanner
- `apps/api/src/app.module.ts`：imports 加入 `AgentsModule`
- `apps/api/src/workflow/workflow.module.ts`：imports 加入 `AgentsModule`（WorkflowService 要注入 WorkflowPlanner）
- `apps/api/src/workflow/workflow.service.ts`：
  - 构造函数注入 `WorkflowPlanner`（NestJS 构造函数注入）
  - `plan()` 改为：`try { return createApiResponse(await planner.plan(requirement)) } catch (e) { console.warn("[WorkflowPlanner] LLM 规划失败，降级 mock:", e.message); return createApiResponse(现有 mock 计划) }`
  - **保留现有 mock 计划代码作为降级分支**

## 五、验收（必须亲自跑通）

1. `pnpm typecheck` 全绿
2. `pnpm build` 全绿
3. 启动 API（`pnpm --filter @coze-workflow/api start:dev`），日志出现 `.env` 加载确认行
4. **用户填入 DEEPSEEK_API_KEY 后**，`curl -X POST http://localhost:3000/workflow/plan -H 'Content-Type: application/json' -d '{"description":"接收用户问题，查询数据库后交给大模型分析，再根据结果分支处理"}'`
   - 返回的 `data.steps` 应包含 database_query / condition 等节点（证明 LLM 解析生效），`estimatedComplexity` 合理
5. 不填 key 或断网时再调一次：返回 mock 计划 + 后端日志有 warn，接口 HTTP 200（降级生效）

## 六、红线

- 不引 LangChain / LangGraph / axios
- 不把 key 写进任何代码文件或 .env.example（.env 已 gitignore，注意别误提交）
- 不改 `workflow.controller.ts` 路由
- 不删 `apps/api/src/schema/`、`apps/api/src/validator/` 下的既有文件
- `packages/shared`、`packages/workflow-schema` 不允许改（类型已够用）
- 完成后贴 typecheck / build 输出 + 一次成功规划的真实响应（key 打码）
