/**
 * McpModule —— MCP 客户端模块
 *
 * 职责：
 * - 封装 Coze 平台 API 调用
 * - 作为 NestJS Provider 供 Agent 模块注入使用
 *
 * TODO: 后续完善
 * - 注册 CozeClient 到 providers
 * - 使用 useFactory 根据环境变量创建 CozeClient 实例
 * - 配置超时、重试等参数
 */
import { Module } from "@nestjs/common";

@Module({
  imports: [],
  controllers: [],
  providers: [
    // TODO: 注册 CozeClient
    // {
    //   provide: CozeClient,
    //   useFactory: () => {
    //     return new CozeClient({
    //       baseUrl: process.env.COZE_API_BASE_URL ?? "",
    //       apiKey: process.env.COZE_API_KEY ?? "",
    //       timeout: 30000,
    //     });
    //   },
    // },
  ],
  exports: [
    // TODO: 导出 CozeClient
    // CozeClient,
  ],
})
export class McpModule {}
