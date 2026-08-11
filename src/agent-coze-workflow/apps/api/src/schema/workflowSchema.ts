/**
 * 工作流 Schema 定义
 *
 * 设计思想：
 * - 定义从 WorkflowDraft 到 CozeWorkflow 的转换规则
 * - 作为 WorkflowGenerator 的知识来源
 * - 与 agent 层分离，便于独立测试和扩展
 *
 * TODO: 后续补充
 * - WorkflowDraft → CozeWorkflow 的映射规则
 * - 各节点类型的参数规范
 * - 支持的模型列表
 */

// TODO: 定义 WorkflowDraft 到 CozeWorkflow 的转换函数
// export function draftToCozeWorkflow(draft: WorkflowDraft): CozeWorkflow { ... }
