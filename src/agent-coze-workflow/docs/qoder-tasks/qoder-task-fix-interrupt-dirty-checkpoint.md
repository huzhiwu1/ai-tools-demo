# Qoder Task: 修复"打断并发送"后 AI 上下文混乱（脏 checkpoint）

## 背景

前端有「打断并发送」按钮：LLM 思考/工具执行中，用户点击后中断当前流并立即发送新消息。

**当前问题行为**：打断后 AI 不基于之前对话正常继续，出现上下文混乱（可能重复消息、继续旧工具调用、行为异常）。

## 根因

1. 前端 `stop()` 中断 HTTP 流 → 后端 `streamAgentEvents` 检测到 `res.destroyed` → `break` 退出迭代（graph 执行**中途放弃**）
2. LangGraph 的 MemorySaver checkpoint 已保存"执行到一半"的状态（可能含半截 tool_call 消息、未完成的 super-step）
3. 用户新消息走 `handleChat` → `streamEvents({ messages: 全量历史 }, 同一 thread_id)`——LangGraph 基于**脏 checkpoint** 开新轮次，checkpoint 旧状态 + 全量历史双重消息 → 上下文混乱

> 注意：这不是 interrupt/resume 路径（clarify_question 提问那种）。打断发生在 LLM 思考/工具执行中间，不是 interrupt 节点，checkpoint 里存的不是"可 resume 的断点"。

## 修改方案

**思路：打断后下次 chat 时重建 graph（新 MemorySaver 清空 checkpoint），对话记忆靠 session.messages 保留。**

### 改动文件

- `apps/api/src/agent/react-agent.service.ts`（主改动）
- `apps/api/src/agent/session.store.ts`（Session 类型加脏标记，如已有类似字段则复用）

### 改动点

1. **Session 增加 `graphDirty?: boolean` 字段**（session.store.ts）

2. **streamAgentEvents 的客户端断开分支标记脏**：
   在 `for await (const event of stream)` 循环里 `if (res.destroyed) break;` 处（现有代码），
   break 之前给 session 打标：
   ```typescript
   // 客户端断开（用户打断）：graph 执行中途放弃，checkpoint 留下脏状态
   // 标记会话，下次 chat 时重建 graph 清空 checkpoint，避免上下文混乱
   session.graphDirty = true;
   break;
   ```
   （需要把 session 传入 streamAgentEvents 或返回状态——检查现有签名，streamAgentEvents 已接收 session 参数则可直接用）

3. **handleChat 检测脏标记并重建 graph**：
   在获取/创建 session 之后、`streamEvents` 之前：
   ```typescript
   if (session.graphDirty) {
     // 上次被打断，checkpoint 状态脏 → 重建 graph（新 MemorySaver 清空 checkpoint）
     // 对话记忆由 session.messages 保留，AI 仍记得之前的对话
     session.graph = this.createGraph();
     session.graphDirty = false;
     this.logger.log(`[Agent] 检测到中断残留，已重建 graph (session=${sessionId})`);
   }
   ```

4. **其他位置不用动**：
   - interrupt/resume 路径（clarify_question 提问 → Command resume）**不要**重建 graph，那是正常机制
   - handleResume 不涉及此改动

## 验收标准

1. `pnpm --filter @coze-workflow/api typecheck` 通过
2. 手动验证（启动 dev 服务）：
   - 发一个会让 LLM 长时间思考/多次工具调用的需求
   - 思考过程中点「打断并发送」，输入新消息
   - 预期：AI 基于之前对话上下文正常回复新消息，不重复旧消息、不继续旧工具调用
   - 再验证正常提问（clarify）→ 回答 → resume 流程不受影响
3. 不提交 `.env`
4. 只改上述文件（session.store.ts + react-agent.service.ts），不碰前端

## 参考资料

- 前端打断逻辑：`apps/web/src/App.tsx` 的 `interruptCurrent()`（stop + abort，前端已就绪不用改）
- 后端流循环：`react-agent.service.ts` 的 `streamAgentEvents` 内 `if (res.destroyed) break;`
- Session 结构：`session.store.ts`（含 graph、messages、create/get 方法）
