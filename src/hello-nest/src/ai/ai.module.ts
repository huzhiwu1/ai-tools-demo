/**
 * 【第四站 - 1/3】AiModule —— 用 useFactory 优雅注入 LangChain ChatOpenAI
 *
 * 学习目标：
 *   1. 把"创建一个需要读环境变量的复杂对象"交给 useFactory 工厂函数
 *   2. 通过 inject: [ConfigService] 让工厂参数自动获得依赖
 *   3. 注入键 'CHAT_MODEL' 是供 AiService 使用的"统一接口"，将来想换模型只需改这里
 *
 * 关键步骤：
 *   1. providers 中除 AiService 外，新增一个 useFactory Provider
 *   2. 工厂函数接收 ConfigService（由 inject 数组指定顺序）
 *   3. 用环境变量构造 ChatOpenAI 实例并 return
 *
 * 知识扩展（为什么用 useFactory 而不是直接在 Service 里 new ChatOpenAI？）：
 *   ① 解耦：Service 只关心"调用模型"，不关心"怎么创建模型"
 *   ② 可替换：未来想换成 ChatAnthropic / ChatBaichuan，只改这个工厂，业务代码 0 修改
 *   ③ 复用：多个 Service 想用同一个模型实例，IoC 容器自动复用单例
 *   ④ 支持异步：useFactory 可以是 async 函数，方便做"启动前的预热"
 *
 * 小白注意：
 *   - 本项目支持两套环境变量命名（OPENAI_* 和 API_KEY/BASE_URL），
 *     方便从根目录 .env 直接复用，详见 ./.env.example
 *   - configuration.baseURL 注意 URL 大小写：是 baseURL（驼峰），不是 base_url
 */
import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ChatOpenAI } from "@langchain/openai";

import { AiController } from "./ai.controller";
import { AiService } from "./ai.service";

@Module({
  controllers: [AiController],
  providers: [
    AiService,
    {
      provide: "CHAT_MODEL",
      useFactory: (configService: ConfigService) => {
        // 兼容两套命名，优先取 OPENAI_*，没有则回退到 API_KEY/BASE_URL
        const apiKey =
          configService.get<string>("OPENAI_API_KEY") ??
          configService.get<string>("API_KEY");
        const baseURL =
          configService.get<string>("OPENAI_BASE_URL") ??
          configService.get<string>("BASE_URL");
        const model =
          configService.get<string>("MODEL_NAME") ?? "gpt-3.5-turbo";

        return new ChatOpenAI({
          model,
          apiKey,
          temperature: 0.7,
          configuration: {
            baseURL,
          },
        });
      },
      inject: [ConfigService], // 工厂函数的参数顺序由这里决定
    },
  ],
})
export class AiModule {}
