# Qoder 任务单：打断后上下文恢复（方案 A'：工具结果实时记录 + 重建注入）

> 背景：用户打断思考输入新指令（如"我希望输出歌名"）后，LLM 像忘记上下文，又问"歌曲集合是什么"。
> 根因：graphDirty 重建 graph 时，新 graph 记忆只有 session.messages（纯文本 user/assistant），**工具结果全丢**（read_file 的歌曲列表、plan/generate 输出、save 的 workflowId）。
> 方案：A'（实时记录工具结果摘要，重建时注入）+ C 兜底（SYSTEM_PROMPT 引导 list_workflows 找回线上工作流）。

---

## 一、必读文件

- `apps/api/src/agent/session.store.ts`（Session.messages 类型，当前只支持 user/assistant）
- `apps/api/src/agent/react-agent.service.ts`（handleChat 组装消息 :218-248 / graphDirty 重建 :206-216 / streamAgentEvents on_tool_end :460 附近 / done 时 push assistant :531）
- `apps/api/src/agent/tools/index.ts`（工具注册 + withToolLog，可参考工具名枚举）

## 二、任务 1：Session.messages 支持工具结果记录（session.store.ts）

`Session.messages` 类型从 `{ role: "user" | "assistant"; content: string }` 扩展为支持 `"tool"`：

```ts
export interface SessionMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  /** tool 消息专属：工具名（如 read_file / save_to_coze），便于重建时归类 */
  toolName?: string;
}

// Session 里
messages: SessionMessage[];
```

**要求：**
- 不破坏现有 user/assistant 用法（其他代码 `{role:"user"|"assistant"}` 赋值兼容）
- tool 消息的 content = 工具结果**摘要**（不是全文），由任务 2 生成

## 三、任务 2：on_tool_end 实时记录工具结果摘要（react-agent.service.ts）

在 `streamAgentEvents` 的 `on_tool_end` 分支（:460 附近，已有 `toolContent = extractToolContent(output)`）里，追加记录：

```ts
case "on_tool_end": {
  const toolName = event.name ?? "unknown";
  const output = event.data?.output;
  const toolContent = this.extractToolContent(output);
  // ...现有日志 + SSE 发送保留...

  // 🆕 打断恢复记忆：关键工具结果以摘要形式记入 session.messages（role:"tool"）
  const summary = summarizeToolResult(toolName, toolContent);
  if (summary) {
    session.messages.push({ role: "tool", toolName, content: summary });
  }
  break;
}
```

新增私有方法 `summarizeToolResult(toolName: string, toolContent: string): string | null`，**按工具名定制摘要，控制体积**：

| 工具 | 摘要策略 | 示例 |
|---|---|---|
| `read_file` | 文件内容**截断到 1500 字符**（保留 columns/前几行/文本开头），标注"已截断" | `[read_file] 唱歌测试集.xlsx → 表格 url/song 列，前 5 行: ...（已截断）` |
| `get_platform_facts` | **不记录**（平台事实每次可重查，且本身 63KB 已瘦身，无需记忆）→ 返回 null | — |
| `plan_workflow` | name + steps 数量 + 每个 step 的 nodeType/description 摘要 | `[plan_workflow] SongLyricsMatcher，3 步: llm(识别歌词)→code(匹配歌曲)→text(输出)` |
| `generate_workflow` | workflow.meta.name + validation 状态 | `[generate_workflow] SongLyricsMatcher 生成完成，结构校验通过` |
| `save_to_coze` | **workflowId + name + updated 状态（最关键，必须完整保留）** | `[save_to_coze] workflowId=7674309207092363264 name=SongLyricsMatcher saved=true` |
| `update_workflow` | changes 摘要 | `[update_workflow] 节点「相似度计算」阈值已更新` |
| `batch_validate` | accuracy + 失败数 | `[batch_validate] 通过 8/10，accuracy=80%，2 个失败` |
| `test_run_workflow` | executeId | `[test_run_workflow] executeId=xxx` |
| `read_workflow` / `list_workflows` | 简短摘要 | `[read_workflow] 已读取 xxx（N 节点）` |
| `clarify_question` | **不记录**（interrupt 场景不走 on_tool_end 正常流，且答案由 resume 携带）→ 返回 null | — |
| `rename_workflow` | 新名称 | `[rename_workflow] 已改名 xxx` |
| 其他/未知 | 截断 500 字符 | — |

