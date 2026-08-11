/**
 * 规划提示词 —— 用于 WorkflowPlanner
 *
 * 职责：引导 LLM 分析用户需求，生成工作流规划草稿
 *
 * 流程：
 * 1. 接收用户需求描述
 * 2. 分析业务场景，拆解为工作流步骤
 * 3. 输出 WorkflowDraft 结构
 *
 * 关键细节：
 * - 使用 withStructuredOutput 配合 zod schema 确保输出格式
 * - 规划阶段不涉及具体 Coze 节点 JSON，只输出抽象草稿
 * - 草稿重点在于：节点类型、连接关系、数据流向
 *
 * TODO: 后续优化
 * - 添加 few-shot 示例
 * - 添加常见工作流模式参考
 */
export const PLAN_PROMPT = `请分析以下用户需求，生成一个工作流规划草稿。

## 用户需求
{userRequirement}

## 要求
1. 分析需求的业务场景和核心目标
2. 拆解为合理的工作流步骤
3. 为每个步骤选择合适的节点类型：
   - start: 开始节点（接收输入）
   - llm: 大模型处理节点（需要 AI 推理的步骤）
   - code: 代码执行节点（数据处理、转换）
   - condition: 条件判断节点（分支逻辑）
   - http: HTTP 请求节点（调用外部 API）
   - end: 结束节点（输出结果）
4. 明确节点之间的连接关系和数据流向

## 输出格式
请以 JSON 格式返回，包含以下字段：
- name: 工作流名称
- description: 工作流描述
- nodes: 节点列表，每个节点包含 id、type、label、description
- edges: 连线列表，每条连线包含 from（源节点 ID）和 to（目标节点 ID）`;

// TODO: 后续补充 few-shot 示例
