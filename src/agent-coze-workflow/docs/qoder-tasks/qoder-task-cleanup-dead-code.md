# Qoder 任务：死代码清理（schema/ + validator/ + agents/index.ts）

> 项目：`/Users/huzhiwu/workspace/ai-tools-demo/src/agent-coze-workflow`
> 技术栈：NestJS 11 + pnpm workspace
> **目标：删除零引用的死代码文件，精简项目结构。只删文件，不改任何业务逻辑。**

---

## 一、背景

Review 发现以下文件**从未被任何代码引用**（grep 全项目确认）：
- `apps/api/src/schema/` 目录（nodeTemplates.ts、workflowSchema.ts）—— TODO 空壳
- `apps/api/src/validator/` 目录（validateWorkflow.ts）—— TODO 空壳
- `apps/api/src/agents/index.ts` —— 无外部 import 引用

删除它们不影响任何功能，只让项目更干净。

**注意**：这些"空壳"里有些是从项目早期就存在的 TODO 占位，校验逻辑实际已由 `@coze-workflow/workflow-schema` 包提供（见 generate.tool.ts 的 import），所以删掉完全安全。

---

## 二、任务

1. 删除以下文件/目录：
   - `apps/api/src/schema/nodeTemplates.ts`
   - `apps/api/src/schema/workflowSchema.ts`
   - `apps/api/src/schema/`（目录清空后删除）
   - `apps/api/src/validator/validateWorkflow.ts`
   - `apps/api/src/validator/`（目录清空后删除）
   - `apps/api/src/agents/index.ts`

2. **删除前先自查**（防止误删被引用的文件）：
   ```bash
   grep -rn "schema/nodeTemplates\|schema/workflowSchema\|validator/validateWorkflow\|from \"../agents\"\|from \"./agents\"" apps/api/src --include="*.ts"
   ```
   确认无引用后再删。

3. 删除后验证：
   - `pnpm typecheck` 全绿
   - `pnpm build` 全绿
   - `pnpm --filter @coze-workflow/api dev` 启动无报错（可选）

---

## 三、红线

- ❌ 不动 `apps/api/src/agent/`（新链路，一个文件都不碰）
- ❌ 不动 `apps/api/src/agents/` 下的其他文件（graph.ts / workflow-planner.ts / workflow-generator.ts / workflow-repairer.ts / agents.module.ts / types.ts 都有引用）
- ❌ 不动 `apps/api/src/llm/`、`apps/api/src/mcp/`
- ❌ 不加新依赖、不改配置
- ✅ 只删除上述 3 处死代码

---

## 四、验收

1. `pnpm typecheck` 全绿
2. `pnpm build` 全绿
3. `apps/api/src/` 下不再有 `schema/` 和 `validator/` 目录
4. 后端启动后 `/workflow/run`、`/api/agent/chat` 等接口正常（冒烟测试）