**实现提示：**
- `toolContent` 可能是 JSON 字符串（工具返回的 JSON.stringify 结果），摘要时优先 `JSON.parse` 后取关键字段，解析失败再走正则/截断
- 摘要**必须控制在 1500 字符内**（否则打断恢复时注入的上下文又爆炸）
- 工具名可从 `event.name` 拿（on_tool_start/on_tool_end 的 event.name 是工具名）

## 四、任务 3：重建 graph 时注入工具结果（react-agent.service.ts handleChat）

`graphDirty` 重建分支（:206-216）之后、组装 `langchainMessages`（:223）时，把 tool 消息注入：

```ts
// 3. 将历史消息转换为 LangChain BaseMessage 数组
const langchainMessages: BaseMessage[] = [];

// 🆕 打断恢复记忆：把此前会话的工具结果摘要作为上下文注入（纯文本，不做 ToolMessage，
// 避免 LangGraph 消息配对校验失败）。位置在用户消息之前，作为"系统记录"。
const toolSummaries = session.messages.filter((m) => m.role === "tool");
if (toolSummaries.length > 0) {
  const contextText =
    "【系统记录：以下是此前会话已完成的工具操作结果（用于恢复上下文，不是用户新消息）】\n" +
    toolSummaries.map((m) => `- ${m.content}`).join("\n");
  langchainMessages.push(new SystemMessage(contextText));
}

// 原有 user/assistant 消息
for (const m of session.messages) {
  if (m.role === "user") langchainMessages.push(new HumanMessage(m.content));
  if (m.role === "assistant") langchainMessages.push(new AIMessage(m.content));
}
```

**注意：**
- 只有 `graphDirty`（打断重建）场景才需要注入？——**不需要区分**：tool 消息平时不存在（on_tool_end 记录后，正常链路 done 时 graph 状态里有完整消息，session.messages 里 tool 消息只是冗余记录）；注入逻辑对所有 chat 请求生效即可，代价可忽略
- 但如果**不重建 graph**（graphDirty=false），checkpoint 里已有完整历史，再注入 tool 摘要会**重复**？——不会：checkpoint 里的是 ToolMessage（框架结构），注入的是 SystemMessage 文本摘要，语义上是"系统记录"，不冲突。可接受
- `SystemMessage` 已从 `@langchain/core/messages` 导入（文件顶部已有）

## 五、任务 4（兜底）：SYSTEM_PROMPT 引导 list_workflows 找回

`react-agent.service.ts` SYSTEM_PROMPT「## 使用规则」加一条：

```
- **线上工作流找回**：如果用户提到"之前的工作流/已经保存的/改一下刚才那个"，但当前上下文没有 workflowId，先 list_workflows 按名称搜索找回，不要重新创建
```

## 六、验收标准

1. `npm run build`（apps/api）通过，`tsc --noEmit` 无错误。
2. 单元手测（写一个 `scripts/verify-session-memory.ts` 或日志验证）：
   - 模拟一次完整链路（read_file → plan → generate → save），`on_tool_end` 后 `session.messages` 里有 4 条 tool 消息，且 save 的摘要**包含完整 workflowId**
   - 模拟打断：graphDirty=true 后再次 chat，日志显示注入的 SystemMessage 含此前工具摘要文本
3. 端到端手测（关键）：
   - 复现原场景：工作流保存后打断 → 输入"我希望看到的是输出歌名"
   - 期望：LLM **不再问"歌曲集合是什么"**，而是基于注入的上下文（知道歌曲列表已读、工作流已保存 workflowId=xxx）直接调整输出格式（改 LLM 节点 prompt 输出歌名）
   - `save_to_coze` 摘要里的 workflowId 必须在注入上下文中可见

## 七、分支 + MR 流程（⚠️ 用户新要求，必须遵守）

**不要直接改 main！**

1. 从 main 切分支：`git checkout main && git pull && git checkout -b fix/agent-context-recovery`
2. 在分支上完成所有改动
3. 提交（commit message 规范：`fix(agent-coze-workflow): 打断后上下文恢复——工具结果实时记录 + 重建注入`）
4. push 分支：`git push origin fix/agent-context-recovery`
5. **提 MR 到 main**（不要自己合并）
6. 告知用户 MR 链接，等用户 review 后合并

## 八、约束与不做

- **不改**：session.store.ts 的 Map 结构、graphDirty 机制本身、各工具逻辑（只加摘要方法）
- 摘要方法集中放 react-agent.service.ts 私有方法（或独立 `agent/tool-summary.ts` 导出，二选一，倾向独立文件便于测试）
- 保持项目风格：中文注释、错误字符串返回、文件头注释
- 不引入 DSL、不改前端
