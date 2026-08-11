/**
 * 工作流校验器
 *
 * 职责：
 * - 在生成 CozeWorkflow 后，调用本地校验
 * - 校验通过后，才允许调用 Coze API
 *
 * 设计思想：
 * - 校验与生成分离：Generator 负责生成，Validator 负责校验
 * - 校验失败时，将错误信息返回给 Generator 修复
 * - 减少无效的 Coze API 调用
 *
 * TODO: 后续补充
 * - 集成 @coze-workflow/workflow-schema 的 validateWorkflow
 * - 添加更多业务校验规则（如节点参数合法性）
 * - 添加 Coze 平台兼容性校验
 */

// TODO: 包装 validateWorkflow，添加业务校验层
// export function validateCozeWorkflow(workflow: CozeWorkflow): ValidationResult { ... }
