/**
 * 【第三站 - DTO】CreateBookDto
 *
 * 职责：
 *   定义"创建图书"接口的请求体数据结构。
 *
 * 知识扩展：
 *   - DTO（Data Transfer Object）= 数据传输对象，用来描述跨边界传输的数据结构。
 *   - 在 Nest 里，DTO 通常配合 class-validator + ValidationPipe 做参数校验。
 *   - 这里为简化教学保持空类，正式项目应加上 @IsString() / @IsNotEmpty() 等装饰器。
 */
export class CreateBookDto {
  // 示例：实际项目可加 @IsString() title: string;
}
