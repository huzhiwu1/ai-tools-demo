/**
 * 共享 CozeClient 单例
 *
 * save.tool.ts / test-run.tool.ts 共用同一实例，
 * 编辑锁状态统一管理，配置只写一处。
 */
import { CozeClient } from "../../coze/coze.client";

export const cozeClient = new CozeClient({
  baseUrl: process.env.COZE_API_BASE_URL ?? "",
  sessionKey: process.env.COZE_SESSION_KEY ?? "",
  spaceId: process.env.COZE_SPACE_ID ?? "",
});
