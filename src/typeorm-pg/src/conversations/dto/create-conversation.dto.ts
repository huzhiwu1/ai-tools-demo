import { IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateConversationDto {
  @IsNumber()
  @ApiProperty({ example: 1, description: '用户ID' })
  userId!: number;
  @IsOptional()
  @ApiProperty({ example: 'Conversation Title', description: '会话标题' })
  @IsString()
  @MaxLength(200)
  title?: string;
}
