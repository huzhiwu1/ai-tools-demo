/**
 * 【第二站 - 3/3】最简服务 AppService
 *
 * 职责：
 *   承载真正的业务逻辑。Service 是"可被注入的对象"。
 *
 * 关键步骤：
 *   1. @Injectable() 标记此类可被 IoC 容器管理（默认单例）
 *   2. 暴露公共方法供 Controller 或其他 Service 调用
 *
 * 知识扩展：
 *   - Nest 的"可注入对象"统称 Provider，Service 只是最常见的一种。
 *     还有 Repository、Factory、Helper、Strategy……命名可以自由，关键是 @Injectable()。
 *   - 默认作用域是 SINGLETON（整个应用生命周期共享一个实例），
 *     需要每次请求新建可改 @Injectable({ scope: Scope.REQUEST })。
 */
import { Injectable } from "@nestjs/common";

@Injectable()
export class AppService {
  getHello(): string {
    return "Hello Nest + LangChain! 访问 /ai/chat?query=你好 试试 AI 接口 🎉";
  }
}
