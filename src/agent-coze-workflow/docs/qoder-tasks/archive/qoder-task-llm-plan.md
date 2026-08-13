# Qoder 任务：plan 接口接入 DeepSeek LLM 真实规划（LangChain 版）

> 项目：`/Users/huzhiwu/workspace/ai-tools-demo/src/agent-coze-workflow`
> 技术栈：NestJS 11 + pnpm workspace + Turborepo
> **本任务基于 LangChain.js（@langchain/openai）实现，不用原生 fetch 手写 HTTP。LangGraph 编排留到下一步（多 Agent 状态机时再上）。**

---

## 一、项目现状（先读这些文件）

- `apps/api/src/workflow/workflow.service.ts` — `plan()` 目前返回**写死的 mock WorkflowPlan**
- `apps/api/src/workflow/workflow.module.ts` — 注册了 WorkflowService/WorkflowController
- `apps/api/src/prompts/plan-prompt.ts` — 已落地的 `PLAN_PROMPT` 常量（需求解析 prompt，输出结构化 JSON）
- `apps/api/src/agents/workflow-planner.ts` — 骨架空壳，**注释里明确写了 TODO：集成 LangChain ChatOpenAI、使用 withStructuredOutput 确保输出格式**——本任务就是把这些 TODO 变成实现
- `apps/api/src/agents/agents.module.ts` — 空壳模块，providers/exports 全是 TODO 注释
- `apps/api/src/app.module.ts` — 根模块，只 imports 了 WorkflowModule
- `.env`（项目根目录，已 gitignore）— 已有 OPENAI_API_KEY / COZE_* 等配置，**没有 DEEPSEEK_API_KEY，且整个项目没有任何 dotenv 加载逻辑**
- `apps/api/src/main.ts` — 启动入口，未加载 .env

## 二、目标

`POST /workflow/plan` 从"返回 mock 计划"变为：
1. 用 **LangChain ChatOpenAI**（@langchain/openai）调 DeepSeek（OpenAI 兼容协议）
2. `PLAN_PROMPT` 作为 system prompt，用户需求作为 user message
3. **用 `withStructuredOutput()` + zod schema 强制 LLM 输出结构化 JSON**
4. 后端把结构化需求**映射为 `WorkflowPlan`**（shared 包类型）
5. **LLM 调用失败时降级**：返回现有 mock 计划 + `console.warn`，接口不挂

> 为什么 LLM 不直接输出 WorkflowPlan？—— 结构组装交给代码，LLM 只做语义解析（模板化优先）。LLM 输出"结构化需求"，service 负责翻译成 WorkflowPlan。

## 三、LLM 输出契约（zod schema）

```ts
import { z } from "zod";

export const LLMPlanOutputSchema = z.object({
  mode: z.string().describe("工作流模式，如 问答/数据处理/客服"),
  goal: z.string().describe("一句话描述工作流目标"),
  inputType: z.string().describe("输入类型描述"),
  outputType: z.string().describe("输出类型描述"),
  needBranch: z.boolean().describe("是否需要条件分支节点"),
  needCodeNode: z.boolean().describe("是否需要代码节点"),
  needDatabaseNode: z.boolean().describe("是否需要数据库查询节点"),
  constraints: z.array(z.string()).describe("约束条件列表"),
  riskHints: z.array(z.string()).describe("风险提示列表"),
});

export type LLMPlanOutput = z.infer<typeof LLMPlanOutputSchema>;
```

**后端映射规则（写进代码注释）：**
- `name`：goal 截取前 30 字符
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
  > 注意：dev 模式（nest start --watch）编译产物在 `apps/api/dist/`，`__dirname` 是 `apps/api/dist`，`../../../.env` 正好到项目根。启动时打印一行确认：`console.log("[API] 加载 .env:", !!process.env.DEEPSEEK_API_KEY)`（只打印是否存在，**不要打印 key 本身**）。
- 根目录 `.env` 追加三个占位（**key 留空让用户自己填，不要编造 key**）：
  ```
  DEEPSEEK_API_KEY=
  DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
  DEEPSEEK_MODEL=deepseek-chat
  ```
- `.env.example` 同步加这三个字段的示例

### 任务 2：装 LangChain 依赖

```bash
pnpm --filter @coze-workflow/api add @langchain/openai @langchain/core zod
```

> 不装 langgraph（下一步多 Agent 编排时再装）。不装 axios。

### 任务 3：实现 DeepSeekClient（基于 LangChain）

新建 `apps/api/src/llm/deepseek.client.ts`（目录不存在就建）：

