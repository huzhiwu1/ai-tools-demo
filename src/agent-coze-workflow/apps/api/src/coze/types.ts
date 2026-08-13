/**
 * MCP 层 - Coze 平台调用类型定义
 *
 * 设计思想：
 * - 所有接口按实测契约定义，不猜测参数
 * - 基础 URL：{baseUrl}/api/workflow_api/*
 * - 认证方式：Cookie session_key（PAT 不被接受）
 */

// ============================================
// CozeClient 构造配置
// ============================================

export interface CozeClientConfig {
  /** Coze 平台基础 URL（如 https://coze.dev1.dachensky.com） */
  baseUrl: string;
  /** 会话 Cookie session_key 值 */
  sessionKey: string;
  /** 工作空间 ID */
  spaceId: string;
}

// ============================================
// 通用 API 响应
// ============================================

/** Coze 平台通用响应包装 */
export interface CozeApiResponse<T = unknown> {
  code: number;
  msg: string;
  data: T;
}

// ============================================
// create — 创建工作流
// ============================================

export interface CreateWorkflowRequest {
  name: string;
  desc: string;
  /** 图标 URI，必须传 "default_icon/default_workflow_icon.png"，勿传空字符串 */
  icon_uri: string;
  space_id: string;
  /** 资源类型：0=工作流，2=智能体（勿用，否则创建后无法以工作流方式打开） */
  flow_mode: number;
}

export interface CreateWorkflowData {
  workflow_id: string;
}

// ============================================
// edit_lock — 编辑锁
// ============================================

export interface EditLockRequest {
  workflow_id: string;
  space_id: string;
  action: "acquire";
}

export interface EditLockData {
  config_ttl: number;
  remaining_ttl: number;
}

// ============================================
// canvas — 获取工作流 schema
// ============================================

export interface CanvasRequest {
  workflow_id: string;
  space_id: string;
}

export interface CanvasData {
  workflow: {
    schema_json: string;
  };
  vcs_data: {
    submit_commit_id: string;
  };
}

// ============================================
// save — 保存工作流
// ============================================

export interface SaveWorkflowRequest {
  workflow_id: string;
  schema: string;
  space_id: string;
  submit_commit_id: string;
  ignore_status_transfer: boolean;
}

// ============================================
// test_run — 试运行
// ============================================

export interface TestRunRequest {
  workflow_id: string;
  input: Record<string, unknown>;
  space_id: string;
}

export interface TestRunData {
  execute_id: string;
}

// ============================================
// update_meta — 更新元信息
// ============================================

export interface UpdateMetaRequest {
  workflow_id: string;
  space_id: string;
  name: string;
  desc: string;
  icon_uri: string;
}

// ============================================
// validate_tree — 保存前校验节点连通性
// ============================================

export interface ValidateTreeRequest {
  workflow_id: string;
  /** 平台内部 schema JSON 字符串（与 save 的 schema 参数一致） */
  schema: string;
}

/** 校验错误项 */
export interface ValidateTreeError {
  /** 出错的节点信息（path_error 类错误时为 null） */
  node_error: { node_id: string; node_name: string } | null;
  /** 路径错误信息（node_error 类错误时为 null） */
  path_error: unknown | null;
  /** 错误描述（如 node "条件判断"'s port "true_1" not connected） */
  message: string;
  /** 错误类型：1=节点级错误 */
  type: number;
}

/** 单个工作流的校验结果 */
export interface ValidateTreeItem {
  workflow_id: string;
  name: string;
  errors: ValidateTreeError[];
}

/** validate_tree 响应 data：数组，每个元素是一个工作流的校验结果 */
export type ValidateTreeData = ValidateTreeItem[];

// ============================================
// get_process — 查询执行过程（GET）
// ============================================

/** 单个节点的执行结果 */
export interface GetProcessNodeResult {
  nodeId: string;
  /** 节点类型（平台返回，首字母大写，如 Start / End / LLM） */
  NodeType: string;
  NodeName: string;
  /** 节点状态：0=等待中 1=运行中 2=跳过 3=成功 4=失败 */
  nodeStatus: number;
  errorInfo: string;
  /** 节点输入（JSON 字符串） */
  input: string;
  /** 节点输出（JSON 字符串） */
  output: string;
  nodeExeCost: string;
  tokenAndCost: Record<string, string>;
  raw_output: string;
  errorLevel: string;
  extra: string;
}

export interface GetProcessData {
  workFlowId: string;
  executeId: string;
  /** 执行状态：0=排队中 1=运行中 2=已完成 3=失败（推测） */
  executeStatus: number;
  nodeResults: GetProcessNodeResult[];
  exeHistoryStatus: number;
  workflowExeCost: string;
  reason: string;
}

// ============================================
// delete — 删除工作流
// ============================================

export interface DeleteWorkflowRequest {
  workflow_id: string;
  space_id: string;
  /** 操作类型：1=删除 */
  action: number;
}

// ============================================
// workflow_list — 工作流列表
// ============================================

export interface ListWorkflowsRequest {
  space_id: string;
  page: number;
  size: number;
}

export interface ListWorkflowsData {
  workflow_list: unknown[];
}
