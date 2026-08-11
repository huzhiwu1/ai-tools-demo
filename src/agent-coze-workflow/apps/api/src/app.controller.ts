/**
 * AppController —— NestJS 根控制器
 *
 * 职责：
 * - 处理 HTTP 请求，返回响应
 * - 作为路由入口，将请求委托给 AppService
 *
 * 关键步骤：
 * 1. @Controller() 装饰器声明此类为控制器
 * 2. @Get() 装饰器绑定 HTTP GET 方法到指定路径
 * 3. 构造器注入 AppService，调用其方法处理业务逻辑
 *
 * 知识扩展：
 * - @Controller 的参数是路由前缀，如 @Controller('api/v1') 会让所有路由加上 /api/v1 前缀
 * - 路由方法名（如 getHello）不影响实际 URL，URL 由 @Get() 的参数决定
 * - 控制器只负责"接请求、调服务、返回结果"，不写业务逻辑
 *
 * 小白注意：
 * - 忘记 @Injectable() 或 @Controller() 装饰器会导致类不被 NestJS 管理
 * - 控制器方法必须用 @Get/@Post 等装饰器，否则不会被注册为路由
 */
import { Controller, Get } from "@nestjs/common";
import { AppService } from "./app.service";

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /**
   * 健康检查接口
   *
   * GET /health
   * 返回：{ success: true, data: { status: "ok", uptime: number } }
   */
  @Get("health")
  getHealth() {
    return this.appService.getHealth();
  }
}
