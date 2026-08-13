# Qoder 任务：修复工具调用链误判失败（"失败"字样误报）

> 项目：`/Users/huzhiwu/workspace/ai-tools-demo/src/agent-coze-workflow`
> 技术栈：React 18 + Vite + NestJS
> **问题：工具调用链面板把成功的工具调用标成 ✗ 失败——因为前端用 `output.includes("失败")` 判断失败，而工具正常输出的 JSON 里包含业务语义的"失败"字样（如"识别失败输出未知歌曲"）。工具实际成功（后端日志显示 ok），前端误报。**

---

## 一、问题定位（已确认）

前端两处误判逻辑：

**apps/web/src/components/chat-message-list.tsx:40**
```ts
const failed = (event.output ?? "").includes("失败");
```

**apps/web/src/App.tsx:238**
```ts
const failed = output.includes("失败");
```

**触发场景**：需求描述含"识别失败输出未知歌曲"，plan_workflow / generate_workflow 的输出 JSON（description 字段）里正常包含"失败"二字 → 前端标红。

**后端工具约定**（判断依据）：
- 工具**成功**：返回 JSON 字符串（以 `{` 开头，如 `{"workflow":...}`）
- 工具**失败**：返回错误文本，格式为 `"<工具名>失败: <原因>"`（如 `"规划失败: xxx"`、`"保存失败: CozeError[...]"`、`"批量验证失败: xxx"`）

---

## 二、修复方案

### 原则：不靠"包含失败"判断，靠"输出格式 + 错误前缀"判断

工具成功返回的是 **JSON**（`{` 开头），失败返回的是 **错误文本**（"xxx失败: " 开头）。用这个特征区分。

### 1. 新增共享判断函数（apps/web/src/api/data-stream.ts 或新文件 tool-status.ts）

```ts
/**
 * 判断工具输出是否为失败结果
 *
 * 后端约定：
 * - 成功：返回 JSON 字符串（以 { 开头，如 {"workflow":...}）
 * - 失败：返回 "xxx失败: <原因>" 错误文本
 *
 * 不能用 includes("失败")——业务 JSON 里可能正常包含"失败"字样
 * （如需求描述"识别失败输出未知歌曲"）。
 */
export function isToolOutputFailed(output: unknown): boolean {
  const text = typeof output === "string" ? output : String(output ?? "");
  const trimmed = text.trim();

  // 空输出不算失败（可能是正常空结果）
  if (!trimmed) return false;

  // JSON 开头 → 成功（工具约定成功返回 JSON）
  if (trimmed.startsWith("{")) return false;

  // 已知错误前缀（后端工具统一格式："xxx失败: "）
  const errorPrefixes = [
    "规划失败",
    "生成失败",
    "保存失败",
    "批量验证失败",
    "读取失败",
    "试运行失败",
    "工作流更新失败",
  ];
  return errorPrefixes.some((p) => trimmed.startsWith(p));
}
```

### 2. 更新两处调用

**chat-message-list.tsx**：
```ts
// 替换原 includes("失败")
import { isToolOutputFailed } from "../api/data-stream.js";
// ...
const failed = isToolOutputFailed(event.output);
```

**App.tsx**：
```ts
// 替换原 output.includes("失败")
import { isToolOutputFailed } from "./api/data-stream.js";
// ...
const failed = isToolOutputFailed(output);
```

### 3. 备注

- 后端工具错误格式已统一（"xxx失败: 原因"），无需改后端
- 若未来工具成功返回非 JSON 文本（如纯字符串结果），再扩展判断（如加白名单），当前 JSON 约定够用

---

## 三、验收标准

1. `pnpm --filter @coze-workflow/web typecheck` 全绿；`pnpm build` 全绿
2. **浏览器实测**：给 Agent 一个含"失败"字样的需求（如"识别失败输出未知歌曲"），工具调用链面板：
   - plan_workflow / generate_workflow 正常显示 ✓（不再误标 ✗）
   - 工具状态为"完成"
3. **真失败场景**：临时让 save_to_coze 失败（如改错 COZE_SESSION_KEY），面板应显示 ✗"失败"
4. 无回归：多气泡渲染、上传、保存按钮正常

---

## 四、红线

- ❌ 不改后端工具返回格式
- ❌ 不加新依赖
- ✅ 只改前端两处调用 + 新增一个判断函数
