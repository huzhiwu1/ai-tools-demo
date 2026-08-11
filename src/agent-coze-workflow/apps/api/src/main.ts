/**
 * NestJS 启动入口
 *
 * 职责：
 * - 加载环境变量
 * - 创建 NestJS 应用实例（NestFactory.create）
 * - 注册全局管道/过滤器（预留）
 * - 启动 HTTP 服务监听
 *
 * 流程：
 * 1. 从 AppModule 启动 NestJS IoC 容器
 * 2. 启用 CORS
 * 3. 监听端口（默认 3000）
 *
 * 关键细节：
 * - NestFactory.create() 会扫描所有装饰器元数据，构建 IoC 容器
 * - 必须先 import 'reflect-metadata'，否则装饰器不生效
 * - 端口从环境变量 API_PORT 读取，默认 3000
 *
 * 知识扩展：
 * NestJS 的 IoC 容器在 NestFactory.create(AppModule) 时完成构建：
 * 扫描装饰器元数据 → 解析依赖关系 → 实例化 Provider 单例
 */
import "reflect-metadata";
import * as dotenv from "dotenv";
import * as path from "path";

// 从 dist/main.js 出发定位到项目根 .env
// dev 模式编译产物在 apps/api/dist/，__dirname 是 apps/api/dist，../../../.env 正好到项目根
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();

  const port = process.env.API_PORT ?? 3000;
  await app.listen(port);
  console.log(`[API] 加载 .env:`, !!process.env.DEEPSEEK_API_KEY);
  console.log(`[API] NestJS 服务已启动: http://localhost:${port}`);
  console.log(`[API] 健康检查: http://localhost:${port}/health`);
}

bootstrap();
