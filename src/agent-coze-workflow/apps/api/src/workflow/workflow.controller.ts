/**
 * WorkflowController —— 工作流控制器
 *
 * 职责：
 * - 接收前端工作流操作请求
 * - 委托 WorkflowService 处理业务逻辑
 * - 统一返回 ApiResponse 格式
 *
 * 路由前缀：/workflow
 *
 * TODO: 后续添加身份校验 Guard、请求限流 Interceptor
 */
import { Controller, Post, Body } from "@nestjs/common";
import { WorkflowService } from "./workflow.service";
import type { WorkflowPlan, WorkflowSchema } from "@coze-workflow/shared";

@Controller("workflow")
export class WorkflowController {
  constructor(private readonly workflowService: WorkflowService) {}

  /**
   * 规划工作流
   *
   * POST /workflow/plan
   *
   * 接收用户自然语言需求，返回 Agent 规划结果
   */
  @Post("plan")
  plan(@Body() body: { description: string; constraints?: string[] }) {
    return this.workflowService.plan(body);
  }

  /**
   * 生成工作流
   *
   * POST /workflow/generate
   *
   * 接收规划结果，生成完整的工作流 schema
   */
  @Post("generate")
  generate(@Body() body: WorkflowPlan) {
    return this.workflowService.generate(body);
  }

  /**
   * 校验工作流
   *
   * POST /workflow/validate
   *
   * 接收工作流 JSON，返回校验结果
   */
  @Post("validate")
  validate(@Body() body: unknown) {
    return this.workflowService.validate(body);
  }

  /**
   * 创建工作流（提交到 Coze 平台）
   *
   * POST /workflow/create
   */
  @Post("create")
  create(@Body() body: WorkflowSchema) {
    return this.workflowService.create(body);
  }

  /**
   * 保存工作流
   *
   * POST /workflow/save
   */
  @Post("save")
  save(@Body() body: { schema: WorkflowSchema; workflowId?: string }) {
    return this.workflowService.save(body.schema, body.workflowId);
  }

  /**
   * 测试运行工作流
   *
   * POST /workflow/test-run
   */
  @Post("test-run")
  testRun(
    @Body() body: { workflowId: string; inputData: Record<string, unknown> },
  ) {
    return this.workflowService.testRun(body);
  }
}