```ts
import { ChatOpenAI } from "@langchain/openai";

export class DeepSeekClient {
  private model: ChatOpenAI;

  constructor() {
    this.model = new ChatOpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY ?? "",
      baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1",
      model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
      temperature: 0.2,
      maxRetries: 1,
      timeout: 10_000,
    });
  }

  /** 带结构化输出的聊天调用：返回强类型对象，解析失败会抛错（由调用方降级） */
  async chatStructured<T>(schema: z.ZodSchema<T>, systemPrompt: string, userPrompt: string): Promise<T> {
    const structured = this.model.withStructuredOutput(schema, {
      name: "workflow_plan",
    });
    const result = await structured.invoke([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ]);
    return result;
  }
}
```

- `baseURL` 注意是 **/v1 结尾**（DeepSeek OpenAI 兼容端点）
- 不用手写 fetch / JSON 容错解析——`withStructuredOutput` 全包了（这正是骨架 TODO 注释里写的方案）
- zod 从 `zod` 导入

### 任务 4：实现 WorkflowPlanner

改造 `apps/api/src/agents/workflow-planner.ts`：

- 类 `WorkflowPlanner`，构造函数注入 `DeepSeekClient`
- 方法 `async plan(requirement: { description: string; constraints?: string[] }): Promise<WorkflowPlan>`
- 逻辑：
  1. `const raw = await this.client.chatStructured(LLMPlanOutputSchema, PLAN_PROMPT, requirement.description)`
  2. 按第三节映射规则组装 WorkflowPlan（写个私有方法 `mapToPlan(raw: LLMPlanOutput): WorkflowPlan`，步骤生成逻辑清晰注释）
  3. `LLMPlanOutputSchema` 和 `LLMPlanOutput` 定义放 `apps/api/src/agents/types.ts`（新建）

### 任务 5：装配

- `apps/api/src/agents/agents.module.ts`：注册 `DeepSeekClient`、`WorkflowPlanner` 到 providers + exports（普通 @Injectable 类，直接列 providers 数组即可）
- `apps/api/src/agents/index.ts`：导出 DeepSeekClient、WorkflowPlanner、LLMPlanOutputSchema、LLMPlanOutput
- `apps/api/src/app.module.ts`：imports 加入 `AgentsModule`
- `apps/api/src/workflow/workflow.module.ts`：imports 加入 `AgentsModule`（WorkflowService 要注入 WorkflowPlanner）
- `apps/api/src/workflow/workflow.service.ts`：
  - 构造函数注入 `WorkflowPlanner`（NestJS 构造函数注入）
  - `plan()` 改为：`try { return createApiResponse(await planner.plan(requirement)) } catch (e) { console.warn("[WorkflowPlanner] LLM 规划失败，降级 mock:", e instanceof Error ? e.message : e); return createApiResponse(现有 mock 计划) }`
  - **保留现有 mock 计划代码作为降级分支**

## 五、验收（必须亲自跑通）

1. `pnpm typecheck` 全绿
2. `pnpm build` 全绿
3. 启动 API（`pnpm --filter @coze-workflow/api start:dev`），日志出现 `.env` 加载确认行
4. **用户填入 DEEPSEEK_API_KEY 后**，`curl -X POST http://localhost:3000/workflow/plan -H 'Content-Type: application/json' -d '{"description":"接收用户问题，查询数据库后交给大模型分析，再根据结果分支处理"}'`
   - 返回的 `data.steps` 应包含 database_query / condition 等节点（证明 LLM 解析生效），`estimatedComplexity` 合理
5. 不填 key 或断网时再调一次：返回 mock 计划 + 后端日志有 warn，接口 HTTP 200（降级生效）

## 六、红线

- **必须用 @langchain/openai 的 ChatOpenAI + withStructuredOutput，禁止手写 fetch 调 LLM**
- 不装 langgraph（下一步再用）
- 不把 key 写进任何代码文件或 .env.example（.env 已 gitignore，注意别误提交）
- 不改 `workflow.controller.ts` 路由
- `packages/shared`、`packages/workflow-schema` 不允许改（类型已够用）
- 完成后贴 typecheck / build 输出 + 一次成功规划的真实响应（key 打码）

## 七、后续预告（本轮不做，只留口子）

- WorkflowPlanner / WorkflowGenerator / WorkflowRepairer 三个类已经独立，下一步用 **LangGraph StateGraph** 把它们编排成完整 agent 状态机（plan → sketch → generate → repair 循环），并加记忆与人工确认节点
