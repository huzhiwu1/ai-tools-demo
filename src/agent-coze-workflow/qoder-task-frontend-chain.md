# Qoder 任务：前端接入真实链路 + 落地 LLM prompt 常量

> 项目：`/Users/huzhiwu/workspace/ai-tools-demo/src/agent-coze-workflow`
> 技术栈：React 18 + Vite 5 + NestJS + Turborepo（monorepo，pnpm workspace）
> 要求：**最小改动，只做任务清单里的事，不重构、不加新依赖（axios/zustand/react-query 都不许装）**

---

## 一、项目现状（先读这些文件再动手）

- `apps/web/src/App.tsx` — 三栏布局（左输入 / 中画布 / 右输出），组件之间目前没有状态传递，全是各组件内部 mock 数据
- `apps/web/src/components/InputPanel.tsx` — 需求输入框 + 示例按钮，**生成按钮目前 disabled**
- `apps/web/src/components/JsonPreview.tsx` — 展示写死的 MOCK_WORKFLOW_JSON
- `apps/web/src/components/RunLogPanel.tsx` — 展示写死的 MOCK_LOGS
- `apps/web/src/components/WorkflowCanvas.tsx` — 中间画布（看一下现状，按需展示草图节点）
- `apps/api/src/workflow/workflow.controller.ts` — 后端已就绪的真实接口（mock 实现），路由**没有 /api 前缀**
- `apps/api/src/workflow/workflow.service.ts` — mock 业务实现，已能返回结构正确的数据
- `packages/shared/src/types/index.ts` — 共享类型：`ApiResponse<T>`、`WorkflowPlan`、`WorkflowSketch`、`ValidationResult` 等
- `apps/api/src/main.ts` — **已开启 CORS**，监听 3000 端口
- `apps/web/vite.config.ts` — proxy 只配了 `/api` 和 `/health`，但后端路由没有 `/api` 前缀，**前端请直接 fetch `http://localhost:3000`，不要走 /api 前缀（会 404）**

## 二、后端接口签名（已就绪，勿改后端逻辑）

统一返回包装 `ApiResponse<T>`：`{ success: boolean; data?: T; error?: string; timestamp: string }`

| 方法 | 路径 | 请求体 | 返回 data |
|---|---|---|---|
| POST | `/workflow/plan` | `{ description: string; constraints?: string[] }` | `WorkflowPlan` |
| POST | `/workflow/sketch` | `{ description: string; constraints?: string[] }` | `WorkflowSketch` |
| POST | `/workflow/generate` | `WorkflowPlan` | `CozeWorkflow`（含 meta/nodes/edges/_temp） |
| POST | `/workflow/validate` | `CozeWorkflow`（对象，不是字符串） | `ValidationResult`（`{ valid, errors[], warnings[] }`） |

> 注意：`generate` 的入参是 `plan` 接口的返回对象（整个 WorkflowPlan），直接透传。

## 三、任务清单

### 任务 1：web 包接入 shared 包

`apps/web/package.json` 的 dependencies 目前只有 react / react-dom，**没有 @coze-workflow/shared**。

- 用 pnpm 添加 workspace 依赖：`pnpm --filter @coze-workflow/web add @coze-workflow/shared@workspace:*`
- 完成后确认 `apps/web/src` 里可以 `import { WorkflowPlan } from "@coze-workflow/shared"` 这类类型导入

### 任务 2：落地 LLM prompt 常量文件（内容已设计好，照抄即可）

新建目录 `apps/api/src/prompts/`，创建 5 个文件 + 1 个汇总导出（**内容必须逐字保留，不要改写**）：

**`system-prompt.ts`**
```ts
export const SYSTEM_PROMPT = `你是一个企业内部 Coze 工作流工程 agent。
你的任务是根据用户需求生成可执行的 Coze 工作流。

必须遵守：
1. 优先保证可执行性，不追求花哨。
2. 先规划草图，再输出最终 JSON。
3. 只输出严格可解析的 JSON，不要夹带解释文本。
4. 不允许编造平台未知字段。
5. 生成时优先使用已有模板，不要从零乱造。
6. 修复时只做最小修改，不要重写整张图。
7. 代码节点出边不要写 sourcePortID。
8. 节点输出类型必须与实际返回一致。
9. 节点 ID 必须唯一，边必须引用真实存在的节点。
10. 节点数量尽量少。`;
```

**`plan-prompt.ts`**
```ts
export const PLAN_PROMPT = `你是 Coze 工作流需求分析器。
请把用户输入的需求转成结构化 JSON。
要求：只输出 JSON，不要解释。
字段包括：mode、goal、inputType、outputType、needBranch、needCodeNode、needDatabaseNode、constraints、riskHints。`;
```

**`sketch-prompt.ts`**
```ts
export const SKETCH_PROMPT = `你是 Coze 工作流规划器。
根据结构化需求，输出工作流草图。
要求：只输出 JSON，包含 nodes 和 edges。
不要输出最终 Coze schema。`;
```

**`generate-prompt.ts`**
```ts
export const GENERATE_PROMPT = `你是 Coze 工作流 JSON 生成器。
根据工作流草图，输出可保存的 Coze 节点 JSON。
要求：
1. 只输出 JSON。
2. 节点 ID 唯一。
3. 边必须连接真实存在的节点。
4. 代码节点出边不要写 sourcePortID。
5. 输出字段类型必须与节点声明一致。
6. 优先使用已有模板，减少节点数量。`;
```

