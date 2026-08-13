/**
 * ReactAgentModule - ReAct Agent 模块
 *
 * 职责：
 * - 注册 ReactAgentService 和 ReactAgentController
 * - 工具使用模块级单例（不经过 NestJS DI，简单可靠）
 *
 * 设计选择：
 * - ReactAgentService 无构造依赖，工具内部直接 new（与 NestJS DI 解耦）
 * - graph 实例按会话创建，不放入 DI 容器
 */
import { Module } from "@nestjs/common";
import { ReactAgentService } from "./react-agent.service";
import { ReactAgentController } from "./react-agent.controller";

@Module({
  controllers: [ReactAgentController],
  providers: [ReactAgentService],
  exports: [ReactAgentService],
})
export class ReactAgentModule {}
