import { IsOptional, IsString, MinLength, IsInt } from 'class-validator';

export class SemanticSearchDto {
  @IsString()
  @MinLength(1)
  query!: string;
  @IsOptional()
  @IsInt()
  limit?: number;
}