**`repair-prompt.ts`**
```ts
export const REPAIR_PROMPT = `你是 Coze 工作流修复器。
根据原始工作流 JSON 和错误信息，生成最小修改 patch。
要求：
- 只修复出错部分。
- 不要重写整张图。
- 优先保留已有正确结构。
- 错误节点要引用最终处理后的数据。
- 修复后如果仍缺信息，先列出缺失项。`;
```

**`index.ts`**
```ts
export * from "./system-prompt";
export * from "./plan-prompt";
export * from "./sketch-prompt";
export * from "./generate-prompt";
export * from "./repair-prompt";
```

> 这 5 个常量暂时不被业务代码引用（下一步接 LLM 时才用），只要求文件存在、能被编译。

### 任务 3：前端 API 封装

新建 `apps/web/src/api/workflow.ts`：

- 从 `@coze-workflow/shared` 导入类型：`ApiResponse`、`WorkflowPlan`、`WorkflowSketch`、`ValidationResult`，以及常量 `DEFAULT_API_BASE_URL`
- 封装 4 个函数，全部用原生 `fetch` + 统一错误处理：

```ts
const BASE_URL = DEFAULT_API_BASE_URL; // http://localhost:3000

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as ApiResponse<T>;
  if (!json.success) throw new Error(json.error ?? "请求失败");
  return json.data as T;
}

export const workflowApi = {
  plan: (description: string) => post<WorkflowPlan>("/workflow/plan", { description }),
  sketch: (description: string) => post<WorkflowSketch>("/workflow/sketch", { description }),
  generate: (plan: WorkflowPlan) => post<CozeWorkflow>("/workflow/generate", plan),
  validate: (workflow: CozeWorkflow) => post<ValidationResult>("/workflow/validate", workflow),
};
```

- `CozeWorkflow` 类型从哪来：优先从 `@coze-workflow/workflow-schema` 导入；如果 web 接 workflow-schema 依赖有困难，就在 `apps/web/src/api/workflow.ts` 里定义一个最小接口 `interface CozeWorkflow { meta: {...}; nodes: unknown[]; edges: unknown[]; _temp?: unknown }`（**必须与后端 generate 返回结构一致**：meta.name / meta.description / meta.version / nodes / edges / _temp）

### 任务 4：前端状态提升 + 串链路

改造 `App.tsx`（用 React 原生 `useState`，**不装状态管理库**）：

- App 里维护状态：
  - `sketch: WorkflowSketch | null`
  - `workflow: CozeWorkflow | null`
  - `validation: ValidationResult | null`
  - `logs: Array<{ time: string; level: string; msg: string }>`
  - `loading: boolean`、`error: string | null`
- App 里实现 `handleGenerate(description: string)`：
  1. 推一条日志：收到需求
  2. 调 `workflowApi.plan(description)` → 推日志：规划完成（steps 数量）
  3. 调 `workflowApi.sketch(description)` → 存 sketch → 推日志：草图完成（节点数）
  4. 调 `workflowApi.generate(plan)` → 存 workflow → 推日志：生成完成（节点数 + 边数）
  5. 调 `workflowApi.validate(workflow)` → 存 validation → 推日志：校验结果（valid ? "通过" : "失败，N 个错误"）
  6. 任一步出错：捕获，存 error，推一条 error 日志
  7. 全程 loading 置 true，结束后 false；**防止重复点击**
- `InputPanel` 接收 props：`onGenerate(description: string)`、`loading`；生成按钮启用（disabled = !description || loading），点击回调 onGenerate
- `JsonPreview` 接收 props：`workflow`、`validation`；展示 `JSON.stringify(workflow, null, 2)`，下方展示校验结果摘要（valid / errors 列表 / warnings 列表）；**workflow 为空时显示占位文案**
- `RunLogPanel` 接收 props：`logs`；按时间渲染（保留现有 className：log-entry / log-time / log-msg / log-{level}）
- `WorkflowCanvas` 接收 props：`sketch`；简单展示节点列表即可（节点 id + type + label + purpose，用现有样式），不要求拖拽连线
- 各组件改完要保持函数签名向后兼容，`App.tsx` 里统一传 props

### 任务 5：验收（必须亲自跑通）

1. `pnpm typecheck` 全绿
2. `pnpm build` 全绿
3. 启动 `pnpm dev`，浏览器打开前端：
   - 点示例需求 → 点「生成工作流」按钮
   - 右侧 JSON 面板出现**真实**返回的 CozeWorkflow JSON（不再是 MOCK 数据）
   - JSON 下方出现校验结果：valid: true
   - 日志面板出现 plan → sketch → generate → validate 四步记录
   - 按钮在请求期间是 loading 禁用状态
4. 如果后端没起来，前端要能显示错误日志（fetch 失败提示），不能白屏

## 四、红线

- 不要改后端 `workflow.controller.ts` / `workflow.service.ts` 的业务逻辑（prompts 目录除外）
- 不要新增任何第三方依赖
- 不要重写组件样式体系，沿用现有 className
- 不要动 `packages/shared` 和 `packages/workflow-schema` 的现有导出
- 完成后把 `pnpm typecheck` / `pnpm build` 的输出贴出来
