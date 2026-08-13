# Qoder 任务：实现 CozeClient 真实接入私有 Coze 平台

> 项目：`/Users/huzhiwu/workspace/ai-tools-demo/src/agent-coze-workflow`
> 技术栈：NestJS 11 + 原生 fetch（不引 axios）
> 平台：coze.dev1.dachensky.com（私有 Coze Studio 部署）
> 原则：**接口参数已全部实测确认（见下文），不要猜测；认证用 cookie（PAT 不被接受）**

---

## 一、背景：已实测的完整链路（2026-08-12 验证通过）

```
create → edit_lock(acquire) → canvas → save（循环）→ test_run
```

- `create` 建骨架 → `edit_lock` 建立编辑会话（15 分钟锁，**没有它会报 777777759**）→ `canvas` 拿最新 schema + submit_commit_id → `save` 提交（**每次 save 前必须重新 canvas 拿最新 commit**，因为 save 成功会推进 commit）→ `test_run` 试运行
- 骨架文件已存在：`apps/api/src/mcp/cozeClient.ts`（空壳）、`apps/api/src/mcp/mcp.module.ts`（空壳）、`apps/api/src/mcp/types.ts`
- 完整接口文档见 `coze-workflow-agent-technical-plan.md` 第 2 章

## 二、接口契约（实测准确版）

所有接口 `POST {BASE}/api/workflow_api/*`，BASE = `https://coze.dev1.dachensky.com`，认证头 `Cookie: session_key=xxx`

| 接口 | body | 返回 |
|---|---|---|
| `create` | `{name, desc, icon_uri(必填可空串), space_id(字符串!), flow_mode(数字2), }` | `data.workflow_id` |
| `edit_lock` | `{workflow_id, space_id, action:"acquire"}` | `data.config_ttl=900, remaining_ttl=900` |
| `canvas` | `{workflow_id, space_id}` | `data.workflow.schema_json`(字符串) + `data.vcs_data.submit_commit_id` |
| `save` | `{workflow_id, schema(JSON字符串), space_id, submit_commit_id, ignore_status_transfer:true}` | `code:0` 成功 |
| `test_run` | `{workflow_id, input, space_id}` | `data.execute_id` |
| `update_meta` | `{workflow_id, space_id, name(字母数字下划线且字母开头), desc, icon_uri}` | `code:0` |
| `workflow_list` | `{space_id, page, size}` | `data.workflow_list[]` |

错误码：`777777759` = 不是最新副本（commit 过期或没拿锁）；`108000001/108000002` = 权限；业务执行错误（如 `database info required`）说明工作流配置不完整。

## 三、任务清单

### 任务 1：实现 CozeClient（`apps/api/src/mcp/cozeClient.ts`）

类 `CozeClient`，构造参数 `{ baseUrl, sessionKey, spaceId }`（从 `process.env` 读，见任务 3）：

- 私有方法 `request<T>(path, body)`：原生 fetch POST，带 `Cookie` + `Agw-Js-Conv: str` + `Content-Type: application/json` + `x-requested-with: XMLHttpRequest`，10s 超时；响应 `code !== 0` 时抛错（带 code/msg）
- `createWorkflow(name, desc): Promise<string>` → 返回 workflow_id
- `acquireEditLock(workflowId): Promise<number>` → 调 edit_lock acquire，返回 remaining_ttl；**类内维护 `lockExpireAt`，save 前若锁已过期自动重新 acquire**
- `getSchema(workflowId): Promise<{ schemaJson: string; submitCommitId: string }>` → editLock(若需) + canvas
- `saveWorkflow(workflowId, schemaJson): Promise<void>` → 内部：getSchema 拿最新 commit → save；**若返回 777777759，自动重试：重新 edit_lock + getSchema + save，最多 2 次**
- `testRun(workflowId, input): Promise<string>` → 返回 execute_id
- `updateMeta(workflowId, name, desc): Promise<void>`
- `listWorkflows(page=1, size=20): Promise<unknown[]>` → 返回 workflow_list
- 所有方法错误统一包成 `Error("CozeError[code]: msg")`

