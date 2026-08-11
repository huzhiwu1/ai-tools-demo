/**
 * AgentsModule —— Agent 编排模块
 *
 * 职责：
 * - 注册 WorkflowPlanner、WorkflowGenerator、WorkflowRepairer 三个 Agent 类
 * - 作为 NestJS Provider 供其他模块注入使用
 *
 * TODO: 后续完善
 * - 注册 Agent 服务类到 providers
 * - 实现 Agent 编排的 Controller（接收用户需求，触发 Agent 流程）
 * - 集成 LangChain + LangGraph
 */
import { Module } from "@nestjs/common";

@Module({
  imports: [],
  controllers: [],
  providers: [
    // TODO: 注册 Agent 类
    // WorkflowPlanner,
    // WorkflowGenerator,
    // WorkflowRepairer,
  ],
  exports: [
    // TODO: 导出给其他模块使用
    // WorkflowPlanner,
    // WorkflowGenerator,
    // WorkflowRepairer,
  ],
})
export class AgentsModule {}
