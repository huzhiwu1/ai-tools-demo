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
import { ConversationsService } from './conversations.service';
import { SemanticSearchDto } from './dto/semantic-search.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { CreateMessageDto } from './dto/create-message.dto';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

@Controller('conversations')
@ApiTags('会话管理')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @ApiOperation({ summary: '创建用户' })
  @ApiResponse({ status: 201, description: '用户创建成功' })
  @Post('users')
  createUser(@Body() dto: CreateUserDto) {
    return this.conversationsService.createUser(dto);
  }

  @ApiOperation({ summary: '创建会话' })
  @ApiResponse({ status: 201, description: '会话创建成功' })
  @Post('conversations')
  createConversation(@Body() dto: CreateConversationDto) {
    return this.conversationsService.createConversation(dto);
  }

  @ApiOperation({ summary: '创建消息' })
  @ApiResponse({ status: 201, description: '消息创建成功' })
  @Post('messages')
  createMessage(@Body() dto: CreateMessageDto) {
    return this.conversationsService.createMessage(dto);
  }

  @ApiOperation({ summary: '用户会话列表' })
  @ApiResponse({ status: 200, description: '用户会话列表获取成功' })
  /** GET /conversations/users/:userId — 用户的会话列表 */
  @Get('users/:userId')
  findByUser(@Param('userId', ParseIntPipe) userId: number) {
    return this.conversationsService.findConversationsByUserId(userId);
  }

  @ApiOperation({ summary: '会话消息列表' })
  @ApiResponse({ status: 200, description: '会话消息列表获取成功' })
  /** GET /conversations/:id/messages — 会话的消息列表 */
  @Get(':id/messages')
  findMessages(@Param('id', ParseIntPipe) id: number) {
    return this.conversationsService.findMessagesByConversationId(id);
  }

  @ApiOperation({ summary: '会话内语义检索' })
  @ApiResponse({ status: 200, description: '会话内语义检索成功' })
  /** POST /conversations/:id/search — 会话内语义检索 */
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
