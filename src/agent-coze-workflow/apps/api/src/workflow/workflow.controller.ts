/**
 * WorkflowController —— 工作流控制器
 *
 * 职责：
 * - 接收前端工作流操作请求
 * - 委托 WorkflowService 处理业务逻辑
 * - 统一返回 ApiResponse 格式
 */
import { Controller, Post, Body } from "@nestjs/common";
import { WorkflowService } from "./workflow.service";
import type { WorkflowPlan, UserRequirement } from "@coze-workflow/shared";
import type { CozeWorkflow } from "@coze-workflow/workflow-schema";

@Controller("workflow")
export class WorkflowController {
  constructor(private readonly workflowService: WorkflowService) {}

  /**
   * 需求解析
   */
  @Post("plan")
  plan(@Body() body: UserRequirement) {
    return this.workflowService.plan(body);
  }

  /**
   * 工作流草图
   */
  @Post("sketch")
  sketch(@Body() body: UserRequirement) {
    return this.workflowService.sketch(body);
  }

  /**
   * 生成工作流
   */
  @Post("generate")
  generate(@Body() body: WorkflowPlan) {
    return this.workflowService.generate(body);
  }

  /**
   * 校验工作流
   */
  @Post("validate")
  validate(@Body() body: unknown) {
    return this.workflowService.validate(body);
  }

  /**
   * 创建工作流（提交到 Coze 平台）
   */
  @Post("create")
  create(@Body() body: CozeWorkflow) {
    return this.workflowService.create(body);
  }

  /**
   * 保存工作流
   */
  @Post("save")
  save(@Body() body: { schema: CozeWorkflow; workflowId?: string }) {
    return this.workflowService.save(body.schema, body.workflowId);
  }

  /**
   * 测试运行工作流
   */
  @Post("test-run")
  testRun(
    @Body() body: { workflowId: string; inputData: Record<string, unknown> },
  ) {
    return this.workflowService.testRun(body);
  }

  /**
   * 运行完整 LangGraph Agent 流程
   *
   * 节点链：plan → sketch → generate → validate → (条件) repair
   * 返回完整 state 便于前端日志展示
   */
  @Post("run")
  run(@Body() body: UserRequirement) {
    return this.workflowService.run(body);
  }
}
