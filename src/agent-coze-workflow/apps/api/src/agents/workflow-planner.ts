/**
 * WorkflowPlanner - 工作流规划 Agent
 *
 * 职责：
 * 接收用户自然语言需求，通过 LLM 推理生成工作流草图（WorkflowDraft）
 *
 * 流程：
 * 1. 接收 UserRequirement
 * 2. 调用 LLM 分析需求，拆解为工作流步骤
 * 3. 输出 WorkflowDraft（节点 + 连线 + 描述）
 *
 * 关键细节：
 * - 使用 LangGraph 构建 ReAct 循环
 * - 规划阶段不涉及具体 Coze 节点 JSON
 * - 输出为抽象的工作流草图，后续由 WorkflowGenerator 细化
 *
 * TODO: 完整实现
 * - 集成 LangChain ChatOpenAI
 * - 实现 ReAct 循环（Thought → Action → Observation）
 * - 加载 planPrompt 作为系统提示词
 * - 使用 withStructuredOutput 确保输出格式
 */
export class WorkflowPlanner {
  // TODO: 实现规划逻辑
  // async plan(requirement: UserRequirement): Promise<WorkflowDraft> { ... }
}
