/**
 * AppModule —— NestJS 根模块
 *
 * 职责：
 * - 注册根 Controller 和 Provider
 * - 导入所有子模块
 * - 作为 NestFactory.create() 的入口模块
 *
 * 关键步骤：
 * 1. @Module 装饰器声明 controllers / providers / imports
 * 2. controllers 数组注册 AppController（处理 HTTP 请求）
 * 3. providers 数组注册 AppService（业务逻辑）
 * 4. imports 数组导入子模块（后续扩展）
 *
 * 知识扩展：
 * - 模块是 NestJS 的基本组织单元，每个模块封装一组相关功能
 * - 模块默认封装：Provider 只在声明它的模块内可见
 * - 要想跨模块使用，必须把 Provider 放入 exports 数组
 *
 * 小白注意：
 * - 忘记 imports 子模块会导致依赖注入失败
 * - 模块间的 imports 关系形成依赖图，NestJS 据此构建 IoC 容器
 */
import { Module } from "@nestjs/common";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { WorkflowModule } from "./workflow/workflow.module";
import { AgentsModule } from "./agents/agents.module";

// TODO: 后续导入子模块
// import { McpModule } from "./mcp/mcp.module";

@Module({
  imports: [
    WorkflowModule,
    AgentsModule,
    // TODO: 注册子模块
    // McpModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
