import { IsOptional, IsString, MinLength, IsInt } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
export class SemanticSearchDto {
  @ApiProperty({ example: '向量相似度怎么查', description: '查询内容' })
  @IsString()
  @MinLength(1)
  query!: string;
  @ApiProperty({ example: 5, description: '返回结果数量' })
  @IsOptional()
  @IsInt()
  limit?: number;
}
