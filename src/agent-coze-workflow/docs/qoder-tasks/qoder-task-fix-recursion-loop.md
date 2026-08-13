# Qoder 任务：修复 ReAct 死循环（recursion limit + 防循环规则）

> 项目：`/Users/huzhiwu/workspace/ai-tools-demo/src/agent-coze-workflow`
> 技术栈：NestJS 11 + LangGraph createReactAgent
> **背景：运行报 `Recursion limit of 25 reached without hitting a stop condition`——Agent 在工具调用循环里出不来（save 失败 → update_workflow 失败 → 重新 plan → 再 save 失败……），撞上 createReactAgent 默认 25 步递归上限。需要：① 提高上限（治标）；② 在 SYSTEM_PROMPT 加防死循环规则（治本）；③ 识别"不可恢复错误"直接停止（认证失败不该反复重试）。**

---

## 一、问题分析（已确认）

日志显示 Agent 反复执行同一循环不收敛：
```
plan_workflow → generate_workflow → save_to_coze(失败) → update_workflow(失败) → plan_workflow(再来) → ...
```

两个叠加原因：
1. **update_workflow 关键词匹配失败**（LLM 的自然语言 fixInstruction 落空，返回"无法识别修改类型"）→ Agent 拿不到有效反馈只能重来
2. **save_to_coze 的认证失败被当成"工作流问题"反复重试**（实际是凭证问题，改工作流没用）→ Agent 在错误方向上循环

**注意**：update_workflow 结构化改造在另一个任务（qoder-task-workflow-generation-fix.md 修复 3），本任务先做"防死循环"兜底——两者不冲突，本任务独立可跑。

---

## 二、改法

### 1. createReactAgent 提高 recursionLimit（apps/api/src/agent/react-agent.service.ts）

`createGraph()` 里加配置：

```ts
private createGraph() {
  const checkpointer = new MemorySaver();
  return createReactAgent({
    llm,
    tools: [...ALL_TOOLS],
    checkpointer,
    prompt: new SystemMessage(SYSTEM_PROMPT),
    // 提高递归上限：默认 25 步，ReAct 循环含多次工具调用容易撞上限
    // 40 步足够正常流程（plan+generate+save+validate+1~2次迭代），又不至于无限跑
    recursionLimit: 40,
  });
}
```

**同时**在 `streamAgentEvents` 调用处（handleChat / handleResume 的 config）传 `recursion_limit` 兜底（与创建时一致，双保险）：

```ts
const config: RunnableConfig = {
  configurable: { thread_id: finalSessionId },
  recursion_limit: 40,
};
```

> 说明：LangGraph JS 的 createReactAgent 支持 `recursionLimit` 选项；stream/invoke 的 config 用 `recursion_limit`（snake_case）。两处都设，确保生效。

### 2. SYSTEM_PROMPT 加「防死循环」章节（react-agent.service.ts）

在现有「使用规则」后追加：

```
## 防死循环规则（必须遵守）
- 同一个工具连续失败 2 次 → 立即停止重试该工具，向用户说明失败原因，询问如何处理
- save_to_coze 返回"authentication failed" / "access denied" → 这是平台凭证问题，不是工作流问题！
  不要修改工作流、不要反复保存，直接告知用户"COZE_SESSION_KEY 可能过期，请检查 .env 后重试"
- update_workflow 返回"无法识别修改类型" → 重新组织 fixInstruction（明确写类型：阈值/代码/逻辑/prompt/提示词/数据/常量），最多再试 1 次，仍失败就停止并告知用户
- batch_validate 迭代：最多 3 轮（第 7 步的迭代计数），3 轮后无论是否达标都停止，向用户汇报结果
- 任何时候：如果发现自己在重复做同样的事（同一工具、同一参数、同一错误），立即停止，向用户说明，而不是继续循环
```

### 3. 错误处理兜底（可选，强烈建议）

`streamAgentEvents` 的 catch 分支，识别 recursion limit 错误并返回友好提示：

```ts
} catch (e) {
  const msg = (e as Error).message;
  // 识别递归上限错误 → 提示用户 Agent 循环过深
  const isRecursion = msg.includes("Recursion limit") || msg.includes("recursion_limit");
  res.write(
    `d:${JSON.stringify({
      type: "error",
      message: isRecursion
        ? "Agent 执行步骤过多（可能陷入循环），已停止。请简化需求或提供更明确的信息后重试。"
        : msg,
    })}\n`,
  );
  res.end();
  return;
}
```

---

## 三、验收标准

1. `pnpm typecheck` 全绿；`pnpm build` 全绿
2. **防死循环实测**：故意给 Agent 一个会触发 save 失败的环境（如把 .env 的 COZE_SESSION_KEY 改错），发消息触发全流程，观察：
   - Agent 最多重试 1~2 次 save 后就停止，向用户说明"凭证问题"，不再无限循环
   - 不再出现 `Recursion limit of 25` 错误
3. **正常流程不受影响**：凭证正确时，Agent 能正常完成 plan → generate → save → validate 全流程
4. **update_workflow 失败收敛**：若 update_workflow 连续失败，Agent 会在 2 次后停止并询问用户，而不是无限重试

---

## 四、红线

- ❌ 不改工具业务逻辑（update_workflow 结构化是另一个任务）
- ❌ 不加新依赖
- ❌ 不把 recursionLimit 设得过大（40 足够，设 100+ 会掩盖问题）
- ✅ 只改：react-agent.service.ts 的 createGraph / config / SYSTEM_PROMPT / catch 分支
