# NestJS + PostgreSQL + AI 渐进式实战教程

> 目标：从零搭建一个基于 NestJS + TypeORM + PostgreSQL(pgvector) 的会话管理后端，并集成 OpenAI Embedding 实现消息语义检索。
>
> 预计时间：2 ~ 3 小时（含环境搭建）
> 前置知识：TypeScript 基础、HTTP 基础、SQL 基础

---

## 目录

1. [项目概述](#1-项目概述)
2. [你将学到什么](#2-你将学到什么)
3. [环境与依赖](#3-环境与依赖)
4. [任务总览](#4-任务总览)
5. [Task 01：初始化 NestJS 项目](#task-01初始化-nestjs-项目)
6. [Task 02：启动 PostgreSQL 并启用 pgvector](#task-02启动-postgresql-并启用-pgvector)
7. [Task 03：用 TypeORM 连接数据库](#task-03用-typeorm-连接数据库)
8. [Task 04：设计实体模型](#task-04设计实体模型)
9. [Task 05：实现基础 CRUD](#task-05实现基础-crud)
10. [Task 06：接入 OpenAI Embedding](#task-06接入-openai-embedding)
11. [Task 07：实现会话内语义搜索](#task-07实现会话内语义搜索)
12. [Task 08：验证与调优](#task-08验证与调优)
13. [扩展：把数据库配置迁移到环境变量](#扩展把数据库配置迁移到环境变量)
14. [常见问题](#常见问题)
15. [下一步](#下一步)

---

## 配套代码说明

本教程对应项目目录为 `src/typeorm-pg`，其中包含以下关键文件：

| 文件                                                     | 说明                                       |
| -------------------------------------------------------- | ------------------------------------------ |
| `src/app.module.ts`                                      | 原示例：硬编码数据库连接                   |
| `src/app.module.env.ts`                                  | 增强示例：使用 `.env` 管理数据库配置       |
| `src/conversations/conversations.service.ts`             | 原示例：仅含查询与语义检索                 |
| `src/conversations/conversations.service.enhanced.ts`    | 增强示例：新增消息写入并自动生成 Embedding |
| `src/conversations/conversations.controller.ts`          | 原示例：仅含 GET 接口                      |
| `src/conversations/conversations.controller.enhanced.ts` | 增强示例：新增 POST /messages 与语义搜索   |
| `src/conversations/dto/create-message.dto.ts`            | 新增：写入消息请求体 DTO                   |
| `.env.example`                                           | 环境变量模板                               |

建议学习顺序：先按原示例跑通查询，再参考增强示例补齐写入能力。

---

## 1. 项目概述

本项目实现一个简化版的"AI 会话管理"系统：

- 一个 `User` 可以拥有多条 `Conversation`（一对多）。
- 一条 `Conversation` 可以包含多条 `Message`（一对多）。
- 每条 `Message` 在写入时，通过 OpenAI Embedding 模型生成 1024 维向量，存入 PostgreSQL 的 `vector` 类型字段。
- 通过 `POST /conversations/:id/search` 接口，使用余弦相似度在指定会话内检索最相关的消息。

核心接口：

| 方法 | 路径                           | 说明                 |
| ---- | ------------------------------ | -------------------- |
| GET  | `/conversations/users/:userId` | 查询某用户的全部会话 |
| GET  | `/conversations/:id/messages`  | 查询某会话的全部消息 |
| POST | `/conversations/:id/search`    | 会话内语义检索       |

---

## 2. 你将学到什么

- 使用 NestJS CLI 初始化项目并理解模块结构。
- 使用 TypeORM 与 PostgreSQL 建立连接，开启 `synchronize` 自动建表。
- 用装饰器定义 Entity、关系（`@OneToMany` / `@ManyToOne`）、枚举、向量字段。
- 使用 `EntityManager` 编写类型化查询与原生 SQL。
- 使用 `@langchain/openai` 调用 Embedding 模型并生成向量。
- 使用 `pgvector` 的 `<=>` 操作符计算余弦距离，实现语义检索。
- 使用 `.env` 管理敏感配置，避免硬编码。

---

## 3. 环境与依赖

### 3.1 本地环境

- Node.js >= 20（推荐 22 LTS）
- pnpm >= 9（也可用 npm / yarn）
- PostgreSQL >= 15，且已安装 `pgvector` 扩展
- 一个可用的 OpenAI 兼容 Embedding 服务（本示例使用阿里云百炼 / DashScope 兼容模式）

### 3.2 关键依赖版本

```json
{
  "@nestjs/common": "^11.0.1",
  "@nestjs/core": "^11.0.1",
  "@nestjs/platform-express": "^11.0.1",
  "@nestjs/typeorm": "^11.0.1",
  "@langchain/openai": "^1.4.7",
  "typeorm": "^0.3.20",
  "pg": "^8.21.0",
  "dotenv": "^17.4.2"
}
```

> 注意：原示例 `package.json` 中 `typeorm` 写为 `^1.0.0`，这是不存在的版本，实际应使用 `^0.3.20`。

---

## 4. 任务总览

| 任务    | 主题                                    | 难度 | 产出                             |
| ------- | --------------------------------------- | ---- | -------------------------------- |
| Task 01 | 初始化 NestJS 项目                      | 入门 | 可运行的空项目                   |
| Task 02 | 启动 PostgreSQL + pgvector              | 入门 | 本地数据库实例                   |
| Task 03 | TypeORM 连接数据库                      | 入门 | 连接成功、可自动同步表结构       |
| Task 04 | 设计 User / Conversation / Message 实体 | 中等 | 三张表及关系                     |
| Task 05 | 基础 CRUD（查询）                       | 中等 | 两个 GET 接口                    |
| Task 06 | 接入 OpenAI Embedding                   | 中等 | 消息写入时自动生成向量           |
| Task 07 | 会话内语义搜索                          | 较难 | `POST /conversations/:id/search` |
| Task 08 | 验证与调优                              | 入门 | curl 测试、性能观察              |

---

## Task 01：初始化 NestJS 项目

### 目标

使用官方 CLI 创建项目骨架，理解默认目录。

### 步骤

1. 安装 NestJS CLI（全局只需一次）：

```bash
pnpm add -g @nestjs/cli
```

2. 创建项目：

```bash
nest new typeorm-pg-crud --strict
# 提示选择包管理器时选 pnpm
cd typeorm-pg-crud
```

3. 观察生成的目录：

```text
typeorm-pg-crud/
├── src/
│   ├── app.controller.ts
│   ├── app.module.ts
│   ├── app.service.ts
│   └── main.ts
├── test/
├── package.json
├── tsconfig.json
└── nest-cli.json
```

4. 启动验证：

```bash
pnpm run start:dev
```

浏览器访问 `http://localhost:3000`，应看到 `Hello World!`。

### 关键概念

- `AppModule`：根模块，所有子模块最终都要导入这里。
- `main.ts`：入口文件，负责创建 Nest 应用并监听端口。
- `@nestjs/platform-express`：默认基于 Express 的 HTTP 适配器。

---

## Task 02：启动 PostgreSQL 并启用 pgvector

### 目标

准备一个带 `pgvector` 扩展的 PostgreSQL 实例。

### 方式 A：使用 Docker（推荐）

```bash
docker run -d \
  --name pg-vector \
  -e POSTGRES_USER=user \
  -e POSTGRES_PASSWORD=123456 \
  -e POSTGRES_DB=hello_pg \
  -p 5432:5432 \
  pgvector/pgvector:pg17
```

各参数含义：

| 参数                       | 说明                                                             |
| -------------------------- | ---------------------------------------------------------------- |
| `--name pg-vector`         | 容器名，方便后续 `docker exec` 进入                              |
| `POSTGRES_USER=user`       | 数据库用户名，和 `.env` 中 `DB_USERNAME` 对应                    |
| `POSTGRES_PASSWORD=123456` | 密码，和 `DB_PASSWORD` 对应                                      |
| `POSTGRES_DB=hello_pg`     | 自动创建的库名，和 `DB_DATABASE` 对应                            |
| `-p 5432:5432`             | 映射到宿主机 5432 端口                                           |
| `pgvector/pgvector:pg17`   | 官方 pgvector 镜像，基于 PostgreSQL 17，自带 vector 扩展编译产物 |

#### 常用运维命令

```bash
# 停止
docker stop pg-vector

# 启动（已创建过的容器）
docker start pg-vector

# 删除重来
docker rm -f pg-vector
```

### 方式 B：使用本地 PostgreSQL

1. 安装 `pgvector` 扩展（Windows 可参考其官方 README，或使用 WSL2 + Docker）。
2. 创建数据库：

```sql
CREATE DATABASE hello_pg;
\c hello_pg;
CREATE EXTENSION IF NOT EXISTS vector;
```

### 验证

```bash
# 确认容器在运行
docker ps | grep pg-vector

# 确认 pgvector 扩展可用
docker exec -it pg-vector psql -U user -d hello_pg -c "SELECT * FROM pg_extension WHERE extname = 'vector';"
```

看到 `vector` 记录即成功。

### 知识扩展：pgvector 镜像 vs 普通 postgres 镜像

`pgvector/pgvector:pg17` 镜像和普通 `postgres:17` 的区别是——它在镜像构建时已经把 `vector` 扩展的编译产物装好了，但**扩展不会自动启用**。TypeORM 的 `synchronize: true` 会自动建表，但不会自动 `CREATE EXTENSION`。如果后续报错 `type "vector" does not exist`，需要手动执行：

```bash
docker exec -it pg-vector psql -U user -d hello_pg -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

---

## Task 03：用 TypeORM 连接数据库

### 目标

安装数据库依赖，并在 `AppModule` 中配置 TypeORM。

### 步骤

1. 安装依赖：

```bash
pnpm add @nestjs/typeorm typeorm pg dotenv
pnpm add -D @types/node
```

2. 编辑 `src/app.module.ts`：

```typescript
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: 'localhost',
      port: 5432,
      username: 'user',
      password: '123456',
      database: 'hello_pg',
      synchronize: true,
      logging: true,
      entities: [], // 稍后填入实体
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
```

3. 启动项目：

```bash
pnpm run start:dev
```

若控制台没有报错，且能看到 TypeORM 连接日志，即成功。

### 关键参数说明

| 参数                | 说明                                                       |
| ------------------- | ---------------------------------------------------------- |
| `synchronize: true` | 开发时自动根据实体同步表结构。生产环境建议关闭，改用迁移。 |
| `logging: true`     | 打印所有 SQL，便于调试。                                   |
| `entities: []`      | 需要 TypeORM 扫描的实体类数组。                            |

---

## Task 04：设计实体模型

### 目标

定义 `User`、`Conversation`、`Message` 三个实体，并建立关系。

### 实体关系图

```text
User 1 --- * Conversation 1 --- * Message
```

### User 实体

创建 `src/conversations/entities/user.entity.ts`：

```typescript
import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Conversation } from './conversation.entity';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'text' })
  name: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @OneToMany(() => Conversation, (conversation) => conversation.user)
  conversations: Conversation[];
}
```

### Conversation 实体

创建 `src/conversations/entities/conversation.entity.ts`：

```typescript
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from './user.entity';
import { Message } from './message.entity';

@Entity('conversations')
export class Conversation {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'user_id' })
  userId: number;

  @Column({ type: 'text', nullable: true })
  title: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @ManyToOne(() => User, (user) => user.conversations, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @OneToMany(() => Message, (message) => message.conversation)
  messages: Message[];
}
```

### Message 实体

创建 `src/conversations/entities/message.entity.ts`：

```typescript
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Conversation } from './conversation.entity';

export enum MessageRole {
  USER = 'user',
  ASSISTANT = 'assistant',
  SYSTEM = 'system',
}

@Entity('messages')
export class Message {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'conversation_id' })
  conversationId: number;

  @Column({
    type: 'text',
    enum: MessageRole,
  })
  role: MessageRole;

  @Column({ type: 'text' })
  content: string;

  @Column('vector', { length: 1024, nullable: true })
  embedding: number[] | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @ManyToOne(() => Conversation, (conversation) => conversation.messages, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'conversation_id' })
  conversation: Conversation;
}
```

### 要点解析

- `@PrimaryGeneratedColumn()`：自增主键。
- `@Column('vector', { length: 1024 })`：`pgvector` 提供的向量类型，`length` 为维度。本示例使用 `text-embedding-v3` 输出 1024 维。
- `@CreateDateColumn`：自动记录创建时间。
- `@OneToMany` / `@ManyToOne`：建立一对多关系，`onDelete: 'CASCADE'` 表示父表删除时级联删除子表记录。

### 注册实体

修改 `src/app.module.ts`，在 `entities` 数组中注册三个实体：

```typescript
import { User } from './conversations/entities/user.entity';
import { Conversation } from './conversations/entities/conversation.entity';
import { Message } from './conversations/entities/message.entity';

// ...
entities: [User, Conversation, Message],
```

重启后，TypeORM 会自动创建 `users`、`conversations`、`messages` 三张表。

---

## Task 05：实现基础 CRUD

### 目标

实现两个查询接口：

- `GET /conversations/users/:userId`
- `GET /conversations/:id/messages`

### 5.1 创建模块

```bash
nest g module conversations
nest g controller conversations
nest g service conversations
```

### 5.2 编写 Service

编辑 `src/conversations/conversations.service.ts`：

```typescript
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';
import { User } from './entities/user.entity';
import { Conversation } from './entities/conversation.entity';

@Injectable()
export class ConversationsService {
  constructor(
    @InjectEntityManager()
    private readonly em: EntityManager,
  ) {}

  /** 查询某用户的全部会话 */
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

  /** 查询某会话的全部消息 */
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
}
```

### 5.3 编写 Controller

编辑 `src/conversations/conversations.controller.ts`：

```typescript
import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { ConversationsService } from './conversations.service';

@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Get('users/:userId')
  findByUser(@Param('userId', ParseIntPipe) userId: number) {
    return this.conversationsService.findConversationsByUserId(userId);
  }

  @Get(':id/messages')
  findMessages(@Param('id', ParseIntPipe) id: number) {
    return this.conversationsService.findMessagesByConversationId(id);
  }
}
```

### 5.4 注册模块

`src/conversations/conversations.module.ts`：

```typescript
import { Module } from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import { ConversationsController } from './conversations.controller';

@Module({
  controllers: [ConversationsController],
  providers: [ConversationsService],
})
export class ConversationsModule {}
```

并在 `src/app.module.ts` 中导入：

```typescript
import { ConversationsModule } from './conversations/conversations.module';

@Module({
  imports: [
    TypeOrmModule.forRoot({ /* ... */ }),
    ConversationsModule,
  ],
})
```

### 5.5 准备测试数据

由于当前示例只实现了查询，需要手动插入几条数据验证：

```sql
INSERT INTO users (name) VALUES ('Alice') RETURNING id;
-- 假设返回 id = 1

INSERT INTO conversations (user_id, title) VALUES (1, 'AI 学习笔记');
-- 假设返回 id = 1

INSERT INTO messages (conversation_id, role, content) VALUES
  (1, 'user', 'PostgreSQL 支持哪些数据类型'),
  (1, 'assistant', 'PostgreSQL 支持数值、字符串、日期、数组、JSONB、几何类型等，还可以通过扩展支持 vector 类型。'),
  (1, 'user', '向量相似度怎么查'),
  (1, 'assistant', '可以使用 pgvector 扩展，通过 embedding <=> query_vector 计算余弦距离。');
```

### 5.6 验证

```bash
curl -s http://localhost:3005/conversations/users/1 | jq
curl -s http://localhost:3005/conversations/1/messages | jq
```

---

## Task 06：接入 OpenAI Embedding

### 目标

在写入消息时自动生成向量。本任务先封装 Embedding 能力，Task 07 再调用它。

### 6.1 安装依赖

```bash
pnpm add @langchain/openai
```

### 6.2 配置环境变量

创建 `.env.example`：

```text
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
OPENAI_API_KEY=sk-xx
EMBEDDING_MODEL=text-embedding-v3
```

复制为 `.env` 并填入真实 API Key。

### 6.3 封装 Embedding Client

在 `src/conversations/conversations.service.ts` 中添加：

```typescript
import 'dotenv/config';
import { OpenAIEmbeddings } from '@langchain/openai';

export class ConversationsService {
  private embeddings: OpenAIEmbeddings | null = null;

  // ... constructor ...

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
```

### 6.4 增加写入消息方法（可选增强）

为了让项目更完整，我们补充一个写入消息的方法。完整实现可参考 `src/conversations/conversations.service.enhanced.ts` 与 `src/conversations/conversations.controller.enhanced.ts`。

创建 DTO `src/conversations/dto/create-message.dto.ts`：

```typescript
import { MessageRole } from '../entities/message.entity';

export class CreateMessageDto {
  conversationId: number;
  role: MessageRole;
  content: string;
}
```

在 Service 中增加：

```typescript
import { CreateMessageDto } from './dto/create-message.dto';
import { Message } from './entities/message.entity';

async createMessage(dto: CreateMessageDto) {
  const conversation = await this.em.findOne(Conversation, {
    where: { id: dto.conversationId },
  });

  if (!conversation) {
    throw new NotFoundException(`Conversation #${dto.conversationId} not found`);
  }

  const embedding = await this.embedQuery(dto.content);

  const message = this.em.create(Message, {
    ...dto,
    embedding,
  });

  return this.em.save(message);
}
```

Controller 中增加：

```typescript
import { Body, Post } from '@nestjs/common';
import { CreateMessageDto } from './dto/create-message.dto';

@Post('messages')
createMessage(@Body() dto: CreateMessageDto) {
  return this.conversationsService.createMessage(dto);
}
```

这样每次写入消息都会自动调用 Embedding 接口并存储向量。

---

## Task 07：实现会话内语义搜索

### 目标

实现 `POST /conversations/:id/search`，根据查询文本返回最相关的消息。

### 7.1 创建 DTO

`src/conversations/dto/semantic-search.dto.ts`：

```typescript
export class SemanticSearchDto {
  query: string;
  limit?: number;
}
```

### 7.2 实现 Service

在 `src/conversations/conversations.service.ts` 中增加：

```typescript
export interface SemanticSearchResult {
  id: number;
  conversation_id: number;
  role: string;
  content: string;
  created_at: Date;
  similarity: number;
}

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
```

### 7.3 实现 Controller

```typescript
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
import { CreateMessageDto } from './dto/create-message.dto';

@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

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
```

### 7.4 SQL 解析

```sql
SELECT id, conversation_id, role, content, created_at,
       1 - (embedding <=> $1::vector) AS similarity
FROM messages
WHERE conversation_id = $2 AND embedding IS NOT NULL
ORDER BY embedding <=> $1::vector
LIMIT $3
```

- `embedding <=> $1::vector`：`pgvector` 的"余弦距离"操作符，范围 `[0, 2]`，值越小越相似。
- `1 - distance`：转换为"相似度"，范围 `[-1, 1]`，越接近 1 越相似。
- `JSON.stringify(vector)`：TypeORM 把数组参数化为 JSON 字符串，PostgreSQL 再 cast 为 `vector`。

---

## Task 08：验证与调优

### 8.1 写入带向量的消息

```bash
curl -s -X POST http://localhost:3005/conversations/messages \
  -H 'Content-Type: application/json' \
  -d '{
    "conversationId": 1,
    "role": "user",
    "content": "PostgreSQL 支持向量检索吗"
  }' | jq
```

### 8.2 语义搜索

```bash
curl -s -X POST http://localhost:3005/conversations/1/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"向量相似度怎么查","limit":3}' | jq
```

预期返回结构：

```json
[
  {
    "id": 4,
    "conversation_id": 1,
    "role": "assistant",
    "content": "可以使用 pgvector 扩展，通过 embedding <=> query_vector 计算余弦距离。",
    "created_at": "2026-06-30T12:00:00.000Z",
    "similarity": 0.8231
  }
]
```

### 8.3 性能调优建议

1. **向量索引**：消息量大时，为 `embedding` 字段建 IVFFlat 或 HNSW 索引。

```sql
CREATE INDEX idx_messages_embedding
ON messages
USING hnsw (embedding vector_cosine_ops);
```

2. **限制维度**：若 Embedding 模型支持，可选择 384 维模型减少存储与计算。
3. **批量生成向量**：写入历史数据时，使用批量 Embedding API（`embedDocuments`）降低调用次数。
4. **过滤优先**：先按 `conversation_id` 过滤，再计算向量距离，避免全表扫描。

---

## 扩展：把数据库配置迁移到环境变量

生产环境不应把数据库密码硬编码在 `app.module.ts` 中。项目已提供参考实现 `src/app.module.env.ts`，推荐做法如下：

1. 在 `.env` 中增加：

```text
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=user
DB_PASSWORD=123456
DB_DATABASE=hello_pg
```

2. 修改 `src/app.module.ts`：

```typescript
import 'dotenv/config';

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
```

3. 确保 `main.ts` 或 `app.module.ts` 顶部最先执行 `import 'dotenv/config';`。

---

## 常见问题

### Q1：启动报错 `typeorm` 找不到版本？

检查 `package.json` 中 `typeorm` 版本，应为 `^0.3.20`，不是 `^1.0.0`。

### Q2：报错 `type \"vector\" does not exist`

确认数据库已启用 `pgvector` 扩展：

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### Q3：写入消息时 Embedding 接口报错

- 检查 `.env` 中 `OPENAI_API_KEY` 是否配置。
- 检查 `OPENAI_BASE_URL` 是否支持 `/embeddings` 端点。
- 检查模型名称是否与服务端匹配（如 `text-embedding-v3`）。

### Q4：语义搜索结果为空

- 确认消息记录的 `embedding` 字段不为 NULL。
- 确认查询的 `conversationId` 存在且有消息。
- 确认 `pgvector` 扩展版本支持 `<=>` 操作符。

### Q5：TypeORM `synchronize: true` 是否适合生产？

不适合。生产环境应使用迁移脚本（`typeorm migration`）管理 schema 变更。

---

## 下一步

- 为接口添加 `class-validator` 校验 DTO 字段。
- 使用 `@nestjs/config` 替代 `dotenv` 进行配置管理。
- 引入 Swagger 自动生成 API 文档。
- 添加单元测试与 e2e 测试。
- 把 Embedding 生成改为异步队列（如 BullMQ），降低接口响应时间。
- 引入 LangChain Chat Model，实现真正的 AI 对话能力。

---

_本文档基于 typeorm-pg-crud 示例整理，可根据实际学习进度拆分完成。_
