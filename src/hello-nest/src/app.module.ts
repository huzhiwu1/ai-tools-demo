/**
 * 【第二站 - 1/3】根模块 AppModule
 *
 * 职责：
 *   把整个应用的"模块树"组装起来。Nest 通过 @Module() 装饰器
 *   声明四类成员：imports / controllers / providers / exports。
 *
 * 关键步骤：
 *   1. imports：引入其它模块（BookModule、AiModule、ConfigModule、ServeStaticModule）
 *   2. controllers：本模块自己的控制器（处理 HTTP 路由）
 *   3. providers：本模块自己的服务（业务逻辑、可被注入的对象）
 *
 * 知识扩展：
 *   - ConfigModule.forRoot({ isGlobal: true })：让 ConfigService 全局可用，
 *     所有模块都能直接 @Inject(ConfigService) 来读 .env，无需到处 imports。
 *   - ServeStaticModule：让 Nest 提供静态文件服务（用来托管前端测试页 sse-test.html）。
 *   - forRoot vs forFeature：约定俗成的命名。forRoot 用来在根模块做"全局一次性"配置；
 *     forFeature 用来在子模块做"局部增量"配置（如 TypeORM 注册某张表）。
 *
 * 小白注意：
 *   - 一个 Provider 只有被某个 Module 声明在 providers 数组里，才会被 IoC 容器管理。
 *   - 模块之间默认是"封装"的：A 模块的 Provider，B 模块要用必须 A 把它放到 exports 中。
 */
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ServeStaticModule } from "@nestjs/serve-static";
import { join } from "path";

import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { BookModule } from "./book/book.module";
import { AiModule } from "./ai/ai.module";

@Module({
  imports: [
    // 1. 静态资源托管：访问 http://localhost:3000/sse-test.html 即可打开测试页
    //    rootPath 指向编译后 dist 同级的 public 目录
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, "..", "public"),
    }),

    // 2. 配置模块：自动读取项目根 .env，并把 ConfigService 设为全局
    ConfigModule.forRoot({
      isGlobal: true,
      // 同时支持本模块自己的 .env 和项目根目录 .env（先找前者）
      envFilePath: [".env", "../../.env"],
    }),

    // 3. 业务子模块
    BookModule,
    AiModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
