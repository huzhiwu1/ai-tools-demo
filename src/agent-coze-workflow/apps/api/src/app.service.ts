/**
 * AppService —— NestJS 根服务层
 *
 * 职责：
 * - 封装业务逻辑，供 Controller 调用
 * - 通过 @Injectable() 装饰器被 IoC 容器管理，可注入到其他类
 *
 * 关键步骤：
 * 1. @Injectable() 声明此类为 Provider，可被 NestJS IoC 容器管理
 * 2. 构造器注入其他依赖（当前无）
 * 3. 方法返回业务数据
 *
 * 知识扩展：
 * - @Injectable() 是 Provider 的标记，等价于告诉 NestJS："这个类可以注入到其他地方"
 * - 默认作用域为单例（Singleton），整个应用生命周期内只创建一个实例
 * - 三种作用域：Singleton（默认）/ Request（每个请求一个）/ Transient（每次注入一个新实例）
 *
 * 小白注意：
 * - 忘记 @Injectable() 装饰器会导致构造器注入失败：NestJS 无法识别这个类
 * - Service 不应该直接操作 HTTP 请求/响应对象（那是 Controller 的职责）
 */
import { Injectable } from "@nestjs/common";
import { createApiResponse } from "@coze-workflow/shared";

@Injectable()
export class AppService {
  /**
   * 健康检查
   *
   * 返回服务运行状态和运行时间
   */
  getHealth() {
    return createApiResponse({
      status: "ok",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  }
}
