/**
 * McpModule —— MCP 客户端模块
 *
 * 职责：
 * - 封装 Coze 平台 API 调用
 * - 通过 useFactory 从 process.env 读取配置创建 CozeClient 实例
 * - 导出 CozeClient 供其他模块（WorkflowModule）注入使用
 *
 * 依赖链：
 * McpModule  exports CozeClient
 *   → WorkflowModule imports McpModule
 *      → WorkflowService 构造器注入 CozeClient
 */
import { Module } from "@nestjs/common";
import { CozeClient } from "./cozeClient";

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
export class McpModule {}
