# Qoder 任务：Sprint A 小修复（tool_end 输出解析 + CozeClient 共享单例）

> 项目：`/Users/huzhiwu/workspace/ai-tools-demo/src/agent-coze-workflow`
> 技术栈：NestJS 11 + LangGraph + pnpm workspace
> **两个小修复，都是 review 时发现的问题，改完 typecheck/build 全绿即可。**

---

## 一、项目现状（先读这些文件）

- `apps/api/src/agent/react-agent.service.ts` — SSE 事件流处理，`streamAgentEvents()` 里 `on_tool_end` 分支把 `event.data.output` 原样发给前端
- `apps/api/src/agent/tools/save.tool.ts` — 模块顶层 new 了一个 CozeClient
- `apps/api/src/agent/tools/test-run.tool.ts` — 模块顶层又 new 了一个 CozeClient（两个实例各自管理编辑锁状态）

---

## 二、修复 1：tool_end 的 output 改为纯文本

**问题**：现在 `on_tool_end` 发送的 output 是 LangChain 内部序列化格式：

```json
{"lc":1,"type":"constructor","id":["langchain_core","messages","ToolMessage"],"kwargs":{"status":"success","content":"..."}}
```

前端要展示工具结果很难解析，应该只发 `kwargs.content`（纯文本/JSON 字符串）。

**改法**（`react-agent.service.ts` 的 `on_tool_end` 分支）：

```ts
case "on_tool_end": {
  const toolName = event.name ?? "unknown";
  // 提取 ToolMessage 的 kwargs.content（纯文本），而不是发整个序列化对象
  const output = event.data?.output;
  const content =
    typeof output === "object" &&
    output !== null &&
    "kwargs" in output &&
    typeof (output as Record<string, unknown>).kwargs === "object" &&
    (output as Record<string, unknown>).kwargs !== null
      ? String(
          ((output as Record<string, unknown>).kwargs as Record<string, unknown>)
            .content ?? "",
        )
      : typeof output === "string"
        ? output
        : JSON.stringify(output ?? "");
  res.write(
    `event: tool_end\ndata: ${JSON.stringify({ name: toolName, output: content })}\n\n`,
  );
  break;
}
```

**要求**：
- 保留 `on_tool_start` 不变（input 已经是可读 JSON）
- `on_tool_end` 后前端收到的 `output` 必须是纯字符串（如 `{"workflowId":"...","saved":true}` 的 JSON 字符串，或"保存失败: xxx"）

---

## 三、修复 2：CozeClient 共享单例

**问题**：`save.tool.ts` 和 `test-run.tool.ts` 各自 `new CozeClient(...)`，两个实例各自管理编辑锁（lockExpireAt）和配置，一旦 .env 配置改了要改两处。

**改法**：新建 `apps/api/src/agent/tools/coze-client.ts`：

```ts
// apps/api/src/agent/tools/coze-client.ts
/**
 * 共享 CozeClient 单例
 *
 * save.tool.ts / test-run.tool.ts 共用同一实例，
 * 编辑锁状态统一管理，配置只写一处。
 */
import { CozeClient } from "../../mcp/cozeClient";

export const cozeClient = new CozeClient({
  baseUrl: process.env.COZE_API_BASE_URL ?? "",
  sessionKey: process.env.COZE_SESSION_KEY ?? "",
  spaceId: process.env.COZE_SPACE_ID ?? "",
});
```

然后：
- `save.tool.ts`：删掉本地 `const cozeClient = new CozeClient(...)`，改为 `import { cozeClient } from "./coze-client";`
- `test-run.tool.ts`：同样改为 import 共享单例
- 注释同步更新（说明是共享单例）

---

## 四、验收标准

1. `pnpm typecheck` 全绿
2. `pnpm build` 全绿
3. 手工验证（可选）：起服务后发一个触发工具调用的需求，curl SSE 流里 `event: tool_end` 的 `data.output` 是纯字符串，不再是 `{"lc":1,...}` 序列化对象
4. 不改变任何工具行为（save/test_run 逻辑不动）

---

## 五、红线

- ❌ 不改 `react-agent.service.ts` 的其他逻辑（只动 on_tool_end 分支）
- ❌ 不加新依赖
- ❌ 不改 .env / 凭证
- ❌ 不动前端
