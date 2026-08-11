/**
 * 生成提示词 —— 用于 WorkflowGenerator
 *
 * 职责：引导 LLM 将工作流草稿转化为 Coze 工作流 JSON
 *
 * 流程：
 * 1. 接收 WorkflowDraft 草稿
 * 2. 根据草图中的节点类型，选择模板并填充参数
 * 3. 输出 CozeWorkflow JSON
 *
 * 关键细节：
 * - 模板优先：先用模板生成基础结构，再用 LLM 填充细节
 * - 这样可以减少 LLM 幻觉，保证输出结构正确
 * - 生成后必须通过 validateWorkflow 校验
 *
 * TODO: 后续优化
 * - 添加各节点类型的具体参数说明
 * - 添加常见错误示例和修正方法
 * - 添加 Coze 平台特定的约束说明
 */
export const GENERATE_PROMPT = `请根据以下工作流草稿，生成完整的 Coze 工作流 JSON。

## 工作流草稿
{workflowDraft}

## 节点类型规范
- start 节点：必须包含 inputVariables（输入变量定义）
- llm 节点：必须包含 config（模型配置）、userPrompt（用户提示词）
- code 节点：必须包含 code（代码内容）、language（语言）
- condition 节点：必须包含 branches（条件分支列表）
- http 节点：必须包含 method（请求方法）、url（请求地址）
- end 节点：必须包含 outputVariables（输出变量定义）

## 要求
1. 为每个节点填充完整的参数
2. 确保节点 ID 唯一且与草稿中的连线匹配
3. 变量引用使用 {{变量名}} 格式
4. 节点间数据传递使用 nodeId.fieldName 格式

## 输出格式
请以 JSON 格式返回完整的 Coze 工作流，包含 meta、nodes、edges 三个字段。`;

// TODO: 后续补充每种节点类型的详细模板参数