### 任务 2：Schema 转换器（`apps/api/src/mcp/schema-converter.ts`）

把项目 `workflow-schema` 包的 `CozeWorkflow`（公开 Coze 格式：meta/nodes/edges）转成**平台内部格式**：

- 平台节点：`{id: "100001", type: "1", meta: {position}, data: {nodeMeta: {title, icon, description, mainColor, subTitle}, ...}, _temp: {bounds, externalData}}`
- type 映射（字符串数字）：start=1、end=2、llm=??（待定，用 node_template_list 查询或先映射 43 相邻值，**代码里留 TODO 注释让下一步实测**）、code=??、condition=??、database_query=43（已确认）、http=??；**本任务至少保证 start/end/database_query 三个映射正确，其他类型先在代码里注释 TODO**
- 引用语法：`{type:"ref", content:{source:"block-output", blockID, name}}`，start 节点 id 固定 `100001`、end 固定 `900001`，节点间数据引用 blockID 指向上游节点 id
- edges 转平台格式：`{sourceNodeID, targetNodeID}`（大写）；顶层加 `versions: {loop: "v2"}`
- `_temp.bounds` 按画布坐标生成（x 递增 200）
- 输出：平台格式的 **JSON 字符串**（save 的 schema 参数要求字符串）

函数签名：`convertToPlatformSchema(workflow: CozeWorkflow): string`

### 任务 3：装配 + 环境变量

- `apps/api/src/mcp/mcp.module.ts`：注册 `CozeClient` 为 Provider（useFactory 从 `process.env` 读配置），exports 导出
- `apps/api/src/workflow/workflow.module.ts` / `app.module.ts`：imports 接入 McpModule
- 环境变量（根目录 `.env`，已 gitignore；**key 值由用户填写，Qoder 只加字段名**）：
  ```
  COZE_API_BASE_URL=https://coze.dev1.dachensky.com
  COZE_SPACE_ID=7560621359533916160
  COZE_SESSION_KEY=
  ```
- `.env.example` 同步加这三个字段

### 任务 4：后端接口接真实调用（`apps/api/src/workflow/workflow.service.ts`）

- 构造函数注入 `CozeClient`
- `create()`：改为真实创建——`cozeClient.createWorkflow(schema.meta.name, schema.meta.description)` + `saveWorkflow` 首次保存（内部自动 edit_lock+canvas+save），返回 `{workflowId, status:"created", saved:true}`
- `save()`：改为 `cozeClient.saveWorkflow(body.workflowId, convertToPlatformSchema(schema))`
- `testRun()`：改为 `cozeClient.testRun(body.workflowId, body.inputData)`
- **保留原 mock 实现代码为降级分支**：CozeClient 调用失败（如未配置 COZE_SESSION_KEY）时 `console.warn` + 返回 mock 结果，接口不挂
- `validate()` / `plan()` / `run()` 不动

## 四、验收（必须亲自跑通）

1. `pnpm typecheck` / `pnpm build` 全绿
2. 用户配置 `COZE_SESSION_KEY` 后（找用户要，或提示用户填写）：
   - `curl -X POST localhost:3000/workflow/create -H 'Content-Type: application/json' -d '{"meta":{"name":"qoder_test","description":"测试","version":"1.0.0"},"nodes":[{"id":"100001","type":"start","title":"开始","desc":"","_temp":{}}],"edges":[]}'` → 返回真实 workflowId
   - 用返回的 workflowId 调 `test-run` → 返回 execute_id
3. 不配置 key 时调 create → 返回 mock 降级结果 + 后端日志有 warn
4. 贴 typecheck / build 输出 + 一次真实 create 的响应（workflowId 打码）

## 五、红线

- **不要提交 / 打印 / 硬编码 COZE_SESSION_KEY 值**（.env 已 gitignore）
- 不新增第三方依赖（原生 fetch）
- 不改 `packages/shared` / `packages/workflow-schema` 的现有导出（转换器放 api 包内）
- 不改 `/workflow/plan`、`/workflow/generate`、`/workflow/validate`、`/workflow/run` 现有行为
- 接口参数严格按本文档，不要猜测（都实测过）
