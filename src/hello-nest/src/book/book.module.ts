/**
 * 【第三站 - 1/3】BookModule
 *
 * 学习目标：
 *   1. 看懂"自定义 Provider"是怎么写的（useFactory）
 *   2. 理解"Token 注入" —— 用字符串 'BOOK_REPOSITORY' 做注入键，而不是类
 *
 * 关键步骤：
 *   1. controllers 列出本模块的路由控制器
 *   2. providers 同时声明：
 *      - 类形式 BookService（最常见）
 *      - 对象形式 { provide: 'BOOK_REPOSITORY', useFactory: ... }
 *
 * 知识扩展：
 *   Nest 的 Provider 三种"塞值方式"：
 *     ① useClass    : 提供一个类，由容器 new 一次
 *     ② useValue    : 直接提供一个常量/对象（适合 Mock、配置项）
 *     ③ useFactory  : 提供一个工厂函数，按需 new（适合需要异步或读环境变量的场景）
 *   ④ useExisting : 给已有 Provider 起一个别名 Token
 *
 * 小白注意：
 *   - 字符串 Token 写法虽然方便，但容易拼错。生产推荐用 export const BOOK_REPOSITORY = Symbol(...)
 *     或单独维护一个 tokens.ts 文件。
 */
import { Module } from "@nestjs/common";
import { BookService } from "./book.service";
import { BookController } from "./book.controller";

@Module({
  controllers: [BookController],
  providers: [
    BookService,
    {
      // 注入键（Token）—— 任何字符串都行
      provide: "BOOK_REPOSITORY",
      // 工厂函数：返回的对象就是被注入的值。这里用内存数组模拟"仓库"
      useFactory() {
        const books: { id: number; title: string }[] = [
          { id: 1, title: "《深入浅出 Nest.js》" },
          { id: 2, title: "《LangChain 实战》" },
          { id: 3, title: "《TypeScript 从入门到精通》" },
        ];
        return {
          findAll: () => [...books], // 返回拷贝，避免外部直接改内部状态
          findOne: (id: number) => books.find((b) => b.id === id),
          create: (title: string) => {
            const book = { id: books.length + 1, title };
            books.push(book);
            return book;
          },
          update: (id: number, title: string) => {
            const book = books.find((b) => b.id === id);
            if (book) book.title = title;
            return book;
          },
          remove: (id: number) => {
            const idx = books.findIndex((b) => b.id === id);
            if (idx === -1) return null;
            return books.splice(idx, 1)[0];
          },
        };
      },
    },
  ],
})
export class BookModule {}
