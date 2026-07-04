import { IsNotEmpty, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
export class CreateUserDto {
  @ApiProperty({ example: 'Alice', description: '用户名称' })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  name!: string;
}
