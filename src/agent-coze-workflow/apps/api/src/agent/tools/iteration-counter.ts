/**
 * 验证迭代计数器（工具层硬约束，LLM 无法改写）
 *
 * 职责：
 * 按 workflowId 隔离计数，batch_validate / update_workflow 每次调用
 * 各自累计，达到 MAX_ITERATIONS 后工具直接返回"已达上限"错误。
 * LLM 收到该错误必须停止迭代并向用户汇报，不能继续修改。
 *
 * 关键细节：
 * - 只增不减（除 save 成功后 reset），LLM 无法绕过
 * - batch_validate 和 update_workflow 共用同一计数器（同 workflowId），
 *   因为一轮迭代 = 验证一次 + 修改一次，合计超 3 轮即停
 * - 新建工作流（新 workflowId）后自动从 0 开始
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
