# Qoder 任务：工作流名称冲突处理（新增改名工具 + save 重名兜底）

> 项目：`/Users/huzhiwu/workspace/ai-tools-demo/src/agent-coze-workflow`
> 技术栈：NestJS 11 + LangGraph createReactAgent + pnpm workspace
> **问题：保存工作流时平台报"工作流名称已存在"，但 Agent 的工具集里没有"改名"工具（CozeClient.updateMeta 方法早已存在，只是没暴露给 Agent），导致 Agent 只能瞎转（错误地尝试用 update_workflow 改节点）。**

---

## 一、问题确认

1. **CozeClient 已有改名方法**（apps/api/src/coze/coze.client.ts:172）：
   ```ts
   async updateMeta(workflowId, name, desc)  // 调 POST /api/workflow_api/update_meta
   ```
   平台接口：`{"workflow_id":"...","space_id":"...","name":"新名称","desc":"...","icon_uri":""}`，**name 只允许字母数字下划线且字母开头**

2. **Agent 工具集没有改名工具**：ALL_TOOLS 里没有封装 updateMeta 的工具 → Agent 不知道能改名

3. **save_to_coze 遇重名**：createWorkflow 报"工作流名称已存在"（错误码/msg 含"已存在"或类似）→ Agent 无计可施

---

## 二、修复方案

### 1. 新增工具 rename_workflow（apps/api/src/agent/tools/rename-workflow.tool.ts）

```ts
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { cozeClient } from "./coze-client";

export const renameWorkflowTool = tool(
  async ({ workflowId, name, desc }) => {
    try {
      // 名称 sanitize：字母开头 + 字母数字下划线（平台约束）
      const cleanName = name.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^[^a-zA-Z]+/, "").slice(0, 50) || "workflow";
      await cozeClient.updateMeta(workflowId, cleanName, desc ?? "");
      return JSON.stringify({ workflowId, renamed: true, name: cleanName }, null, 2);
    } catch (e) {
      return `改名失败: ${(e as Error).message}`;
    }
  },
  {
    name: "rename_workflow",
    description:
      "修改已创建工作流的名称/描述（不走 save，不影响工作流内容）。" +
      "当保存时提示'工作流名称已存在'时，用本工具改成新名称后重新保存；" +
      "名称只允许字母数字下划线且以字母开头。",
    schema: z.object({
      workflowId: z.string().describe("已存在的工作流 ID"),
      name: z.string().describe("新名称（自动清洗为字母开头+字母数字下划线）"),
      desc: z.string().optional().describe("新描述（可选）"),
    }),
  },
);
```

注册到 `tools/index.ts` 的 ALL_TOOLS。

### 2. save_to_coze 名称冲突兜底（apps/api/src/agent/tools/save.tool.ts）

**方案**：save_to_coze 创建时若报"名称已存在"，自动生成唯一名称重试（最多 3 次，加 `_2`、`_3` 后缀），避免把冲突抛给 Agent 处理：

```ts
// save_to_coze 内 createWorkflow 前：
let workflowId: string;
try {
  workflowId = await cozeClient.createWorkflow(name, desc);
} catch (e) {
  const msg = (e as Error).message;
  // 名称冲突：自动加后缀重试（_2, _3）
  if (/已存在|exist|duplicate/i.test(msg)) {
    let unique = "";
    for (let i = 2; i <= 4; i++) {
      const candidate = `${sanitizeName(name)}_${i}`.slice(0, 50);
      try {
        workflowId = await cozeClient.createWorkflow(candidate, desc);
        unique = candidate;
        break;
      } catch (e2) {
        const m2 = (e2 as Error).message;
        if (!/已存在|exist|duplicate/i.test(m2)) throw e2; // 非重名错误直接抛
      }
    }
    if (!workflowId) return `保存失败: 工作流名称冲突且自动重试失败，请用 rename_workflow 改名后重试`;
    console.warn(`[save_to_coze] 名称冲突，使用 ${unique} 保存`);
  } else {
    throw e;
  }
}
```

> 说明：重名自动加后缀是兜底；如果 Agent 明确想保留特定名称，可用 rename_workflow 先改已存在的工作流再保存。

### 3. SYSTEM_PROMPT 使用规则补充（react-agent.service.ts）

```
- save_to_coze 提示"工作流名称已存在"时：
  工具会自动加后缀重试；若仍需指定名称，用 rename_workflow 改名后重新保存
- rename_workflow 只改名称/描述，不影响工作流内容
```

---

## 三、验收标准

1. `pnpm typecheck` 全绿；`pnpm build` 全绿
2. **重名自动兜底**：连续保存两个同名工作流，第二个自动以 `_2` 后缀保存成功（不报错）
3. **rename_workflow 可用**：给 Agent 指令"把工作流 xxx 改名为 yyy"，工具返回 renamed:true，平台上名称变化
4. Agent 不再因名称冲突死循环（save → 重名 → 瞎转）

---

## 四、红线

- ❌ 不改平台 API 调用（updateMeta 已有，直接用）
- ❌ 不加新依赖
- ✅ 只改：新增 rename-workflow.tool.ts + save.tool.ts 重名兜底 + SYSTEM_PROMPT 规则
