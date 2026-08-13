// @coze-workflow/shared - 全局常量

/** Agent 最大执行步数 */
export const MAX_AGENT_STEPS = 10;

/** 默认 LLM 模型 */
export const DEFAULT_MODEL = "gpt-4o";

/** Coze 工作流节点类型枚举 */
export const NODE_TYPES = [
  "start",
  "llm",
  "code",
  "condition",
  "http",
  "database_query",
  "text",
  "merge",
  "end",
] as const;

/** API 路由前缀 */
export const API_PREFIX = "/api/v1";

/** 本地开发 API 地址 */
export const DEFAULT_API_BASE_URL = "http://localhost:3000";

/** 默认工作流版本 */
export const DEFAULT_WORKFLOW_VERSION = "1.0.0";
