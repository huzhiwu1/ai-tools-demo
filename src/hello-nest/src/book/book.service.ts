/**
 * 【第三站 - 2/3】BookService
 *
 * 学习目标：
 *   理解"属性注入"@Inject('TOKEN')，对比第二站的"构造器注入"。
 *
 * 两种注入方式对比：
 *   - 构造器注入（推荐）：
 *       constructor(private readonly bookRepo: BookRepository) {}
 *     优点：依赖关系一眼看见、便于单测 mock。
 *
 *   - 属性注入（特殊场景）：
 *       @Inject('BOOK_REPOSITORY') private readonly bookRepo: any;
 *     适合：注入键是字符串/Symbol Token、或不想改构造器签名时。
 *
 * 小白注意：
 *   - 真实项目里 bookRepository 应该有强类型，可单独定义 interface BookRepository 并在
 *     factory 的返回值上加类型，避免到处写 any。
 */
import { Inject, Injectable } from "@nestjs/common";
import { CreateBookDto } from "./dto/create-book.dto";
import { UpdateBookDto } from "./dto/update-book.dto";

@Injectable()
export class BookService {
  // 用 Token 'BOOK_REPOSITORY' 拿到 book.module 工厂返回的对象
  @Inject("BOOK_REPOSITORY")
  private readonly bookRepository: any;

  create(createBookDto: CreateBookDto & { title?: string }) {
    return this.bookRepository.create(createBookDto.title ?? "未命名图书");
  }

  findAll() {
    return this.bookRepository.findAll();
  }

  findOne(id: number) {
    const book = this.bookRepository.findOne(id);
    return book ?? `没找到 id=${id} 的图书`;
  }

  update(id: number, updateBookDto: UpdateBookDto & { title?: string }) {
    const book = this.bookRepository.update(id, updateBookDto.title ?? "");
    return book ?? `没找到 id=${id} 的图书`;
  }

  remove(id: number) {
    const book = this.bookRepository.remove(id);
    return book ?? `没找到 id=${id} 的图书`;
  }
}
