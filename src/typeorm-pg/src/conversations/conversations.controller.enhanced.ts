import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ConversationsServiceEnhanced } from './conversations.service.enhanced';
import { SemanticSearchDto } from './dto/semantic-search.dto';
import { CreateMessageDto } from './dto/create-message.dto';

/**
 * [增强版 Controller]
 *
 * 职责：暴露会话相关的 REST 接口
 *
 * 接口清单：
 * 1. GET  /conversations/users/:userId      查询用户会话列表
 * 2. GET  /conversations/:id/messages       查询会话消息列表
 * 3. POST /conversations/messages           写入消息（自动生成向量）
 * 4. POST /conversations/:id/search         会话内语义检索
 */
@Controller('conversations')
export class ConversationsControllerEnhanced {
  constructor(
    private readonly conversationsService: ConversationsServiceEnhanced,
  ) {}

  @Get('users/:userId')
  findByUser(@Param('userId', ParseIntPipe) userId: number) {
    return this.conversationsService.findConversationsByUserId(userId);
  }

  @Get(':id/messages')
  findMessages(@Param('id', ParseIntPipe) id: number) {
    return this.conversationsService.findMessagesByConversationId(id);
  }

  @Post('messages')
  createMessage(@Body() dto: CreateMessageDto) {
    return this.conversationsService.createMessage(dto);
  }

  @Post(':id/search')
  search(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SemanticSearchDto,
    @Query('limit', new DefaultValuePipe(5), ParseIntPipe) queryLimit?: number,
  ) {
    const limit = dto.limit ?? queryLimit ?? 5;
    return this.conversationsService.searchSimilarMessages(
      id,
      dto.query,
      limit,
    );
  }
}
