// @coze-workflow/web - 工作流 API 封装
//
// 职责：封装对后端 workflow 接口的调用，统一错误处理
//
// 设计说明：
// - 后端路由无 /api 前缀，此处直接拼接 BASE_URL + path
// - 不使用 axios / react-query 等第三方库，保持依赖最小化
// - CozeWorkflow 类型在此定义（web 无法直接 import CommonJS 的 workflow-schema 包）

import type {
  ApiResponse,
  WorkflowPlan,
  WorkflowSketch,
  ValidationResult,
} from "@coze-workflow/shared";

// ============================================
// 最小 CozeWorkflow 类型（与后端 generate 返回结构一致）
// ============================================

export interface CozeWorkflow {
  meta: {
    name: string;
    description: string;
    version: string;
    workspaceId?: string;
  };
  nodes: unknown[];
  edges: unknown[];
  _temp?: unknown;
}

// ============================================
// /workflow/run 返回类型（对齐后端 LangGraph state）
// ============================================

export interface WorkflowRunResult {
  requirement: { description: string; constraints?: string[] };
  plan: WorkflowPlan | null;
  sketch: WorkflowSketch | null;
  workflow: CozeWorkflow | null;
  validation: ValidationResult | null;
  errors: string[];
  repairCount: number;
  durationMs: number;
  startedAt: string;
}

// ============================================
// 内部工具
// ============================================

const BASE_URL = "http://localhost:3000";

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  const json = (await res.json()) as ApiResponse<T>;

  if (!json.success) {
    throw new Error(json.error ?? "请求失败");
  }

  return json.data as T;
}

// ============================================
// 对外 API
// ============================================

export const workflowApi = {
  /** 需求规划 */
  plan: (description: string) =>
    post<WorkflowPlan>("/workflow/plan", { description }),

  /** 工作流草图 */
  sketch: (description: string) =>
    post<WorkflowSketch>("/workflow/sketch", { description }),

  /** 生成 Coze 工作流 JSON */
  generate: (plan: WorkflowPlan) =>
    post<CozeWorkflow>("/workflow/generate", plan),

  /** 校验工作流 */
  validate: (workflow: CozeWorkflow) =>
    post<ValidationResult>("/workflow/validate", workflow),

  /** 运行完整 LangGraph Agent 流程（plan → sketch → generate → validate → repair） */
  run: (description: string) =>
    post<WorkflowRunResult>("/workflow/run", { description }),
};
