# Qoder 任务：前端接入 /workflow/run 全链路 + 修复 generator 重复调用

> 项目：`/Users/huzhiwu/workspace/ai-tools-demo/src/agent-coze-workflow`
> 技术栈：React 18 + Vite 5 + NestJS 11 + LangGraph（后端已就绪）
> 原则：**最小改动、不加新依赖、不改后端接口返回结构**

---

## 一、背景

后端已完成 LangGraph 编排（`POST /workflow/run`），一次调用返回完整 state：

```json
{
  "success": true,
  "data": {
    "requirement": { "description": "..." },
    "plan": { "name": "...", "steps": [...], "estimatedComplexity": "..." },
    "sketch": { "name": "...", "nodes": [...], "edges": [...] },
    "workflow": { "meta": {...}, "nodes": [...], "edges": [...], "_temp": {...} },
    "validation": { "valid": true, "errors": [], "warnings": [] },
    "errors": [],
    "repairCount": 0,
    "durationMs": 2827,
    "startedAt": "..."
  }
}
```

**但目前前端 `handleGenerate` 还是分四次调用 plan → sketch → generate → validate**（`apps/web/src/api/workflow.ts` + `apps/web/src/App.tsx`），没有用 run 接口，也没有展示修复过程。

**同时发现后端小问题**：`apps/api/src/agents/graph.ts` 里 `sketch_node` 和 `generate_node` 都调用了 `generator.generate(plan)`，生成节点被计算了两遍（虽然返回正确，但浪费计算且逻辑不清）。

## 二、任务清单

### 任务 1：修复 generator 重复调用（后端小重构）

`apps/api/src/agents/workflow-generator.ts`：

- 把 `generate(plan)` 拆成两个方法：
  - `generateSketch(plan): WorkflowSketch` — 只构建草图
  - `generateWorkflow(plan): CozeWorkflow` — 只构建最终工作流
  - 原 `generate(plan)` 保留为组合调用（`return { sketch: this.generateSketch(plan), workflow: this.generateWorkflow(plan) }`），避免破坏其他调用方
- `apps/api/src/agents/graph.ts` 对应修改：
  - `sketch_node` 调 `generator.generateSketch(state.plan)`
  - `generate_node` 调 `generator.generateWorkflow(state.plan)`

### 任务 2：前端接 /workflow/run

**`apps/web/src/api/workflow.ts`：**

- 新增 `run(description: string)` 方法，POST `/workflow/run`，body `{ description }`
- 定义返回值类型 `WorkflowRunResult`（对齐后端 state 结构，字段与上文 JSON 一致；`workflow` 复用现有 `CozeWorkflow` 类型，`plan`/`sketch`/`validation` 复用 shared 类型）
- **不要删除**现有 plan/sketch/generate/validate 方法（后续教学调试还要用）

**`apps/web/src/App.tsx`：**

- `handleGenerate` 改为**单次调用 `workflowApi.run(description)`**
- 拿到 state 后：
  - `setSketch(state.sketch)`、`setWorkflow(state.workflow)`、`setValidation(state.validation)`（现有三个展示组件不用动）
  - 日志生成（沿用现有 addLog，按顺序推）：
    1. `收到需求: ...`
    2. `Plan: 规划完成，共 N 个步骤（complexity）`
    3. `Sketch: 草图完成，共 N 个节点`
    4. `Generate: 生成完成，共 N 个节点、M 条连线`
    5. `Validate: 校验通过` / `校验失败，N 个错误`
    6. 若 `repairCount > 0`：推 `Repair: 自动修复了 N 次`（error 级别）
    7. 若 `state.errors` 非空：每条推 error 级别日志
    8. 最后推 `完成: 总耗时 Xms`（success）
- loading / 错误处理逻辑保持不变（try/catch + finally）

**`apps/web/src/components/RunLogPanel.tsx`：**

- 不需要改结构；如果日志里要展示修复过程，用现有 level 样式即可（`log-error` 红色已存在）
- 可选：新增一个 `log-repair` 样式（黄色），在 `styles/global.css` 加（参考现有 `log-success` 写法）

### 任务 3：验收（必须亲自跑通）

1. `pnpm typecheck` 全绿（注意 web 的 `WorkflowRunResult` 类型定义要严格对齐后端返回）
2. `pnpm build` 全绿
3. 启动后端 + 前端（`pnpm dev`），浏览器：
   - 输入示例需求 → 点「生成工作流」
   - 右侧出现真实 JSON + 校验结果 + 日志含 总耗时
   - 断网或后端未启动时：按钮报错日志，页面不白屏
4. `curl -X POST http://localhost:3000/workflow/run -H 'Content-Type: application/json' -d '{"description":"查数据库然后分支处理"}'` 响应正常（确认后端重构没破坏 run）

## 三、红线

- 不加新依赖（axios/zustand 都不许）
- 不改后端接口返回结构（run 的 state 字段名保持原样）
- 不删 `api/workflow.ts` 现有 4 个方法
- `packages/shared` / `packages/workflow-schema` 不允许改
- 完成后贴 typecheck / build 输出
