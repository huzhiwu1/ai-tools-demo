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
// execute_detail — 查询执行结果
// ============================================

export interface ExecuteDetailRequest {
  execute_id: string;
}

/**
 * 执行结果数据
 *
 * 注意：字段名以实测为准，当前为候选结构。
 * 若平台接口返回字段不同，需按要求调整。
 */
export interface ExecuteDetailData {
  /** 执行状态：running / success / fail */
  status: string;
  /** 执行输出（工作流 end 节点的返回值，可能嵌套在 data 里） */
  output?: unknown;
  /** 错误信息（status=fail 时） */
  error?: string;
  /** 执行耗时（ms） */
  duration?: number;
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
