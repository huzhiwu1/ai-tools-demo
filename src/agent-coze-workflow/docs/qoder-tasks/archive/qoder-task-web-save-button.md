# Qoder 任务：前端加"保存到 Coze"按钮（方案 A）

> 项目：`/Users/huzhiwu/workspace/ai-tools-demo/src/agent-coze-workflow`
> 技术栈：React 18 + Vite 5 + NestJS
> 原则：**最小改动、不加依赖、不改后端**

---

## 一、背景

- 后端 `POST /workflow/create` **已接真实 Coze 平台**（实测返回真实 workflow_id），入参是 CozeWorkflow 对象（meta/nodes/edges），返回 `{ workflowId, status, saved, createdAt }`
- 前端目前：输入需求 → `workflowApi.run()` → 展示 plan/sketch/workflow/validation 在三个面板，**没有"保存到 Coze"入口**
- 目标：生成 + 校验通过后，用户点「保存到 Coze」→ 工作流真实创建到平台 → 前端显示 workflow_id 和平台链接

## 二、任务清单

### 任务 1：`apps/web/src/api/workflow.ts` 加 create 方法

- 新增（保留现有 plan/sketch/generate/validate/run 不动）：

```ts
export interface CozeSaveResult {
  workflowId: string;
  status: string;
  saved: boolean;
  createdAt: string;
}

/** 保存工作流到 Coze 平台 */
create: (workflow: CozeWorkflow) =>
  post<CozeSaveResult>("/workflow/create", workflow),
```

### 任务 2：`apps/web/src/App.tsx` 加保存逻辑

- 新增 state：
  - `savedResult: CozeSaveResult | null`
  - `saving: boolean`
- 新增 `handleSaveToCoze()`：
  1. `if (!workflow || saving) return;`
  2. `setSaving(true)`，调 `workflowApi.create(workflow)`
  3. 成功：`setSavedResult(res)` + 推日志 `已保存到 Coze: workflow_id=xxx`（success 级）
  4. 失败：`setError(msg)` + error 日志
  5. finally `setSaving(false)`
- **每次 handleGenerate 开始时重置 `savedResult` 为 null**（新生成的工作流需要重新保存）
- 保存按钮 UI（放在右侧面板 JsonPreview 下方或左侧面板，任选，用现有 `btn btn-primary` 类）：
  - 显示条件：`workflow 存在 && validation?.valid === true && !saving`
  - 文案：`保存到 Coze`；保存中：`保存中...`（禁用）
  - 保存成功后显示：
    - `已保存：workflow_id = {savedResult.workflowId}`
    - 平台链接（新窗口打开）：`https://coze.dev1.dachensky.com/work_flow?workflow_id={savedResult.workflowId}&space_id=7560621359533916160`（space_id 平台固定，写注释说明）
    - 链接用 `<a href target="_blank">在平台查看</a>`，样式沿用现有 hint-text/链接样式

### 任务 3：验收（必须亲自跑通）

1. `pnpm typecheck` / `pnpm build` 全绿
2. `pnpm dev` 浏览器实测：
   - 输入示例需求 → 生成 → 校验通过
   - 点「保存到 Coze」→ 出现 workflow_id + 「在平台查看」链接
   - 点链接 → Coze 平台能看到该工作流（有 start/大模型/end 节点）
   - 日志面板出现「已保存到 Coze」记录
3. 校验失败时**不显示**保存按钮（或按钮禁用）

## 三、红线

- 不新增第三方依赖
- 不改后端任何文件
- 不改 api/workflow.ts 现有方法
- space_id 前端写死 `7560621359533916160`（与 .env 的 COZE_SPACE_ID 一致，加注释）
- 完成后贴 typecheck / build 输出 + 一次真实保存的截图或 workflow_id
