/**
 * 【第二站 - 2/3】最简控制器 AppController
 *
 * 职责：
 *   接收 HTTP 请求并把"业务"委托给 Service，自身不写复杂逻辑。
 *
 * 关键步骤：
 *   1. @Controller() 注册一个路由前缀（这里没传，等于挂在根路径 /）
 *   2. constructor 里通过"构造器注入"拿到 AppService（IoC 自动塞进来）
 *   3. @Get() 标记 GET / 路由，返回服务层的字符串
 *
 * 知识扩展：
 *   - private readonly：TypeScript 的简写，等价于在类中声明字段并赋值，让代码更精简。
 *   - 控制器只做"翻译"：HTTP 协议 ↔ 业务方法。复杂逻辑必须放到 Service。
 *
 * 小白注意：
 *   - 如果你写了 @Controller('users')，那么 @Get() 会变成 GET /users，
 *     @Get(':id') 会变成 GET /users/:id。
 */
import { Controller, Get } from "@nestjs/common";
import { AppService } from "./app.service";

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
