import 'dotenv/config';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { OpenAIEmbeddings } from '@langchain/openai';
import { EntityManager } from 'typeorm';
import { User } from './entities/user.entity';
import { Conversation } from './entities/conversation.entity';
import { Message } from './entities/message.entity';
import { CreateMessageDto } from './dto/create-message.dto';

/**
 * [增强版 Service]
 *
 * 职责：管理用户、会话、消息的查询与写入，并集成 Embedding 实现语义检索
 *
 * 流程：
 * 1. 通过 EntityManager 执行类型化查询
 * 2. 写入消息时调用 Embedding 服务生成向量
 * 3. 语义检索时使用 pgvector 余弦距离排序
 */
export interface SemanticSearchResult {
  id: number;
  conversation_id: number;
  role: string;
  content: string;
  created_at: Date;
  similarity: number;
}

@Injectable()
export class ConversationsServiceEnhanced {
  private embeddings: OpenAIEmbeddings | null = null;

  constructor(
    @InjectEntityManager()
    private readonly em: EntityManager,
  ) {}

  /** 查询某用户的全部会话（一对多） */
  async findConversationsByUserId(userId: number) {
    const user = await this.em.findOne(User, {
      where: { id: userId },
      relations: { conversations: true },
      order: { conversations: { createdAt: 'DESC' } },
    });

    if (!user) {
      throw new NotFoundException(`User #${userId} not found`);
    }

    return user;
  }

  /** 查询某会话的全部消息（一对多） */
  async findMessagesByConversationId(conversationId: number) {
    const conversation = await this.em.findOne(Conversation, {
      where: { id: conversationId },
      relations: { messages: true },
      order: { messages: { createdAt: 'ASC' } },
    });

    if (!conversation) {
      throw new NotFoundException(`Conversation #${conversationId} not found`);
    }

    return {
      id: conversation.id,
      userId: conversation.userId,
      title: conversation.title,
      createdAt: conversation.createdAt,
      messages: conversation.messages.map(
        ({ id, conversationId, role, content, createdAt }) => ({
          id,
          conversationId,
          role,
          content,
          createdAt,
        }),
      ),
    };
  }

  /** 写入消息并自动生成 Embedding 向量 */
  async createMessage(dto: CreateMessageDto) {
    const conversation = await this.em.findOne(Conversation, {
      where: { id: dto.conversationId },
    });

    if (!conversation) {
      throw new NotFoundException(
        `Conversation #${dto.conversationId} not found`,
      );
    }

    const embedding = await this.embedQuery(dto.content);

    const message = this.em.create(Message, {
      ...dto,
      embedding,
    });

    return this.em.save(message);
  }

  /** 会话内语义检索（pgvector 余弦距离） */
  async searchSimilarMessages(
    conversationId: number,
    searchText: string,
    limit = 5,
  ): Promise<SemanticSearchResult[]> {
    const conversation = await this.em.findOne(Conversation, {
      where: { id: conversationId },
    });

    if (!conversation) {
      throw new NotFoundException(`Conversation #${conversationId} not found`);
    }

    const vector = await this.embedQuery(searchText);

    const rows: SemanticSearchResult[] = await this.em.query(
      `SELECT id, conversation_id, role, content, created_at,
              1 - (embedding <=> $1::vector) AS similarity
       FROM messages
       WHERE conversation_id = $2 AND embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT $3`,
      [JSON.stringify(vector), conversationId, limit],
    );

    return rows.map((row) => ({
      ...row,
      similarity: Number(row.similarity),
    }));
  }

  private getEmbeddings(): OpenAIEmbeddings {
    if (!this.embeddings) {
      if (!process.env.OPENAI_API_KEY) {
        throw new BadRequestException('语义检索需要配置 OPENAI_API_KEY');
      }
      this.embeddings = new OpenAIEmbeddings({
        model: process.env.EMBEDDING_MODEL || 'text-embedding-v3',
        apiKey: process.env.OPENAI_API_KEY,
        configuration: {
          baseURL: process.env.OPENAI_BASE_URL,
        },
      });
    }
    return this.embeddings;
  }

  private async embedQuery(text: string): Promise<number[]> {
    return this.getEmbeddings().embedQuery(text);
  }
}
