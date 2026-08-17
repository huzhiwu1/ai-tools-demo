/**
 * [Module] operations - update_workflow op 化模块统一导出
 *
 * 职责：
 * 导出操作指令 schema（operations.schema.ts）与执行器（apply-operation.ts），
 * 供 update-workflow.tool.ts 工具壳与单测引用。
 *
 * 关键细节：
 * - 拆分动机（codex S1）：原 update-workflow.tool.ts 577 行单文件，
 *   schema + 执行 + 工具壳混在一起无法单测；拆后 applyOperations
 *   是纯函数，每个 op 可独立单测
 */
export {
  UpdateOperationSchema,
  UpdateOperationsSchema,
  FIELD_PATHS,
  STRING_FIELDS,
  ARRAY_FIELDS,
  ANY_FIELDS,
} from "./operations.schema";
export type { UpdateOperation, FieldPath } from "./operations.schema";

export { applyOperations, findTargetNode } from "./apply-operation";
export type { ApplyResult, ApplyContext } from "./apply-operation";
