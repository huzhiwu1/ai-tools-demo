import { IsEnum, IsInt, IsString, IsNotEmpty } from 'class-validator';
import { MessageRole } from '../entities/message.entity';
import { ApiProperty } from '@nestjs/swagger';

/**
 * [DTO]
 *
 * 职责：定义写入消息时的请求结构
 *
 * 关键细节：
 * - role 使用枚举约束，避免非法值写入
 * - content 为消息正文，写入时会自动调用 Embedding 服务生成向量
 */
export class CreateMessageDto {
  @IsInt()
  @ApiProperty({ example: 1, description: '会话ID' })
  conversationId!: number;
  @IsEnum(MessageRole)
  @ApiProperty({ example: 'user', description: '消息角色' })
  role!: MessageRole;
  @IsString()
  @ApiProperty({ example: 'Hello, how are you?', description: '消息内容' })
  @IsNotEmpty()
  content!: string;
}
