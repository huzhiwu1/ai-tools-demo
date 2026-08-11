/**
 * WorkflowModule —— 工作流业务模块
 *
 * 职责：
 * - 注册 WorkflowController 和 WorkflowService
 * - 提供工作流 CRUD 操作的 REST API
 * - 后续集成 AgentsModule 和 McpModule
 */
import { Module } from "@nestjs/common";
import { WorkflowController } from "./workflow.controller";
import { WorkflowService } from "./workflow.service";
import { AgentsModule } from "../agents/agents.module";

@Module({
  imports: [
    AgentsModule,
    // TODO: 后续导入 McpModule
  ],
  controllers: [WorkflowController],
  providers: [WorkflowService],
})
export class WorkflowModule {}
