# Qoder 任务：验证迭代上限改为代码硬计数（不再靠 LLM 自觉）

> 项目：`/Users/huzhiwu/workspace/ai-tools-demo/src/agent-coze-workflow`
> 技术栈：NestJS 11 + LangGraph createReactAgent + pnpm workspace
> **背景："batch_validate 最多 3 轮"目前写在 SYSTEM_PROMPT 里靠 LLM 数次数，LLM 记不住、数错、失败时倾向继续试——这是死循环根源之一（Recursion limit 25 实锤）。需要把迭代上限从"LLM 自觉"改为"代码硬计数"：计数器在代码里，达到 3 次工具直接返回错误，LLM 收到错误必须停。**

---

## 一、现状与问题

- `apps/api/src/agent/tools/batch-validate.tool.ts`：批量验证工具，无迭代计数
- `apps/api/src/agent/tools/update-workflow.tool.ts`：工作流修改工具，无迭代计数
- `react-agent.service.ts` 的 SYSTEM_PROMPT 写着"迭代 3 次仍 < 100%：向用户说明情况"——**这是 LLM 判断，不可靠**

**问题**：LLM 自己数"第几次"会数错（对话历史长）、失败时倾向重试、没有硬约束 → 死循环 → 撞 recursionLimit。

---

## 二、改法：模块级迭代计数器（工具层硬约束）

### 1. 新建共享计数器（apps/api/src/agent/tools/iteration-counter.ts）

```ts
/**
 * 验证迭代计数器（工具层硬约束，LLM 无法改写）
 *
 * 按 workflowId 隔离计数：每个工作流的 batch_validate / update_workflow
 * 调用次数分别累计，达到 MAX_ITERATIONS 后工具直接返回"已达上限"错误，
 * LLM 收到该错误必须停止迭代并向用户汇报，不能继续修改。
 */
const iterationCounts = new Map<string, number>();

/** 迭代上限 */
export const MAX_ITERATIONS = 3;

/** 获取当前迭代次数（第几次，从 1 开始） */
export function getIteration(workflowId: string): number {
  return iterationCounts.get(workflowId) ?? 0;
}

/** 迭代计数 +1，返回最新次数 */
export function incrementIteration(workflowId: string): number {
  const next = getIteration(workflowId) + 1;
  iterationCounts.set(workflowId, next);
  return next;
}

/** 重置指定工作流的计数（新建工作流时调用） */
export function resetIteration(workflowId: string): void {
  iterationCounts.delete(workflowId);
}

/** 是否已达迭代上限 */
export function isIterationExceeded(workflowId: string): boolean {
  return getIteration(workflowId) > MAX_ITERATIONS;
}

/** 生成"已达上限"错误信息（LLM 收到必须停止） */
export function iterationLimitMessage(workflowId: string): string {
  return (
    `已达迭代上限（${MAX_ITERATIONS} 次）。请立即停止修改工作流 ` +
    `(${workflowId})，向用户汇报当前结果（准确率 + 失败分析 + 建议），` +
    `不要再次调用 batch_validate / update_workflow。`
  );
}
```

### 2. batch-validate.tool.ts 接入计数

```ts
// 工具函数开头（try 之前）：
const iteration = incrementIteration(workflowId);
// 超过上限：直接返回错误，不执行验证
if (iteration > MAX_ITERATIONS) {
  return iterationLimitMessage(workflowId);
}
```

**注意**：`workflowId` 从工具入参拿（已有）。计数从 1 开始，第 4 次调用起返回上限错误。

### 3. update-workflow.tool.ts 接入计数

```ts
// 工具函数开头：
const iteration = incrementIteration(workflowId);
if (iteration > MAX_ITERATIONS) {
  return iterationLimitMessage(workflowId);
}
```

> 说明：batch_validate 和 update_workflow 共用同一计数器（同 workflowId），因为一轮迭代 = 验证一次 + 修改一次，两者合计超 3 轮即停。

### 4. save_to_coze 成功后重置计数（save.tool.ts）

```ts
// save_to_coze 创建成功拿到新 workflowId 后：
resetIteration(workflowId);  // 新工作流从 0 开始计数
```

> 为什么：每次保存的是新工作流（或新版本），迭代次数应重新开始；若 Agent 反复保存同一 workflowId 则继续累计。

### 5. SYSTEM_PROMPT 删除 LLM 自觉判断规则（react-agent.service.ts）

**删除以下让 LLM 自己数次数/自己决定是否停止的规则**（原文逐字删除）：

```
- 若 accuracy < 100% 且迭代次数 < 3：
  分析 failurePatterns → 给出 fixInstruction → update_workflow → 重新 save → batch_validate
- 迭代 3 次仍 < 100%：向用户说明情况，或 clarify_question 索取信息，用户确认后继续
```

**替换为**（只保留"由系统强制"的说明，不要求 LLM 自己计数）：

```
- batch_validate / update_workflow 有系统级迭代上限（3 轮），达到后工具会返回"已达迭代上限"错误
- 收到该错误时必须停止迭代，向用户汇报当前结果，不要尝试绕过或继续修改
- 正常迭代流程：验证不达标 → 分析 failurePatterns → update_workflow → 重新保存 → 再次验证
```

> 原则：**计数和上限判断是代码的职责（iteration-counter.ts），LLM 只负责收到错误后正确响应**。

---

## 三、验收标准

1. `pnpm typecheck` 全绿；`pnpm build` 全绿
2. **硬计数实测**：用同一 workflowId 连续调 batch_validate 4 次：
   - 前 3 次正常执行
   - 第 4 次返回"已达迭代上限（3 次）…"错误，不执行验证逻辑（日志无 test_run 请求）
3. **Agent 全链路**：触发一个会反复修改的工作流，观察 Agent 在第 3 轮后收到上限错误并停止，向用户汇报（不再无限循环）
4. 新建工作流后计数重置：保存新工作流后再验证，计数从 1 开始

---

## 四、红线

- ❌ 不加新依赖（Map 原生即可）
- ❌ 不改平台 API 调用
- ❌ 不删除 recursionLimit（两层保险：工具层 3 轮 + graph 层 40 步）
- ✅ 计数器只增不减（除 save 成功后 reset），LLM 无法绕过
- ✅ 达到上限返回的是"告知用户"的错误信息，不是抛异常（ReAct 工具铁律）
