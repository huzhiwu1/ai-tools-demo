# Qoder 任务：死代码清理收尾（上次删得不干净，补删 5 处残留）

> 项目：`/Users/huzhiwu/workspace/ai-tools-demo/src/agent-coze-workflow`
> 技术栈：NestJS 11 + pnpm workspace
> **背景：上次死代码清理只删了 agents/index.ts，还有 5 处残留没删。本次补删干净。**

---

## 一、残留清单（已确认零引用，纯死代码）

```
1. apps/api/src/schema/nodeTemplates.ts     ← TODO 空壳
2. apps/api/src/schema/workflowSchema.ts    ← TODO 空壳
3. apps/api/src/validator/validateWorkflow.ts ← TODO 空壳
4. apps/api/src/routes/                      ← 空目录
5. apps/api/src/services/                     ← 空目录
```

**已确认**：`grep` 全项目扫描，无任何代码 import 这三个文件（校验逻辑实际由 `@coze-workflow/workflow-schema` 包提供）。

---

## 二、任务

1. 删除以下文件：
   - `apps/api/src/schema/nodeTemplates.ts`
   - `apps/api/src/schema/workflowSchema.ts`
   - `apps/api/src/validator/validateWorkflow.ts`

2. 删除空目录（目录内文件删空后）：
   - `apps/api/src/schema/`
   - `apps/api/src/validator/`
   - `apps/api/src/routes/`
   - `apps/api/src/services/`

3. 删除前自查（防止误删被引用的文件）：
   ```bash
   grep -rn "nodeTemplates\|workflowSchema\|validateWorkflow\|src/schema\|src/validator\|src/routes\|src/services" apps/api/src --include="*.ts"
   ```
   确认无引用后再删（输出为空即安全）。

4. 删除后验证：
   - `pnpm typecheck` 全绿
   - `pnpm build` 全绿
   - 后端启动无报错（`pnpm --filter @coze-workflow/api dev`）

---

## 三、红线

- ❌ 不动 `apps/api/src/agent/`、`coze/`、`workflow-engine/`、`legacy/`、`llm/`、`prompts/` 下的任何文件
- ❌ 不动 `@coze-workflow/workflow-schema` 包（那是活代码）
- ❌ 不加新依赖、不改配置
- ✅ 只删除上述 5 处残留

---

## 四、验收

1. `pnpm typecheck` 全绿
2. `pnpm build` 全绿
3. `apps/api/src/` 下不再有 `schema/`、`validator/`、`routes/`、`services/` 目录
4. 后端启动后 `/health`、`/api/agent/chat` 正常
