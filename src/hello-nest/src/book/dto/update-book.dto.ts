/**
 * 【第三站 - DTO】UpdateBookDto
 *
 * 职责：
 *   "更新"通常是"创建字段的可选版本"，PartialType 帮我们一键把所有字段改为可选。
 *
 * 知识扩展：
 *   - PartialType 来自 @nestjs/mapped-types，类似 TypeScript 的 Partial<T> 类型工具，
 *     但它能在运行时保留装饰器元数据（class-validator 的校验规则会一并继承）。
 *   - 同类工具还有 PickType / OmitType / IntersectionType，让 DTO 之间可以"组合复用"。
 */
import { PartialType } from "@nestjs/mapped-types";
import { CreateBookDto } from "./create-book.dto";

export class UpdateBookDto extends PartialType(CreateBookDto) {}
