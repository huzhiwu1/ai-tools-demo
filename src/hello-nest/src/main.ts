/**
 * 【第一站】Nest.js 启动入口 main.ts
 *
 * 职责：
 *   把 AppModule 当作"乐高积木的总图纸"，通过工厂函数 NestFactory.create()
 *   组装出一个 HTTP 服务并监听端口。
 *
 * 关键步骤：
 *   1. 引入根模块 AppModule（一棵模块树的"根"）
 *   2. NestFactory.create() 把 AppModule 编译为可运行的应用实例
 *   3. app.listen() 启动 HTTP 服务，开始监听端口
 *
 * 知识扩展：
 *   - 为什么 Nest 需要"模块"这个概念？
 *     Nest 借鉴了 Angular 的设计，把代码按"模块"组织，每个模块管理自己的
 *     Controller / Service / Provider，使得大型项目结构清晰、可拆可合。
 *   - NestFactory 做了什么？
 *     扫描装饰器元数据 → 解析依赖关系 → 构建 IoC 容器 → 创建底层 HTTP 适配器
 *     （默认 Express，也可切换 Fastify）。
 *
 * 小白注意：
 *   - 端口被占用会报错 EADDRINUSE，可在 .env 里改 PORT 解决。
 *   - bootstrap() 是约定俗成的"启动函数"名，叫别的也行，不影响功能。
 */
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  // 创建 Nest 应用实例（此时 IoC 容器已经把所有 Provider 实例化好了）
  const app = await NestFactory.create(AppModule);

  // 监听端口：优先读取环境变量 PORT，否则回退到 3000
  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  console.log(`🚀 服务已启动: http://localhost:${port}`);
  console.log(`📄 SSE 测试页面: http://localhost:${port}/sse-test.html`);
}

bootstrap();
