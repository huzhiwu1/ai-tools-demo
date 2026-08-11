/**
 * WorkflowModule —— 工作流业务模块
 *
 * 职责：
 * - 注册工作流相关的 Controller 和 Service
 * - 作为工作流 CRUD 操作的入口
 * - 调用 AgentsModule 的 Agent 类完成编排
 *
 * TODO: 后续完善
 * - 实现 WorkflowController（POST /generate、GET /status 等）
 * - 实现 WorkflowService（编排 Agent 调用流程）
 * - 集成 AgentsModule、McpModule
 */
import { Module } from "@nestjs/common";

@Module({
  imports: [
    // TODO: 导入依赖模块
    // AgentsModule,
    // McpModule,
  ],
  controllers: [
    // TODO: 注册 WorkflowController
  ],
  providers: [
    // TODO: 注册 WorkflowService
  ],
})
export class WorkflowModule {}
