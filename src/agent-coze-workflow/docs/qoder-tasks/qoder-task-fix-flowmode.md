# Qoder 任务：修复工作流创建类型错误（flow_mode 2 → 0）

> 项目：`/Users/huzhiwu/workspace/ai-tools-demo/src/agent-coze-workflow`
> 技术栈：NestJS 11 + pnpm workspace
> **问题：创建的工作流点击打开报"无法查看智能体"——因为 createWorkflow 用了 `flow_mode: 2`，创建出来的是"智能体"而不是"工作流"。真实工作流样本（docs/coze-platform/*.json）的 flowMode 都是 0。**

---

## 一、问题确认（已实测）

1. **真实工作流样本**（用户平台里正常可用的工作流）：
   - `docs/coze-platform/coze-clipboard-node-sample.json` → `source.flowMode: 0`
   - `docs/coze-platform/health-workflow-103-nosnack-sample.json` → `source.flowMode: 0`

2. **当前代码**：`apps/api/src/coze/coze.client.ts` 的 `createWorkflow()` 传 `flow_mode: 2`

3. **现象**：`flow_mode: 2` 创建出来的资源类型是"智能体"（agent），前端跳转 `/work_flow?workflow_id=xxx` 时平台按工作流加载失败，提示"无法查看智能体，请检查你的网址或加入对应工作空间后重试"。

---

## 二、修复（两个参数一起改）

### 文件：apps/api/src/coze/coze.client.ts

`createWorkflow()` 中两处修正（对照用户手工创建成功的 curl 实测确认）：

```ts
async createWorkflow(name: string, desc: string): Promise<string> {
  const res = await this.request<CreateWorkflowData>("create", {
    name,
    desc,
    icon_uri: "default_icon/default_workflow_icon.png", // 必须传默认工作流图标，空字符串会导致创建的资源不完整、无法打开
    space_id: this.spaceId,
    flow_mode: 0,  // 0=工作流（样本实测）；2=智能体（会导致打开报"无法查看智能体"）
  });
  return res.data.workflow_id;
}
```

**两个参数都要改（缺一不可）：**

| 参数 | 当前值（错误） | 正确值 | 后果 |
|---|---|---|---|
| `icon_uri` | `""`（空） | `"default_icon/default_workflow_icon.png"` | 空图标导致资源不完整、workflow_detail 报 Go panic（ParseInt 空字符串）、无法打开 |
| `flow_mode` | `2` | `0` | flow_mode=2 创建的是智能体，打开报"无法查看智能体" |

### 连带检查（顺手确认，不用改除非发现错误）

- `apps/api/src/coze/types.ts` 的 `CreateWorkflowRequest`：`icon_uri` 注释补充"必须传 default_icon/default_workflow_icon.png，勿传空"；`flow_mode` 注释补充"0=工作流，2=智能体（勿用）"
- 若平台其他接口（如 update_meta / canvas / save）涉及 icon_uri / flow_mode 参数，一并确认与手工 curl 一致

---

## 三、验收标准

1. `pnpm typecheck` 全绿；`pnpm build` 全绿
2. **创建后能打开**：用 Agent 或 curl 创建一个工作流 → 保存 → 复制前端跳转链接 `https://coze.dev1.dachensky.com/work_flow?workflow_id=xxx&space_id=7560621359533916160` → 浏览器打开正常显示工作流编辑器（不再报"无法查看智能体"）
3. 保存链路不回归：create → edit_lock → canvas → save 仍正常（code=0）

---

## 四、红线

- ❌ 不改其他业务逻辑（只改 flow_mode 参数）
- ❌ 不加新依赖
- ✅ 只动 `coze.client.ts` 一处 + `types.ts` 注释
