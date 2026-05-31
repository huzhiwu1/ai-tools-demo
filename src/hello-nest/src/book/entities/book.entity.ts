/**
 * 【第三站 - Entity】Book 实体
 *
 * 职责：
 *   定义一本"图书"的领域模型（持久层数据结构）。
 *
 * 知识扩展：
 *   - 在带 ORM（如 TypeORM/Prisma）的真实项目里，这里会写 @Entity() / @Column() 等装饰器，
 *     直接映射成数据库表。本教学用内存数据，所以保持纯类。
 */
export class Book {
  id: number;
  title: string;
}
