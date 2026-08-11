/**
 * AgentsModule —— Agent 编排模块
 *
 * 职责：
 * - 注册 DeepSeekClient、WorkflowPlanner、WorkflowGenerator、WorkflowRepairer
 * - 编译 LangGraph StateGraph 作为 Provider，供 WorkflowService 注入
 *
 * 设计选择：
 * - useFactory 创建所有实例，从 process.env 读配置（dotenv 在 main.ts 已加载）
 * - WorkflowGenerator 无需 LLM（纯模板映射），无外部依赖
 * - WorkflowRepairer 需要 DeepSeekClient（LLM 兜底修复）
 * - 编译后的 graph 通过 useFactory 注入三个 Agent 实例
 * - 不使用 @nestjs/config（指令要求 dotenv 优先，减少依赖）
 */
import { Module } from "@nestjs/common";
import { DeepSeekClient } from "../llm/deepseek.client";
import { WorkflowPlanner } from "./workflow-planner";
import { WorkflowGenerator } from "./workflow-generator";
import { WorkflowRepairer } from "./workflow-repairer";
import { createWorkflowGraph } from "./graph";

@Module({
  imports: [],
  controllers: [],
  providers: [
    // DeepSeekClient：从环境变量读取配置
    {
      provide: DeepSeekClient,
      useFactory: () => new DeepSeekClient(),
    },
    // WorkflowPlanner：依赖 DeepSeekClient
    {
      provide: WorkflowPlanner,
      useFactory: (client: DeepSeekClient) => new WorkflowPlanner(client),
      inject: [DeepSeekClient],
    },
    // WorkflowGenerator：纯代码映射，无外部依赖
    {
      provide: WorkflowGenerator,
      useFactory: () => new WorkflowGenerator(),
    },
    // WorkflowRepairer：需要 LLM 兜底修复
    {
      provide: WorkflowRepairer,
      useFactory: (client: DeepSeekClient) => new WorkflowRepairer(client),
      inject: [DeepSeekClient],
    },
    // 编译后的 LangGraph StateGraph
    // 通过闭包注入三个 Agent 实例，图示：
    //   plan → sketch → generate → validate → (条件) repair → validate
    {
      provide: "WORKFLOW_GRAPH",
      useFactory: (
        planner: WorkflowPlanner,
        generator: WorkflowGenerator,
        repairer: WorkflowRepairer,
      ) => createWorkflowGraph(planner, generator, repairer),
      inject: [WorkflowPlanner, WorkflowGenerator, WorkflowRepairer],
    },
  ],
  exports: [
    DeepSeekClient,
    WorkflowPlanner,
    WorkflowGenerator,
    WorkflowRepairer,
    "WORKFLOW_GRAPH",
  ],
})
export class AgentsModule {}
