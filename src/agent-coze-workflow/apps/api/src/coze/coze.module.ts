/**
 * CozeModule —— Coze 平台接入模块
 *
 * 职责：
 * - 封装 Coze 平台 API 调用
 * - 通过 useFactory 从 process.env 读取配置创建 CozeClient 实例
 * - 导出 CozeClient 供需要 DI 注入的模块使用
 *
 * 依赖链：
 * CozeModule exports CozeClient（DI 提供方）
 *   → Agent 工具链走 agent/tools/coze-client.ts 共享单例（与 DI 解耦）
 *   → MCP 服务（mcp-server.ts）自行读取 .env 构造实例（与 NestJS 解耦）
 */
import { Module } from "@nestjs/common";
import { CozeClient } from "./coze.client";

@Module({
  imports: [],
  controllers: [],
  providers: [
    {
      provide: CozeClient,
      useFactory: () => {
        return new CozeClient({
          baseUrl: process.env.COZE_API_BASE_URL ?? "",
          sessionKey: process.env.COZE_SESSION_KEY ?? "",
          spaceId: process.env.COZE_SPACE_ID ?? "",
        });
      },
    },
  ],
  exports: [CozeClient],
})
export class CozeModule {}
