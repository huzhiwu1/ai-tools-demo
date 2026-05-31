/**
 * 【第三站 - 3/3】BookController
 *
 * 学习目标：
 *   1. 五大 HTTP 装饰器：@Get / @Post / @Patch / @Delete / @Put
 *   2. 三种参数装饰器：@Param（路径参数）/ @Query（查询参数）/ @Body（请求体）
 *
 * 路由速查表（前缀 /book）：
 *   POST   /book        创建一本书      Body: { title: string }
 *   GET    /book        查全部
 *   GET    /book/:id    查单本
 *   PATCH  /book/:id    部分更新        Body: { title?: string }
 *   DELETE /book/:id    删除
 *
 * 知识扩展：
 *   - +id 是 JavaScript 的小技巧：把字符串快速转 number（NaN 风险记得校验）。
 *   - 真实项目用 ParseIntPipe：@Param('id', ParseIntPipe) id: number 更安全。
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { BookService } from "./book.service";
import { CreateBookDto } from "./dto/create-book.dto";
import { UpdateBookDto } from "./dto/update-book.dto";

@Controller("book")
export class BookController {
  constructor(private readonly bookService: BookService) {}

  @Post()
  create(@Body() createBookDto: CreateBookDto) {
    return this.bookService.create(createBookDto);
  }

  @Get()
  findAll() {
    return this.bookService.findAll();
  }

  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.bookService.findOne(+id);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() updateBookDto: UpdateBookDto) {
    return this.bookService.update(+id, updateBookDto);
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.bookService.remove(+id);
  }
}
