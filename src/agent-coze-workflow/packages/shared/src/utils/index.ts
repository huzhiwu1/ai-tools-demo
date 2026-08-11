// @coze-workflow/shared - 工具函数

/** 生成唯一 ID（用于工作流节点和边缘） */
export function generateId(): string {
  return `node_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/** 格式化时间戳 */
export function formatTimestamp(date: Date = new Date()): string {
  return date.toISOString();
}

/** 构造统一 API 响应 */
export function createApiResponse<T>(data: T) {
  return {
    success: true,
    data,
    timestamp: formatTimestamp(),
  };
}

/** 构造错误 API 响应 */
export function createApiError(message: string) {
  return {
    success: false,
    error: message,
    timestamp: formatTimestamp(),
  };
}
