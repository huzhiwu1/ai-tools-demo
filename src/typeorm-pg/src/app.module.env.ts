import 'dotenv/config';
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConversationsModule } from './conversations/conversations.module';
import { User } from './conversations/entities/user.entity';
import { Conversation } from './conversations/entities/conversation.entity';
import { Message } from './conversations/entities/message.entity';

/**
 * [环境变量版根模块]
 *
 * 职责：使用 .env 管理数据库连接与端口，避免密码硬编码
 *
 * 关键细节：
 * - 必须确保 dotenv/config 最先加载，process.env 才能读到值
 * - synchronize 仅用于开发，生产环境请关闭并使用 migration
 */
@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT) || 5432,
      username: process.env.DB_USERNAME || 'user',
      password: process.env.DB_PASSWORD || '123456',
      database: process.env.DB_DATABASE || 'hello_pg',
      synchronize: true,
      logging: true,
      entities: [User, Conversation, Message],
    }),
    ConversationsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModuleEnv {}
