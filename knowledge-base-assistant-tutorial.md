# 智能知识库助手 — 渐进式教程

> 本教程将带你从零构建一个完整的 AI Agent 知识库助手，共六个阶段，每个阶段都有可验证的里程碑。
> 每个步骤包含：代码示例 → 关键流程讲解 → 知识点扩展。

---

## 阶段一：基础架构搭建

### 学习目标

- 掌握 NestJS 项目初始化与模块化组织
- 理解 Docker Compose 编排多服务的方式
- 掌握 NestJS 连接 MySQL 和 Milvus 的模式

---

### 步骤 1.1：创建 NestJS 项目

**操作**

```bash
mkdir -p knowledge-base-assistant && cd knowledge-base-assistant
npx @nestjs/cli new server --package-manager pnpm --skip-git
cd server
pnpm add @nestjs/config @nestjs/platform-express mysql2 @zilliz/milvus2-sdk-node
pnpm add @langchain/core @langchain/openai @langchain/textsplitters zod dotenv
```

**目录结构**

```
server/src/
├── app.module.ts
├── main.ts
├── common/
│   └── config/
│       └── configuration.ts
├── database/
│   ├── database.module.ts
│   └── database.service.ts
├── milvus/
│   ├── milvus.module.ts
│   └── milvus.service.ts
├── documents/
│   └── ...（阶段二填充）
└── chat/
    └── ...（阶段四填充）
```

**验证**：`pnpm start:dev` 能启动，看到 `Nest application successfully started`

**知识扩展：NestJS 模块化思想**

NestJS 的核心是模块（Module），每个业务领域一个模块。模块之间通过 `imports` 和 `exports` 建立依赖。好处是：
- 职责清晰：DatabaseModule 只管数据库，MilvusModule 只管向量库
- 可测试：每个模块可以独立 mock 依赖
- 可复用：MilvusModule 被 DocumentsModule 和 ChatModule 共同使用

---

### 步骤 1.2：Docker Compose 新增 MySQL

在 `knowledge-base-assistant/` 下创建 `docker-compose.yml`：

```yaml
version: '3.5'

services:
  # 复用现有 Milvus 服务（从 milvus-standalone-docker-compose.yml 复制）
  etcd:
    container_name: milvus-etcd
    image: quay.io/coreos/etcd:v3.5.25
    environment:
      - ETCD_AUTO_COMPACTION_MODE=revision
      - ETCD_AUTO_COMPACTION_RETENTION=1000
      - ETCD_QUOTA_BACKEND_BYTES=4294967296
    volumes:
      - ./volumes/etcd:/etcd
    command: etcd -advertise-client-urls=http://etcd:2379 -listen-client-urls http://0.0.0.0:2379 --data-dir /etcd
    healthcheck:
      test: ["CMD", "etcdctl", "endpoint", "health"]
      interval: 30s
      timeout: 20s
      retries: 3

  minio:
    container_name: milvus-minio
    image: minio/minio:RELEASE.2024-12-18T13-15-44Z
    environment:
      MINIO_ACCESS_KEY: minioadmin
      MINIO_SECRET_KEY: minioadmin
    ports:
      - "9001:9001"
      - "9000:9000"
    volumes:
      - ./volumes/minio:/minio_data
    command: minio server /minio_data --console-address ":9001"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 30s
      timeout: 20s
      retries: 3

  standalone:
    container_name: milvus-standalone
    image: milvusdb/milvus:v2.6.13
    command: ["milvus", "run", "standalone"]
    security_opt:
      - seccomp:unconfined
    environment:
      ETCD_ENDPOINTS: etcd:2379
      MINIO_ADDRESS: minio:9000
      MQ_TYPE: woodpecker
    volumes:
      - ./volumes/milvus:/var/lib/milvus
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9091/healthz"]
      interval: 30s
      start_period: 90s
      timeout: 20s
      retries: 3
    ports:
      - "19530:19530"
      - "9091:9091"
    depends_on:
      - "etcd"
      - "minio"

  # 新增 MySQL 服务
  mysql:
    container_name: knowledge-base-mysql
    image: mysql:8
    environment:
      MYSQL_ROOT_PASSWORD: "123456"
      MYSQL_DATABASE: knowledge_base
    ports:
      - "3306:3306"
    volumes:
      - ./volumes/mysql:/var/lib/mysql
    # 注意：MySQL 8 不用 default-authentication-plugin，已废弃
    command: --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci

networks:
  default:
    name: milvus
```

**启动**

```bash
cd knowledge-base-assistant
docker compose up -d
# 等待所有服务 healthy
docker compose ps
```

**知识扩展：MySQL 8 的认证方式**

MySQL 8 默认使用 `caching_sha2_password`，比旧的 `mysql_native_password` 更安全。如果在连接时遇到 `ER_NOT_SUPPORTED_AUTH_MODE` 错误，不要回退到旧认证方式，而是确保 `mysql2` 驱动版本 >= 3.0（本项目用的 3.22.3，已支持）。

---

### 步骤 1.3：NestJS 连接 MySQL

**环境变量配置** `server/.env`

```env
# LLM
MODEL_NAME=qwen-plus
BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
API_KEY=sk-xxx

# Embedding
EMBEDDINGS_MODEL_NAME=text-embedding-v3
EMBEDDINGS_DIMENSIONS=1024

# Milvus
MILVUS_ADDRESS=127.0.0.1:19530

# MySQL
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=123456
MYSQL_DATABASE=knowledge_base

# 切分配置
CHUNK_SIZE=500
CHUNK_OVERLAP=50

# Agent
MAX_STEPS=5
TOOL_TIMEOUT=5000
```

**配置模块** `server/src/common/config/configuration.ts`

```typescript
/**
 * 配置模块
 *
 * 职责：统一管理环境变量，提供类型安全的配置访问
 *
 * 关键细节：
 * - 使用 @nestjs/config 的 registerAs 模式，按命名空间分组
 * - 所有配置项都有默认值，防止 undefined
 */
export default () => ({
  llm: {
    modelName: process.env.MODEL_NAME || 'qwen-plus',
    baseUrl: process.env.BASE_URL,
    apiKey: process.env.API_KEY,
  },
  embedding: {
    modelName: process.env.EMBEDDINGS_MODEL_NAME || 'text-embedding-v3',
    dimensions: parseInt(process.env.EMBEDDINGS_DIMENSIONS || '1024', 10),
  },
  milvus: {
    address: process.env.MILVUS_ADDRESS || '127.0.0.1:19530',
  },
  mysql: {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: parseInt(process.env.MYSQL_PORT || '3306', 10),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '123456',
    database: process.env.MYSQL_DATABASE || 'knowledge_base',
  },
  chunk: {
    size: parseInt(process.env.CHUNK_SIZE || '500', 10),
    overlap: parseInt(process.env.CHUNK_OVERLAP || '50', 10),
  },
  agent: {
    maxSteps: parseInt(process.env.MAX_STEPS || '5', 10),
    toolTimeout: parseInt(process.env.TOOL_TIMEOUT || '5000', 10),
  },
});
```

**数据库服务** `server/src/database/database.service.ts`

```typescript
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mysql from 'mysql2/promise';

/**
 * 数据库服务
 *
 * 职责：管理 MySQL 连接池，提供查询方法
 *
 * 流程：
 * 1. onModuleInit 时创建连接池
 * 2. 提供 query 方法执行参数化查询
 * 3. onModuleDestroy 时关闭连接池
 *
 * 关键细节：
 * - 使用连接池（createPool）而非单连接，避免频繁创建/销毁
 * - 所有查询使用参数化（? 占位符），防止 SQL 注入
 * - finally 中释放连接，防止泄漏
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private pool: mysql.Pool;

  constructor(private configService: ConfigService) {
    this.pool = mysql.createPool({
      host: this.configService.get<string>('mysql.host'),
      port: this.configService.get<number>('mysql.port'),
      user: this.configService.get<string>('mysql.user'),
      password: this.configService.get<string>('mysql.password'),
      database: this.configService.get<string>('mysql.database'),
      connectionLimit: 10,
      charset: 'utf8mb4',
    });
  }

  /** 执行查询（参数化，防注入） */
  async query(sql: string, params?: unknown[]): Promise<any> {
    const conn = await this.pool.getConnection();
    try {
      const [rows] = await conn.query(sql, params);
      return rows;
    } finally {
      conn.release(); // 必须释放，否则连接泄漏
    }
  }

  /** 执行单条插入并返回自增 ID */
  async insert(sql: string, params?: unknown[]): Promise<number> {
    const conn = await this.pool.getConnection();
    try {
      const [result] = await conn.query(sql, params);
      return (result as any).insertId;
    } finally {
      conn.release();
    }
  }

  /** 应用启动时自动建表 */
  async initTables(): Promise<void> {
    await this.query(`
      CREATE TABLE IF NOT EXISTS documents (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        file_path VARCHAR(512) NOT NULL,
        file_type VARCHAR(20) NOT NULL,
        status VARCHAR(20) DEFAULT 'uploading',
        chunk_count INT DEFAULT 0,
        summary TEXT,
        keywords JSON,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id VARCHAR(64) NOT NULL UNIQUE,
        title VARCHAR(255),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id VARCHAR(64) NOT NULL,
        role VARCHAR(20) NOT NULL,
        content TEXT NOT NULL,
        tool_name VARCHAR(64),
        step_index INT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_session (session_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }

  onModuleDestroy() {
    this.pool.end();
  }
}
```

**数据库模块** `server/src/database/database.module.ts`

```typescript
import { Global, Module, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from './database.service';

/**
 * 数据库模块
 *
 * 职责：提供全局数据库连接服务
 *
 * 关键细节：
 * - @Global() 使得 DatabaseService 在所有模块中可用，无需每个模块都 imports
 * - OnModuleInit 时自动建表，开发阶段无需手动执行 SQL
 */
@Global()
@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule implements OnModuleInit {
  constructor(private databaseService: DatabaseService) {}

  async onModuleInit() {
    await this.databaseService.initTables();
  }
}
```

**验证**：启动 NestJS，检查 MySQL 中是否自动创建了 3 张表

```bash
docker exec -it knowledge-base-mysql mysql -uroot -p123456 knowledge_base -e "SHOW TABLES"
```

**知识扩展：为什么用连接池？**

```
无连接池：
请求1 → 创建连接 → 查询 → 关闭连接（耗时约 100ms 建立TCP+认证）
请求2 → 创建连接 → 查询 → 关闭连接（又 100ms）

有连接池：
启动时创建 10 个连接，放入池中
请求1 → 从池中取连接 → 查询 → 归还（0ms 建立开销）
请求2 → 从池中取连接 → 查询 → 归还（0ms 建立开销）
```

连接池本质是"预创建复用"，省去了每次查询的 TCP 三次握手 + MySQL 认证开销。

---

### 步骤 1.4：NestJS 连接 Milvus

**Milvus 服务** `server/src/milvus/milvus.service.ts`

```typescript
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MilvusClient, DataType } from '@zilliz/milvus2-sdk-node';

/**
 * Milvus 向量库服务
 *
 * 职责：管理 Milvus 连接，提供 collection 创建、插入、检索方法
 *
 * 流程：
 * 1. 构造时创建 MilvusClient 连接
 * 2. ensureCollection 确保目标 collection 存在
 * 3. insert 批量插入向量数据
 * 4. search 执行相似度检索
 *
 * 关键细节：
 * - Milvus 字段名使用驼峰（autoId 而非 auto_id），SDK 要求
 * - VARCHAR 字段必须指定 maxLength
 * - IVF_FLAT 索引适合中小规模数据，nlist 控制聚类数
 */
@Injectable()
export class MilvusService implements OnModuleDestroy {
  private client: MilvusClient;
  private collectionName = 'knowledge_chunks';

  constructor(private configService: ConfigService) {
    this.client = new MilvusClient({
      address: this.configService.get<string>('milvus.address'),
    });
  }

  /** 确保 collection 存在，不存在则创建 */
  async ensureCollection(): Promise<void> {
    const has = await this.client.hasCollection({
      collection_name: this.collectionName,
    });

    if (has.value) return;

    await this.client.createCollection({
      collection_name: this.collectionName,
      fields: [
        {
          name: 'id',
          data_type: DataType.Int64,
          is_primary_key: true,
          autoID: true, // 注意：驼峰命名
        },
        {
          name: 'content',
          data_type: DataType.VarChar,
          maxLength: 2048, // VARCHAR 必须指定 maxLength
        },
        {
          name: 'doc_id',
          data_type: DataType.Int64,
        },
        {
          name: 'doc_title',
          data_type: DataType.VarChar,
          maxLength: 255,
        },
        {
          name: 'chunk_index',
          data_type: DataType.Int32,
        },
        {
          name: 'embedding',
          data_type: DataType.FloatVector,
          dim: this.configService.get<number>('embedding.dimensions'),
        },
      ],
    });

    // 创建索引（必须在插入数据前创建，否则无法搜索）
    await this.client.createIndex({
      collection_name: this.collectionName,
      field_name: 'embedding',
      index_type: 'IVF_FLAT',
      metric_type: 'COSINE',
      params: { nlist: 1024 },
    });

    // 加载 collection 到内存（搜索前必须加载）
    await this.client.loadCollection({
      collection_name: this.collectionName,
    });
  }

  /** 插入向量数据 */
  async insert(data: {
    content: string[];
    docId: number[];
    docTitle: string[];
    chunkIndex: number[];
    embedding: number[][];
  }): Promise<void> {
    await this.client.insert({
      collection_name: this.collectionName,
      data: data.content.map((c, i) => ({
        content: c,
        doc_id: data.docId[i],
        doc_title: data.docTitle[i],
        chunk_index: data.chunkIndex[i],
        embedding: data.embedding[i],
      })),
    });
  }

  /** 相似度检索 */
  async search(
    queryEmbedding: number[],
    topK: number = 5,
  ): Promise<Array<{ content: string; docTitle: string; score: number }>> {
    const results = await this.client.search({
      collection_name: this.collectionName,
      vector: queryEmbedding,
      top_k: topK,
      output_fields: ['content', 'doc_title'],
      params: { nprobe: 10 },
    });

    return results.results.map((r) => ({
      content: r.content as string,
      docTitle: r.doc_title as string,
      score: r.score,
    }));
  }

  /** 根据 doc_id 删除所有 chunk */
  async deleteByDocId(docId: number): Promise<void> {
    await this.client.delete({
      collection_name: this.collectionName,
      filter: `doc_id == ${docId}`,
    });
  }

  onModuleDestroy() {
    this.client.closeConnection();
  }
}
```

**Milvus 模块** `server/src/milvus/milvus.module.ts`

```typescript
import { Global, Module, OnModuleInit } from '@nestjs/common';
import { MilvusService } from './milvus.service';

@Global()
@Module({
  providers: [MilvusService],
  exports: [MilvusService],
})
export class MilvusModule implements OnModuleInit {
  constructor(private milvusService: MilvusService) {}

  async onModuleInit() {
    await this.milvusService.ensureCollection();
  }
}
```

**验证**：启动 NestJS，观察日志无 Milvus 连接错误

**知识扩展：IVF_FLAT 索引原理**

```
全量扫描（FLAT）：查询向量与每个向量计算距离 → O(N)，慢但精确
IVF_FLAT：
  1. 建索引时：将所有向量聚为 nlist 个簇（如 1024 个）
  2. 查询时：先找到最近的 nprobe 个簇（如 10 个）
  3. 只在这 10 个簇内做精确搜索 → O(N * nprobe/nlist)，快很多

选择指南：
  数据量 < 10万 → IVF_FLAT 足够
  数据量 > 100万 → 考虑 HNSW（更快的近似搜索）
```

---

### 步骤 1.5：创建 React 前端项目

```bash
cd knowledge-base-assistant
pnpm create vite web --template react-ts
cd web
pnpm install
```

**验证**：`pnpm dev` 能启动，浏览器打开看到 Vite + React 页面

**阶段一里程碑**：后端启动无报错，MySQL 自动建表成功，Milvus collection 创建成功，前端能打开

---

## 阶段二：文档上传与向量化

### 学习目标

- 理解 RAG 系统中"文档入库"的完整链路
- 掌握文件解析 → 文本切分 → Embedding → 向量存储的流程
- 理解 RecursiveCharacterTextSplitter 的切分策略

---

### 步骤 2.1：文档上传接口

**Documents 控制器** `server/src/documents/documents.controller.ts`

```typescript
import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  UploadedFile,
  UseInterceptors,
  ParseIntPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DocumentsService } from './documents.service';

/**
 * 文档管理控制器
 *
 * 职责：处理文档上传、列表、详情、删除的 HTTP 请求
 *
 * 关键细节：
 * - FileInterceptor 处理 multipart/form-data 文件上传
 * - 上传后立即触发异步向量化流程（不阻塞响应）
 */
@Controller('documents')
export class DocumentsController {
  constructor(private documentsService: DocumentsService) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async upload(@UploadedFile() file: Express.Multer.File) {
    // 1. 保存文件记录到 MySQL
    const docId = await this.documentsService.createDocument({
      title: file.originalname,
      filePath: `./uploads/${file.filename}`,
      fileType: file.originalname.split('.').pop(),
    });

    // 2. 异步触发向量化（不阻塞上传响应）
    this.documentsService.vectorizeDocument(docId).catch((err) => {
      console.error(`文档 ${docId} 向量化失败:`, err.message);
    });

    return { id: docId, status: 'uploading' };
  }

  @Get()
  async list() {
    return this.documentsService.listDocuments();
  }

  @Get(':id')
  async detail(@Param('id', ParseIntPipe) id: number) {
    return this.documentsService.getDocument(id);
  }

  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.documentsService.deleteDocument(id);
    return { success: true };
  }
}
```

**知识扩展：为什么向量化是异步的？**

```
同步流程：用户上传 → 解析 → 切分 → embedding → 写入 Milvus → 返回响应
                   ↑ 这可能需要 10-30 秒（embedding API 调用）

异步流程：用户上传 → 保存文件 → 立即返回 { status: "uploading" }
                               → 后台继续向量化
                               → 前端轮询状态变为 "indexed"

好处：用户体验更好，上传后立即得到反馈
```

---

### 步骤 2.2：文件解析服务

`server/src/documents/document-parser.service.ts`

```typescript
import { Injectable } from '@nestjs/common';
import * as fs from 'fs/promises';

/**
 * 文档解析服务
 *
 * 职责：将不同格式的文件解析为纯文本
 *
 * 关键细节：
 * - txt 直接读取
 * - md 去除 markdown 语法标记
 * - pdf 需要安装 pdf-parse（后续扩展）
 * - 解析失败返回空字符串，不抛异常（让后续流程优雅降级）
 */
@Injectable()
export class DocumentParserService {
  /** 将文件解析为纯文本 */
  async parse(filePath: string, fileType: string): Promise<string> {
    const buffer = await fs.readFile(filePath);
    const raw = buffer.toString('utf-8');

    switch (fileType) {
      case 'txt':
        return raw;
      case 'md':
        return this.stripMarkdown(raw);
      default:
        return raw; // 未知类型也尝试读取
    }
  }

  /** 简易 Markdown 清理：去除 # * - 等标记 */
  private stripMarkdown(text: string): string {
    return text
      .replace(/^#{1,6}\s+/gm, '')   // 去除标题标记
      .replace(/\*\*(.*?)\*\*/g, '$1') // 去除加粗
      .replace(/\*(.*?)\*/g, '$1')     // 去除斜体
      .replace(/`([^`]+)`/g, '$1')     // 去除行内代码
      .replace(/```[\s\S]*?```/g, '')  // 去除代码块
      .trim();
  }
}
```

**知识扩展：为什么 Markdown 要清理？**

```
原始 Markdown：
  ## 简介
  本项目使用 **LangChain** 框架，支持 `RAG` 检索。

清理后：
  简介
  本项目使用 LangChain 框架，支持 RAG 检索。

原因：
  1. Markdown 标记对 LLM 理解没有帮助，反而增加 token 消耗
  2. Embedding 模型对纯文本的理解更好
  3. 代码块通常不需要存入知识库（除非是代码问答场景）
```

---

### 步骤 2.3：文本切分服务

`server/src/documents/document-chunker.service.ts`

```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';

/**
 * 文档切分服务
 *
 * 职责：将长文本切分为固定大小的 chunk，用于后续向量化
 *
 * 关键细节：
 * - 使用 RecursiveCharacterTextSplitter 而非简单的按字符切分
 * - chunkOverlap 保证相邻 chunk 有重叠，避免关键信息被截断
 * - 切分顺序：\n\n → \n → 空格 → 字符，优先在段落/句子边界切分
 */
@Injectable()
export class DocumentChunkerService {
  private chunkSize: number;
  private chunkOverlap: number;

  constructor(private configService: ConfigService) {
    this.chunkSize = this.configService.get<number>('chunk.size');
    this.chunkOverlap = this.configService.get<number>('chunk.overlap');
  }

  /** 将文本切分为 chunk 数组 */
  async split(text: string): Promise<string[]> {
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: this.chunkSize,
      chunkOverlap: this.chunkOverlap,
      separators: ['\n\n', '\n', ' ', ''], // 优先在段落边界切分
    });

    const docs = await splitter.splitText(text);
    return docs;
  }
}
```

**知识扩展：RecursiveCharacterTextSplitter 切分原理**

```
输入文本（chunkSize=100, chunkOverlap=20）：

"第一段内容...约100字...\n\n第二段内容...约100字...\n\n第三段..."

切分过程：
1. 先尝试按 \n\n（段落）切分
2. 如果某段 > 100字，再按 \n（换行）切分
3. 如果某行 > 100字，再按空格切分
4. 如果某个词 > 100字，强制按字符切分

结果：
  Chunk 1: "第一段内容...约100字..."
  Chunk 2: "约20字重叠...第二段内容...约80字"  ← 重叠部分
  Chunk 3: "约20字重叠...第三段..."

为什么需要重叠？
  假设关键信息正好在段落边界："项目使用 | LangChain"（| 是切分点）
  没有重叠：两个 chunk 各得一半，信息断裂
  有重叠：两个 chunk 都包含完整信息，检索时不会遗漏
```

---

### 步骤 2.4-2.5：向量化并写入 Milvus

**Documents 服务** `server/src/documents/documents.service.ts`

```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v4 as uuidv4 } from 'uuid';
import * as multer from 'multer';
import { DatabaseService } from '../database/database.service';
import { MilvusService } from '../milvus/milvus.service';
import { DocumentParserService } from './document-parser.service';
import { DocumentChunkerService } from './document-chunker.service';
import { OpenAIEmbeddings } from '@langchain/openai';

/**
 * 文档管理服务
 *
 * 职责：编排文档的完整生命周期（创建 → 解析 → 切分 → 向量化 → 存储）
 *
 * 流程：
 * 1. createDocument：保存文件记录到 MySQL
 * 2. vectorizeDocument：解析 → 切分 → embedding → 写入 Milvus
 * 3. listDocuments / getDocument / deleteDocument：CRUD 操作
 *
 * 关键细节：
 * - vectorizeDocument 是异步流程，由 Controller 触发后不等待
 * - 每步失败都更新 MySQL 状态为 failed，便于排查
 * - Embedding 使用 OpenAIEmbeddings（兼容通义千问接口）
 */
@Injectable()
export class DocumentsService {
  private embeddings: OpenAIEmbeddings;

  constructor(
    private databaseService: DatabaseService,
    private milvusService: MilvusService,
    private parserService: DocumentParserService,
    private chunkerService: DocumentChunkerService,
    private configService: ConfigService,
  ) {
    // 初始化 Embedding 客户端（兼容 OpenAI 接口格式）
    this.embeddings = new OpenAIEmbeddings({
      model: this.configService.get<string>('embedding.modelName'),
      configuration: {
        baseURL: this.configService.get<string>('llm.baseUrl'),
        apiKey: this.configService.get<string>('llm.apiKey'),
      },
      dimensions: this.configService.get<number>('embedding.dimensions'),
    });
  }

  /** 创建文档记录 */
  async createDocument(data: {
    title: string;
    filePath: string;
    fileType: string;
  }): Promise<number> {
    const result = await this.databaseService.insert(
      'INSERT INTO documents (title, file_path, file_type, status) VALUES (?, ?, ?, ?)',
      [data.title, data.filePath, data.fileType, 'uploading'],
    );
    return result;
  }

  /** 文档向量化全流程 */
  async vectorizeDocument(docId: number): Promise<void> {
    try {
      // 1. 更新状态为 indexing
      await this.databaseService.query(
        'UPDATE documents SET status = ? WHERE id = ?',
        ['indexing', docId],
      );

      // 2. 从 MySQL 获取文档信息
      const docs: any[] = await this.databaseService.query(
        'SELECT * FROM documents WHERE id = ?',
        [docId],
      );
      const doc = docs[0];

      // 3. 解析文件为纯文本
      const text = await this.parserService.parse(
        doc.file_path,
        doc.file_type,
      );

      // 4. 切分为 chunk
      const chunks = await this.chunkerService.split(text);

      // 5. 批量生成 embedding
      const embeddings = await this.embeddings.embedDocuments(chunks);

      // 6. 写入 Milvus
      await this.milvusService.insert({
        content: chunks,
        docId: chunks.map(() => docId),
        docTitle: chunks.map(() => doc.title),
        chunkIndex: chunks.map((_, i) => i),
        embedding: embeddings,
      });

      // 7. 更新 MySQL 状态和 chunk 数
      await this.databaseService.query(
        'UPDATE documents SET status = ?, chunk_count = ? WHERE id = ?',
        ['indexed', chunks.length, docId],
      );
    } catch (error) {
      // 失败时更新状态
      await this.databaseService.query(
        'UPDATE documents SET status = ? WHERE id = ?',
        ['failed', docId],
      );
      throw error;
    }
  }

  /** 文档列表 */
  async listDocuments() {
    return this.databaseService.query(
      'SELECT id, title, file_type, status, chunk_count, created_at FROM documents ORDER BY created_at DESC',
    );
  }

  /** 文档详情 */
  async getDocument(id: number) {
    const docs: any[] = await this.databaseService.query(
      'SELECT * FROM documents WHERE id = ?',
      [id],
    );
    return docs[0];
  }

  /** 删除文档（同时清理 Milvus 中的 chunk） */
  async deleteDocument(id: number): Promise<void> {
    await this.milvusService.deleteByDocId(id);
    await this.databaseService.query('DELETE FROM documents WHERE id = ?', [id]);
  }
}
```

**知识扩展：embedDocuments vs embedQuery**

```
embedDocuments(texts[])：批量向量化，用于入库
  - 输入：多个文本
  - 输出：多个向量
  - 场景：文档切分后，一次性向量化所有 chunk

embedQuery(text)：单个向量化，用于检索
  - 输入：一个查询文本
  - 输出：一个向量
  - 场景：用户提问时，将问题向量化

为什么分两个方法？
  - embedDocuments 可以做批处理优化（一次 API 调用处理多条）
  - embedQuery 通常只处理一条，更注重速度
```

---

### 步骤 2.6：前端上传页面

`web/src/App.tsx`

```tsx
import { useState, useEffect } from 'react';

interface Document {
  id: number;
  title: string;
  file_type: string;
  status: string;
  chunk_count: number;
  created_at: string;
}

const API_BASE = 'http://localhost:3000';

function App() {
  const [documents, setDocuments] = useState<Document[]>([]);

  /** 加载文档列表 */
  const fetchDocuments = async () => {
    const res = await fetch(`${API_BASE}/documents`);
    const data = await res.json();
    setDocuments(data);
  };

  useEffect(() => {
    fetchDocuments();
    // 轮询状态，让 uploading/indexing 自动刷新
    const timer = setInterval(fetchDocuments, 3000);
    return () => clearInterval(timer);
  }, []);

  /** 上传文件 */
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    await fetch(`${API_BASE}/documents/upload`, {
      method: 'POST',
      body: formData,
    });

    fetchDocuments(); // 刷新列表
  };

  /** 删除文档 */
  const handleDelete = async (id: number) => {
    await fetch(`${API_BASE}/documents/${id}`, { method: 'DELETE' });
    fetchDocuments();
  };

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: 20 }}>
      <h1>智能知识库助手</h1>

      {/* 上传区域 */}
      <div style={{ marginBottom: 20, padding: 20, border: '2px dashed #ccc' }}>
        <input type="file" accept=".txt,.md" onChange={handleUpload} />
        <p>支持 .txt .md 文件</p>
      </div>

      {/* 文档列表 */}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th>标题</th>
            <th>类型</th>
            <th>状态</th>
            <th>分块数</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {documents.map((doc) => (
            <tr key={doc.id}>
              <td>{doc.title}</td>
              <td>{doc.file_type}</td>
              <td>{doc.status}</td>
              <td>{doc.chunk_count}</td>
              <td>
                <button onClick={() => handleDelete(doc.id)}>删除</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default App;
```

**阶段二里程碑**：上传一个 txt 文件，Milvus 中能搜到相关 chunk

---

## 阶段三：基础 RAG 问答

### 学习目标

- 理解 RAG（Retrieval Augmented Generation）的完整流程
- 掌握问题向量化 → Milvus 检索 → Prompt 组装 → LLM 生成的链路
- 理解 Prompt Engineering 在 RAG 中的关键作用

---

### 步骤 3.1-3.3：RAG 问答服务

`server/src/chat/chat.service.ts`

```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { OpenAIEmbeddings } from '@langchain/openai';
import { MilvusService } from '../milvus/milvus.service';
import { DatabaseService } from '../database/database.service';

/**
 * 基础 RAG 问答服务
 *
 * 职责：实现问题 → 检索 → 生成回答的基础 RAG 链路
 *
 * 流程：
 * 1. 将用户问题向量化
 * 2. 用向量在 Milvus 中检索 topK 个相关 chunk
 * 3. 将检索到的 chunk 作为上下文，组装 Prompt
 * 4. 调用 LLM 生成回答
 *
 * 关键细节：
 * - 这是"无 Agent"的简单版本，固定走 检索→生成 路径
 * - 后续阶段四会替换为 Agent 自主决策
 * - Prompt 中强调"只基于上下文回答"，减少幻觉
 */
@Injectable()
export class ChatService {
  private llm: ChatOpenAI;
  private embeddings: OpenAIEmbeddings;

  constructor(
    private milvusService: MilvusService,
    private databaseService: DatabaseService,
    private configService: ConfigService,
  ) {
    const baseUrl = this.configService.get<string>('llm.baseUrl');
    const apiKey = this.configService.get<string>('llm.apiKey');

    this.llm = new ChatOpenAI({
      model: this.configService.get<string>('llm.modelName'),
      configuration: { baseURL: baseUrl, apiKey },
      temperature: 0.3, // 低温度，让回答更确定、更贴近检索结果
    });

    this.embeddings = new OpenAIEmbeddings({
      model: this.configService.get<string>('embedding.modelName'),
      configuration: { baseURL: baseUrl, apiKey },
      dimensions: this.configService.get<number>('embedding.dimensions'),
    });
  }

  /** RAG 问答 */
  async query(question: string): Promise<{
    answer: string;
    sources: Array<{ content: string; docTitle: string; score: number }>;
  }> {
    // 1. 问题向量化
    const queryEmbedding = await this.embeddings.embedQuery(question);

    // 2. Milvus 相似度检索
    const sources = await this.milvusService.search(queryEmbedding, 5);

    // 3. 组装上下文
    const context = sources
      .map((s, i) => `[文档: ${s.docTitle}]\n${s.content}`)
      .join('\n\n---\n\n');

    // 4. 组装 Prompt
    const prompt = this.buildRAGPrompt(question, context);

    // 5. 调用 LLM 生成回答
    const response = await this.llm.invoke(prompt);

    return {
      answer: response.content as string,
      sources,
    };
  }

  /** 构建 RAG Prompt */
  private buildRAGPrompt(question: string, context: string): string {
    return `你是智能知识库助手，请基于以下检索到的文档内容回答用户问题。

## 检索到的文档内容
${context}

## 回答规则
- 只基于上述文档内容回答，不要编造文档中没有的信息
- 如果文档中没有相关信息，请明确说明"知识库中未找到相关信息"
- 引用回答时，注明来自哪个文档

## 用户问题
${question}`;
  }
}
```

**Chat 控制器** `server/src/chat/chat.controller.ts`

```typescript
import { Controller, Post, Body } from '@nestjs/common';
import { ChatService } from './chat.service';

@Controller('chat')
export class ChatController {
  constructor(private chatService: ChatService) {}

  @Post('query')
  async query(@Body('question') question: string) {
    return this.chatService.query(question);
  }
}
```

**Chat 模块** `server/src/chat/chat.module.ts`

```typescript
import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

@Module({
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
```

**验证**：用 curl 测试

```bash
curl -X POST http://localhost:3000/chat/query \
  -H "Content-Type: application/json" \
  -d '{"question": "这个文档讲了什么？"}'
```

**知识扩展：为什么 temperature=0.3？**

```
temperature 控制输出的随机性：

  temperature=0：每次回答完全相同（适合事实性问题）
  temperature=0.3：少量随机，保持准确性（适合 RAG）
  temperature=0.7：中等随机，有创造性（适合写文章）
  temperature=1.0：高随机，很发散（适合头脑风暴）

RAG 场景用低温度的原因：
  我们希望 LLM 忠实于检索到的文档内容，而不是自由发挥
  高温度可能导致 LLM "创造"文档中没有的信息 → 幻觉
```

**知识扩展：RAG 的核心是"检索 + 生成"两个阶段**

```
纯 LLM 回答：
  用户问题 → LLM → 回答（可能编造信息）

RAG 回答：
  用户问题 → 向量化 → Milvus 检索相关文档 → 组装 Prompt → LLM → 回答

关键区别：
  纯 LLM 的知识来自训练数据，可能过时或不准确
  RAG 的知识来自你提供的文档，实时且准确

RAG 的英文全称：Retrieval Augmented Generation（检索增强生成）
  Retrieval：检索相关文档
  Augmented：用检索结果增强 LLM 的输入
  Generation：LLM 基于增强后的输入生成回答
```

---

### 步骤 3.4：前端基础聊天界面

`web/src/App.tsx` 增加聊天功能：

```tsx
// 在 App 组件中增加以下状态和方法

const [question, setQuestion] = useState('');
const [messages, setMessages] = useState<
  Array<{ role: string; content: string }>
>([]);
const [loading, setLoading] = useState(false);

/** 发送问题 */
const handleAsk = async () => {
  if (!question.trim()) return;

  // 添加用户消息
  setMessages((prev) => [...prev, { role: 'user', content: question }]);
  setLoading(true);

  try {
    const res = await fetch(`${API_BASE}/chat/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    const data = await res.json();

    // 添加 AI 回答
    setMessages((prev) => [
      ...prev,
      { role: 'assistant', content: data.answer },
    ]);
  } catch (err) {
    setMessages((prev) => [
      ...prev,
      { role: 'assistant', content: '抱歉，请求失败' },
    ]);
  } finally {
    setLoading(false);
    setQuestion('');
  }
};

// JSX 中增加聊天区域
{
  messages.map((msg, i) => (
    <div
      key={i}
      style={{
        padding: 10,
        margin: '5px 0',
        background: msg.role === 'user' ? '#e3f2fd' : '#f5f5f5',
        borderRadius: 8,
      }}
    >
      <strong>{msg.role === 'user' ? '你' : 'AI'}：</strong>
      {msg.content}
    </div>
  ));
}
```

**阶段三里程碑**：问文档相关问题，能基于文档内容回答，且回答中不包含文档外的编造信息

---

## 阶段四：Agent 化（核心）

### 学习目标

- 理解 ReAct（Reasoning + Acting）模式的核心思想
- 掌握 Tool 定义规范（zod schema + describe）
- 实现完整的 Agent 循环：感知 → 思考 → 行动
- 理解 System Prompt 对 Agent 行为的决定性影响

---

### 步骤 4.1：定义 Tool（工具）

**工具是 Agent 的"手脚"**，LLM 通过 tool 的 `name` 和 `description` 来决定何时调用哪个工具。

`server/src/chat/tools/knowledge-search.tool.ts`

```typescript
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { MilvusService } from '../../milvus/milvus.service';
import { OpenAIEmbeddings } from '@langchain/openai';

/**
 * 知识库检索工具
 *
 * 职责：在 Milvus 中检索与问题相关的文档片段
 *
 * 关键细节：
 * - description 决定了 LLM 何时选择此工具，必须精准描述触发条件
 * - zod schema 中每个字段必须有 .describe()，否则 LLM 不知道该传什么
 * - 工具内部封装了 embedding + Milvus search，对 LLM 透明
 */
export function createKnowledgeSearchTool(
  milvusService: MilvusService,
  embeddings: OpenAIEmbeddings,
) {
  return tool(
    async ({ query, topK }) => {
      try {
        // 1. 问题向量化
        const queryEmbedding = await embeddings.embedQuery(query);
        // 2. Milvus 检索
        const results = await milvusService.search(queryEmbedding, topK);
        // 3. 格式化返回
        return results
          .map(
            (r, i) =>
              `[结果${i + 1}] (文档: ${r.docTitle}, 相关度: ${r.score.toFixed(3)})\n${r.content}`,
          )
          .join('\n\n');
      } catch (error) {
        // 工具必须捕获错误并返回字符串，不能抛异常（否则 Agent 循环会中断）
        return `检索失败: ${error.message}`;
      }
    },
    {
      name: 'knowledge_search',
      description: '在知识库中检索与问题相关的文档片段。当用户的问题涉及已上传文档的具体内容时使用此工具。',
      schema: z.object({
        query: z.string().describe('搜索关键词或问题描述，用于向量化检索'),
        topK: z.number().default(5).describe('返回结果数量，默认5，最多10'),
      }),
    },
  );
}
```

`server/src/chat/tools/document-query.tool.ts`

```typescript
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { DatabaseService } from '../../database/database.service';

/**
 * 文档元数据查询工具
 *
 * 职责：查询 MySQL 中的文档列表和元数据
 *
 * 关键细节：
 * - 与 knowledge_search 的区别：本工具查"有哪些文档"，不查"文档里写了什么"
 * - LLM 需要根据问题区分："知识库里有什么" → 用本工具，"XX文档里写了什么" → 用 knowledge_search
 */
export function createDocumentQueryTool(databaseService: DatabaseService) {
  return tool(
    async ({ keyword, status }) => {
      try {
        let sql = 'SELECT id, title, file_type, status, chunk_count FROM documents WHERE 1=1';
        const params: unknown[] = [];

        if (keyword) {
          sql += ' AND title LIKE ?';
          params.push(`%${keyword}%`);
        }
        if (status) {
          sql += ' AND status = ?';
          params.push(status);
        }

        sql += ' ORDER BY created_at DESC LIMIT 20';
        const rows = await databaseService.query(sql, params);

        if (rows.length === 0) {
          return '没有找到匹配的文档';
        }

        return rows
          .map(
            (r: any) =>
              `[ID:${r.id}] ${r.title} (${r.file_type}, 状态: ${r.status}, 分块: ${r.chunk_count})`,
          )
          .join('\n');
      } catch (error) {
        return `查询失败: ${error.message}`;
      }
    },
    {
      name: 'document_query',
      description: '查询知识库中的文档元数据信息（标题、类型、状态、分块数）。当用户询问"有哪些文档"、"知识库里有什么"时使用此工具。',
      schema: z.object({
        keyword: z.string().optional().describe('文档标题关键词，用于模糊搜索'),
        status: z.string().optional().describe('文档状态筛选: indexed / uploading / failed'),
      }),
    },
  );
}
```

**知识扩展：Tool 定义的四大要素**

```
tool() 函数接收两个参数：

1. 执行函数（async function）
   - 输入：zod schema 解析后的参数对象
   - 输出：必须是 string（LLM 需要阅读工具返回结果）
   - 错误处理：必须 try/catch，返回错误字符串

2. 配置对象
   - name：工具名，LLM 用这个名字调用
   - description：工具描述，决定 LLM 何时选择此工具
   - schema：参数 schema，用 zod 定义

四大要素的优先级：
  description > name > schema.describe() > 执行逻辑

  因为 LLM 选择工具的第一依据是 description，
  description 写得越精准，tool_call 准确率越高。
```

---

### 步骤 4.2：定义 Agent 状态

`server/src/chat/agent/agent-state.ts`

```typescript
/**
 * Agent 状态定义
 *
 * 职责：显式定义 Agent 在循环中的所有可追踪状态
 *
 * 关键细节：
 * - 所有状态都是可序列化的，便于日志记录和调试
 * - isComplete 由 Agent 循环控制，不允许外部直接修改
 * - history 记录每一步的 Thought/Action/Observation，用于构建多步 Prompt
 */
export interface AgentState {
  /** 用户原始问题 */
  task: string;
  /** 已执行的 ReAct 步骤 */
  history: ReActStep[];
  /** 对话历史（短期记忆） */
  chatHistory: ChatMessage[];
  /** 当前步数 */
  currentStep: number;
  /** 是否已完成 */
  isComplete: boolean;
}

export interface ReActStep {
  /** LLM 的推理过程 */
  thought: string;
  /** 工具调用（最后一步可能没有） */
  action?: {
    tool: string;
    input: Record<string, unknown>;
  };
  /** 工具返回结果 */
  observation?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}
```

**知识扩展：为什么状态必须显式定义？**

```
隐式状态（错误做法）：
  let currentStep = 0;
  let history = [];
  // 散落在各个函数中，难以追踪，难以调试

显式状态（正确做法）：
  const state: AgentState = { task, history: [], currentStep: 0, isComplete: false };
  // 所有状态集中管理，每步可打印 state 查看全貌
  // 便于日志记录、错误恢复、状态回滚

类比：
  隐式状态 = 把钱随手放在各个口袋里，不知道自己有多少钱
  显式状态 = 用记账本记录每笔收支，随时知道余额
```

---

### 步骤 4.3：实现 ReAct Agent 主类

`server/src/chat/agent/react-agent.ts`

```typescript
import { ChatOpenAI } from '@langchain/openai';
import { SystemMessage, HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { AgentState, ReActStep } from './agent-state';
import { buildSystemPrompt } from './prompts';

/**
 * ReAct Agent 主类
 *
 * 职责：实现 感知→思考→行动 的 Agent 循环
 *
 * 流程：
 * 1. 构建初始消息列表（system + chat history + question）
 * 2. 循环调用 LLM，解析 tool_call
 * 3. 如果有 tool_call，执行工具，将结果追加到消息列表
 * 4. 如果没有 tool_call（LLM 直接给出最终回答），退出循环
 * 5. 超过 maxSteps 强制退出
 *
 * 关键细节：
 * - 使用 LangChain 的 bindTools 模式，LLM 自动生成 tool_call
 * - ToolMessage 的 tool_call_id 必须与 AIMessage 中的 tool_call.id 匹配
 * - 每个 tool 执行都有超时控制
 */
export class ReActAgent {
  private llm: ChatOpenAI;
  private tools: Map<string, DynamicStructuredTool>;
  private maxSteps: number;
  private toolTimeout: number;

  constructor(config: {
    llm: ChatOpenAI;
    tools: DynamicStructuredTool[];
    maxSteps: number;
    toolTimeout: number;
  }) {
    this.llm = config.llm;
    this.tools = new Map(config.tools.map((t) => [t.name, t]));
    this.maxSteps = config.maxSteps;
    this.toolTimeout = config.toolTimeout;
  }

  /**
   * 运行 Agent 循环
   *
   * @returns Agent 的最终回答和执行步骤记录
   */
  async run(
    question: string,
    chatHistory: Array<{ role: string; content: string }>,
  ): Promise<{ answer: string; steps: ReActStep[] }> {
    // 初始化状态
    const state: AgentState = {
      task: question,
      history: [],
      chatHistory: chatHistory.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      currentStep: 0,
      isComplete: false,
    };

    // 构建 LLM 绑定工具的实例
    const toolsArray = Array.from(this.tools.values());
    const llmWithTools = this.llm.bindTools(toolsArray);

    // 构建初始消息列表
    const messages = this.buildInitialMessages(state);

    // Agent 循环
    while (state.currentStep < this.maxSteps) {
      state.currentStep++;
      const stepStart = Date.now();

      console.log(`\n===== Agent Step ${state.currentStep} =====`);

      // 思考：调用 LLM
      const aiMessage = await llmWithTools.invoke(messages);
      messages.push(aiMessage);

      // 检查是否有 tool_call
      const toolCalls = aiMessage.tool_calls;

      if (!toolCalls || toolCalls.length === 0) {
        // 没有 tool_call → LLM 给出了最终回答
        console.log(`Agent 最终回答: ${(aiMessage.content as string).substring(0, 100)}...`);
        return {
          answer: aiMessage.content as string,
          steps: state.history,
        };
      }

      // 有 tool_call → 执行工具
      for (const toolCall of toolCalls) {
        const toolName = toolCall.name;
        const toolInput = toolCall.args;
        const toolCallId = toolCall.id!;

        console.log(`调用工具: ${toolName}`, JSON.stringify(toolInput));

        // 执行工具（带超时）
        let observation: string;
        try {
          observation = await this.executeToolWithTimeout(
            toolName,
            toolInput,
          );
        } catch (error) {
          observation = `工具执行失败: ${error.message}`;
        }

        console.log(`工具结果: ${observation.substring(0, 200)}...`);

        // 将工具结果追加到消息列表
        messages.push(
          new ToolMessage({
            content: observation,
            tool_call_id: toolCallId, // 必须匹配！
          }),
        );

        // 记录步骤
        state.history.push({
          thought: `调用 ${toolName}`,
          action: { tool: toolName, input: toolInput as Record<string, unknown> },
          observation,
        });
      }

      const stepDuration = Date.now() - stepStart;
      console.log(`步骤耗时: ${stepDuration}ms`);
    }

    // 超过最大步数
    return {
      answer: '抱歉，我在处理这个问题时步骤过多，请尝试更具体地描述您的问题。',
      steps: state.history,
    };
  }

  /** 构建初始消息列表 */
  private buildInitialMessages(state: AgentState) {
    const messages: any[] = [
      new SystemMessage(buildSystemPrompt()),
    ];

    // 添加对话历史
    for (const msg of state.chatHistory) {
      if (msg.role === 'user') {
        messages.push(new HumanMessage(msg.content));
      } else {
        messages.push(new AIMessage(msg.content));
      }
    }

    // 添加当前问题
    messages.push(new HumanMessage(state.task));

    return messages;
  }

  /** 带超时的工具执行 */
  private async executeToolWithTimeout(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return `未知工具: ${toolName}`;
    }

    // Promise.race 实现超时
    const result = await Promise.race([
      tool.invoke(input),
      new Promise<string>((_, reject) =>
        setTimeout(
          () => reject(new Error(`工具 ${toolName} 执行超时(${this.toolTimeout}ms)`)),
          this.toolTimeout,
        ),
      ),
    ]);

    return result;
  }
}
```

**知识扩展：bindTools 模式 vs 手动解析**

```
方式一：手动解析（阶段三的做法）
  1. LLM 输出纯文本 "我应该调用 knowledge_search 工具"
  2. 自己写正则/解析器提取工具名和参数
  3. 自己调用工具
  问题：LLM 输出格式不稳定，解析容易出错

方式二：bindTools（本步骤的做法）
  1. llm.bindTools([tool1, tool2, tool3])
  2. LLM 自动生成结构化的 tool_calls（JSON 格式）
  3. 直接从 aiMessage.tool_calls 获取工具名和参数
  好处：格式稳定，zod 自动校验，不需要手动解析

bindTools 的本质：
  LangChain 将工具的 name + description + schema 翻译成 API 的 tools 参数
  OpenAI 兼容接口会将这些信息注入 Prompt，引导 LLM 输出 tool_call 格式
```

**知识扩展：ToolMessage 的 tool_call_id 为什么必须匹配？**

```
AIMessage:
  tool_calls: [{ id: "call_abc123", name: "knowledge_search", args: { query: "..." } }]
                                                  ↓
ToolMessage:
  tool_call_id: "call_abc123"  ← 必须与上面的 id 一致！
  content: "检索结果..."

如果不匹配：
  LLM 会报错 "tool_call_id not found"
  因为 LLM 需要知道这个工具结果是回答哪个 tool_call 的

类比：
  你问三个问题 Q1/Q2/Q3
  回答 R1/R2/R3 必须一一对应
  如果 R2 标错为回答 Q1，就会混乱
```

---

### 步骤 4.4：编写 System Prompt

`server/src/chat/agent/prompts.ts`

```typescript
/**
 * Prompt 集中管理模块
 *
 * 职责：统一管理 Agent 的系统提示词
 *
 * 关键细节：
 * - System Prompt 是 Agent 的"行为说明书"，决定 LLM 的行为模式
 * - 必须包含四部分：身份定位、可用工具、使用规则、输出格式
 * - Prompt 写得好，tool_call 准确率可提升 30% 以上
 */
export function buildSystemPrompt(): string {
  return `你是智能知识库助手，帮助用户回答关于已上传文档的问题。

## 可用工具
1. knowledge_search: 在知识库中检索相关文档片段，当问题涉及文档具体内容时使用
2. document_query: 查询文档元数据（标题、类型、状态），当用户问"有哪些文档"时使用
3. direct_answer: 当问题不需要检索知识库时（如闲聊、常识问题）直接回答

## 使用规则
- 涉及文档内容的问题，必须先调用 knowledge_search 检索，不能凭记忆回答
- 如果第一次检索结果不充分，可以换关键词再次检索
- 闲聊或常识问题，使用 direct_answer
- 每次检索后，基于检索结果回答，不要编造文档中没有的内容
- 最多执行 5 步，避免无限循环

## 回答格式
- 先给出直接回答
- 如果使用了检索，在回答末尾标注来源文档`;
}
```

**知识扩展：System Prompt 四要素详解**

```
1. 身份定位（你是谁）
   "你是智能知识库助手" → LLM 知道自己的角色
   没有：LLM 可能以通用助手自居，回答偏离知识库主题

2. 可用工具（你能做什么）
   列出每个工具的名字和用途 → LLM 知道何时调用
   没有：LLM 不知道有工具可用，只会直接回答

3. 使用规则（你该怎么做）
   "涉及文档内容必须先检索" → 约束 LLM 行为
   没有：LLM 可能跳过检索直接回答 → 幻觉风险

4. 输出格式（你该怎么输出）
   "先给回答，再标注来源" → 规范输出结构
   没有：LLM 输出格式随意，前端难以解析

类比：
  System Prompt = 公司的新员工入职手册
  没有手册 → 员工自由发挥，可能做错事
  有好手册 → 员工按流程工作，效率高、出错少
```

---

### 步骤 4.5：集成 Agent 到 ChatService

修改 `server/src/chat/chat.service.ts`，将阶段三的简单 RAG 替换为 Agent：

```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { OpenAIEmbeddings } from '@langchain/openai';
import { MilvusService } from '../milvus/milvus.service';
import { DatabaseService } from '../database/database.service';
import { ReActAgent } from './agent/react-agent';
import { createKnowledgeSearchTool } from './tools/knowledge-search.tool';
import { createDocumentQueryTool } from './tools/document-query.tool';

@Injectable()
export class ChatService {
  private agent: ReActAgent;

  constructor(
    private milvusService: MilvusService,
    private databaseService: DatabaseService,
    private configService: ConfigService,
  ) {
    const baseUrl = this.configService.get<string>('llm.baseUrl');
    const apiKey = this.configService.get<string>('llm.apiKey');

    const llm = new ChatOpenAI({
      model: this.configService.get<string>('llm.modelName'),
      configuration: { baseURL: baseUrl, apiKey },
      temperature: 0.3,
    });

    const embeddings = new OpenAIEmbeddings({
      model: this.configService.get<string>('embedding.modelName'),
      configuration: { baseURL: baseUrl, apiKey },
      dimensions: this.configService.get<number>('embedding.dimensions'),
    });

    // 创建工具
    const tools = [
      createKnowledgeSearchTool(milvusService, embeddings),
      createDocumentQueryTool(databaseService),
    ];

    // 创建 Agent
    this.agent = new ReActAgent({
      llm,
      tools,
      maxSteps: this.configService.get<number>('agent.maxSteps'),
      toolTimeout: this.configService.get<number>('agent.toolTimeout'),
    });
  }

  /** Agent 问答（替代阶段三的简单 RAG） */
  async query(question: string): Promise<{
    answer: string;
    steps: Array<{ thought: string; action?: any; observation?: string }>;
  }> {
    return this.agent.run(question, []);
  }
}
```

---

### 步骤 4.6：场景验证

上传几个文档后，测试三种场景：

```
场景1：闲聊问题 → Agent 应选择 direct_answer 或不调用工具
  用户："你好，今天天气怎么样？"
  期望：直接回答，不调用 knowledge_search

场景2：文档内容问题 → Agent 应调用 knowledge_search
  用户："这个文档讲了什么？"
  期望：先检索，再基于检索结果回答

场景3：需要多步检索的问题 → Agent 应多次调用 knowledge_search
  用户："文档A和文档B在XX方面的观点有什么不同？"
  期望：分别检索文档A和文档B的相关内容，对比后回答
```

**知识扩展：Agent 的"智能"来自哪里？**

```
Agent 的智能 = LLM 的推理能力 + Tool 的执行能力 + Prompt 的引导能力

  LLM 负责"思考"：分析问题、决定调用哪个工具、综合结果
  Tool 负责"行动"：检索知识库、查询数据库、调用外部 API
  Prompt 负责"引导"：告诉 LLM 什么时候该做什么

三者的关系：
  没有 LLM → Agent 无法推理，只会机械执行
  没有 Tool → Agent 无法行动，只会纸上谈兵
  没有 Prompt → Agent 行为不可控，可能做错事

类比：
  LLM = 大脑，Tool = 双手，Prompt = 规章制度
```

**阶段四里程碑**：Agent 能根据问题自主选择工具，闲聊不检索，文档问题先检索后回答，多步问题多次检索

---

## 阶段五：流式输出 + 记忆

### 学习目标

- 掌握 NestJS SSE（Server-Sent Events）实现方式
- 理解 Agent 步骤的结构化日志设计
- 掌握短期记忆（对话历史）和长期记忆（MySQL 持久化）的实现

---

### 步骤 5.1：NestJS SSE 端点

`server/src/chat/chat.controller.ts` 增加 SSE 端点：

```typescript
import { Controller, Post, Get, Body, Query, Sse, Res } from '@nestjs/common';
import { Response } from 'express';
import { Observable, Subject } from 'rxjs';

@Controller('chat')
export class ChatController {
  constructor(private chatService: ChatService) {}

  @Post('query')
  async query(@Body('question') question: string) {
    return this.chatService.query(question);
  }

  /**
   * SSE 流式问答端点
   *
   * 流程：
   * 1. 前端通过 EventSource 连接
   * 2. Agent 每完成一步，通过 Subject 推送事件
   * 3. 前端实时展示 Agent 的思考过程
   *
   * 关键细节：
   * - 使用 Subject 作为事件源，Agent 运行时向 Subject 推送
   * - SSE 数据格式必须以 "data: " 开头，以 "\n\n" 结尾
   * - 连接关闭时取消 Agent 运行
   */
  @Sse('stream')
  stream(@Query('question') question: string): Observable<MessageEvent> {
    const eventSubject = new Subject<MessageEvent>();

    // 异步运行 Agent，每步推送事件
    this.chatService.queryWithStream(question, (event) => {
      eventSubject.next(event);
    }).then(() => {
      eventSubject.complete();
    });

    return eventSubject.asObservable();
  }
}
```

**知识扩展：SSE vs WebSocket**

```
SSE (Server-Sent Events)：
  - 单向：服务器 → 客户端
  - 基于 HTTP，自动重连
  - 适合：服务器推送场景（Agent 过程、聊天流式输出）
  - 前端用 EventSource API

WebSocket：
  - 双向：服务器 ↔ 客户端
  - 需要单独协议升级
  - 适合：需要客户端也频繁发送的场景（在线游戏、协同编辑）

本项目选 SSE 的原因：
  Agent 场景只需要 服务器→客户端 的推送
  SSE 更简单，基于 HTTP，不需要额外依赖
```

---

### 步骤 5.2：Agent 流式推送改造

修改 `ReActAgent`，在循环的每个关键节点推送事件：

```typescript
export type AgentEventType =
  | { type: 'thought'; step: number; content: string }
  | { type: 'action'; step: number; tool: string; input: Record<string, unknown> }
  | { type: 'observation'; step: number; content: string }
  | { type: 'answer'; step: number; content: string }
  | { type: 'done'; answer: string };

export class ReActAgent {
  // ... 其他属性不变

  /**
   * 流式运行 Agent
   *
   * @param onEvent 事件回调，Agent 每完成一步调用
   */
  async runWithStream(
    question: string,
    chatHistory: Array<{ role: string; content: string }>,
    onEvent: (event: AgentEventType) => void,
  ): Promise<{ answer: string; steps: ReActStep[] }> {
    const state: AgentState = {
      task: question,
      history: [],
      chatHistory: chatHistory.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      currentStep: 0,
      isComplete: false,
    };

    const toolsArray = Array.from(this.tools.values());
    const llmWithTools = this.llm.bindTools(toolsArray);
    const messages = this.buildInitialMessages(state);

    while (state.currentStep < this.maxSteps) {
      state.currentStep++;

      // 推送 thought 事件
      onEvent({
        type: 'thought',
        step: state.currentStep,
        content: `正在思考第 ${state.currentStep} 步...`,
      });

      const aiMessage = await llmWithTools.invoke(messages);
      messages.push(aiMessage);

      const toolCalls = aiMessage.tool_calls;

      if (!toolCalls || toolCalls.length === 0) {
        const answer = aiMessage.content as string;

        // 推送 answer 事件
        onEvent({ type: 'answer', step: state.currentStep, content: answer });
        onEvent({ type: 'done', answer });

        return { answer, steps: state.history };
      }

      for (const toolCall of toolCalls) {
        const toolName = toolCall.name;
        const toolInput = toolCall.args as Record<string, unknown>;

        // 推送 action 事件
        onEvent({
          type: 'action',
          step: state.currentStep,
          tool: toolName,
          input: toolInput,
        });

        let observation: string;
        try {
          observation = await this.executeToolWithTimeout(toolName, toolInput);
        } catch (error) {
          observation = `工具执行失败: ${error.message}`;
        }

        messages.push(
          new ToolMessage({
            content: observation,
            tool_call_id: toolCall.id!,
          }),
        );

        // 推送 observation 事件
        onEvent({
          type: 'observation',
          step: state.currentStep,
          content: observation.substring(0, 500), // 截断，避免 SSE 数据过大
        });

        state.history.push({
          thought: `调用 ${toolName}`,
          action: { tool: toolName, input: toolInput },
          observation,
        });
      }
    }

    onEvent({
      type: 'done',
      answer: '抱歉，我在处理这个问题时步骤过多，请尝试更具体地描述您的问题。',
    });

    return {
      answer: '抱歉，我在处理这个问题时步骤过多。',
      steps: state.history,
    };
  }
}
```

**ChatService 对应修改**：

```typescript
/** 流式问答 */
async queryWithStream(
  question: string,
  onEvent: (event: any) => void,
): Promise<{ answer: string; steps: any[] }> {
  return this.agent.runWithStream(question, [], onEvent);
}
```

---

### 步骤 5.3：短期记忆

```typescript
import { InMemoryChatMessageHistory } from '@langchain/core/chat_history';

/**
 * 短期记忆服务
 *
 * 职责：管理每个会话的对话历史，保留最近 N 轮
 *
 * 关键细节：
 * - 使用 InMemoryChatMessageHistory 存储在内存中
 * - maxHistoryLength 控制保留轮数，超出则截断最早的
 * - 后续步骤 5.4 会加上 MySQL 持久化
 */
@Injectable()
export class ChatMemoryService {
  private histories: Map<string, InMemoryChatMessageHistory> = new Map();
  private maxHistoryLength = 10; // 保留最近 10 轮

  /** 获取或创建会话历史 */
  getOrCreateHistory(sessionId: string): InMemoryChatMessageHistory {
    if (!this.histories.has(sessionId)) {
      this.histories.set(sessionId, new InMemoryChatMessageHistory());
    }
    return this.histories.get(sessionId)!;
  }

  /** 获取格式化的对话历史（用于 Agent） */
  async getFormattedHistory(sessionId: string): Promise<Array<{ role: string; content: string }>> {
    const history = this.getOrCreateHistory(sessionId);
    const messages = await history.getMessages();

    // 只保留最近 maxHistoryLength 轮
    const sliced = messages.slice(-this.maxHistoryLength * 2); // 1轮 = 1条user + 1条assistant

    return sliced.map((m) => ({
      role: m._getType() === 'human' ? 'user' : 'assistant',
      content: m.content as string,
    }));
  }

  /** 添加用户消息 */
  async addUserMessage(sessionId: string, content: string): Promise<void> {
    const history = this.getOrCreateHistory(sessionId);
    await history.addUserMessage(content);
  }

  /** 添加 AI 消息 */
  async addAssistantMessage(sessionId: string, content: string): Promise<void> {
    const history = this.getOrCreateHistory(sessionId);
    await history.addAIMessage(content);
  }
}
```

**知识扩展：为什么短期记忆要截断？**

```
不截断的问题：
  对话 1轮: 100 tokens
  对话 10轮: 1000 tokens
  对话 50轮: 5000 tokens
  → 上下文越来越长，LLM 调用费用线性增长
  → 早期对话 LLM 可能"遗忘"（注意力被稀释）

截断后：
  始终保留最近 10 轮（约 1000 tokens）
  → 费用可控
  → LLM 专注于最近的上下文

滑动窗口策略：
  新消息进来 → 超出窗口 → 删除最早的消息
  就像一个固定大小的队列（FIFO）
```

---

### 步骤 5.4：MySQL 持久化对话历史

```typescript
/**
 * 将对话历史持久化到 MySQL
 *
 * 职责：确保刷新页面后对话不丢失
 *
 * 流程：
 * 1. 每次对话后，将 user/assistant 消息写入 messages 表
 * 2. 新会话创建时，从 messages 表加载历史
 * 3. 与 InMemoryChatMessageHistory 配合：内存作缓存，MySQL 作持久化
 */

// 在 ChatService 中增加持久化方法
async persistMessage(sessionId: string, role: string, content: string): Promise<void> {
  await this.databaseService.query(
    'INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)',
    [sessionId, role, content],
  );
}

async loadHistory(sessionId: string): Promise<Array<{ role: string; content: string }>> {
  const rows = await this.databaseService.query(
    'SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC',
    [sessionId],
  );
  return rows.map((r: any) => ({ role: r.role, content: r.content }));
}
```

---

### 步骤 5.5：前端 SSE 展示

```tsx
/**
 * SSE 聊天组件
 *
 * 职责：通过 EventSource 接收 Agent 流式事件，实时展示
 *
 * 流程：
 * 1. 用户发送问题
 * 2. 创建 EventSource 连接 /chat/stream?question=xxx
 * 3. 根据 event type 更新 UI
 */
function ChatPanel() {
  const [messages, setMessages] = useState<Array<{ role: string; content: string }>>([]);
  const [agentSteps, setAgentSteps] = useState<Array<{ type: string; content: string }>>([]);
  const [question, setQuestion] = useState('');

  const handleAsk = () => {
    if (!question.trim()) return;

    // 添加用户消息
    setMessages((prev) => [...prev, { role: 'user', content: question }]);
    setAgentSteps([]); // 清空上次的 Agent 步骤

    // 创建 SSE 连接
    const eventSource = new EventSource(
      `http://localhost:3000/chat/stream?question=${encodeURIComponent(question)}`,
    );

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);

      switch (data.type) {
        case 'thought':
          setAgentSteps((prev) => [...prev, { type: 'thought', content: data.content }]);
          break;
        case 'action':
          setAgentSteps((prev) => [
            ...prev,
            { type: 'action', content: `调用工具: ${data.tool}` },
          ]);
          break;
        case 'observation':
          setAgentSteps((prev) => [
            ...prev,
            { type: 'observation', content: `检索结果: ${data.content.substring(0, 100)}...` },
          ]);
          break;
        case 'answer':
          setMessages((prev) => [...prev, { role: 'assistant', content: data.content }]);
          break;
        case 'done':
          eventSource.close();
          if (data.answer && !messages.some((m) => m.content === data.answer)) {
            setMessages((prev) => [...prev, { role: 'assistant', content: data.answer }]);
          }
          break;
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
    });

    setQuestion('');
  };

  return (
    <div>
      {/* Agent 思考过程（可折叠） */}
      {agentSteps.length > 0 && (
        <div style={{ background: '#f0f0f0', padding: 10, borderRadius: 8, marginBottom: 10 }}>
          <strong>Agent 思考过程</strong>
          {agentSteps.map((step, i) => (
            <div key={i} style={{ fontSize: 12, color: '#666', margin: '4px 0' }}>
              {step.type === 'thought' && '💭 '}
              {step.type === 'action' && '🔧 '}
              {step.type === 'observation' && '📄 '}
              {step.content}
            </div>
          ))}
        </div>
      )}

      {/* 消息列表 */}
      {messages.map((msg, i) => (
        <div
          key={i}
          style={{
            padding: 10,
            margin: '5px 0',
            background: msg.role === 'user' ? '#e3f2fd' : '#f5f5f5',
            borderRadius: 8,
          }}
        >
          <strong>{msg.role === 'user' ? '你' : 'AI'}：</strong>
          {msg.content}
        </div>
      ))}

      {/* 输入框 */}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAsk()}
          placeholder="输入你的问题..."
          style={{ flex: 1, padding: 8, borderRadius: 4, border: '1px solid #ccc' }}
        />
        <button onClick={handleAsk} style={{ padding: '8px 16px' }}>发送</button>
      </div>
    </div>
  );
}
```

**知识扩展：SSE 事件格式**

```
SSE 标准格式：
  data: {"type":"thought","step":1,"content":"正在思考..."}\n\n
  data: {"type":"action","step":1,"tool":"knowledge_search"}\n\n
每条消息以 "data: " 开头，以 "\n\n" 结尾。

NestJS @Sse 装饰器会自动处理格式转换，
你只需要在 Subject 中 next() 一个 MessageEvent 对象即可。

前端 EventSource.onmessage 会自动解析 JSON。
```

**阶段五里程碑**：多轮对话流畅，前端能看到 Agent 的思考过程、工具调用、检索结果，刷新页面对话历史不丢失

---

## 阶段六：结构化输出 + 高级功能

### 学习目标

- 掌握 `withStructuredOutput` + zod 的结构化输出模式
- 理解结构化输出在 Agent 场景的应用（文档摘要、质量评估）
- 了解 MCP（Model Context Protocol）的基本集成方式

---

### 步骤 6.1：文档自动摘要（withStructuredOutput）

```typescript
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';

/**
 * 文档摘要提取
 *
 * 职责：使用 withStructuredOutput 从文档内容中提取结构化摘要
 *
 * 流程：
 * 1. 定义输出 schema（title, summary, keywords, category）
 * 2. 用 withStructuredOutput 包装 LLM
 * 3. 传入文档内容，自动得到结构化结果
 *
 * 关键细节：
 * - 每个字段必须有 .describe()，LLM 靠描述理解字段含义
 * - .nullable() 表示可选字段，LLM 找不到时返回 null 而非编造
 * - zod 会自动校验 LLM 输出，不符合 schema 时抛异常
 */

// 1. 定义输出 Schema
const documentSummarySchema = z.object({
  title: z.string().describe('文档的核心标题，简洁概括文档主题'),
  summary: z.string().describe('文档的100字以内摘要，包含核心观点和结论'),
  keywords: z.array(z.string()).describe('3到5个关键词，反映文档的核心话题'),
  category: z.string().nullable().describe('文档分类，如技术/产品/运营/其他，无法判断时返回null'),
});

// 2. 用 withStructuredOutput 包装 LLM
const structuredLLM = new ChatOpenAI({
  model: 'qwen-plus',
  temperature: 0,
}).withStructuredOutput(documentSummarySchema);

// 3. 提取摘要
async function extractSummary(content: string) {
  try {
    // 只需要传文档内容，不需要手动指定输出格式
    // withStructuredOutput 会自动将 schema 翻译成 Prompt 指令
    const result = await structuredLLM.invoke(
      `请分析以下文档内容，提取摘要信息：\n\n${content.substring(0, 3000)}`,
    );
    // result 的类型自动推断为：{ title: string; summary: string; keywords: string[]; category: string | null }
    return result;
  } catch (error) {
    console.error('摘要提取失败:', error.message);
    return null;
  }
}
```

**集成到文档向量化流程**：

```typescript
// 在 DocumentsService.vectorizeDocument 的最后，加上摘要提取
async vectorizeDocument(docId: number): Promise<void> {
  // ... 原有的解析、切分、embedding 流程 ...

  // 新增：提取结构化摘要
  const fullText = await this.parserService.parse(doc.file_path, doc.file_type);
  const summary = await extractSummary(fullText);

  if (summary) {
    await this.databaseService.query(
      'UPDATE documents SET summary = ?, keywords = ? WHERE id = ?',
      [summary.summary, JSON.stringify(summary.keywords), docId],
    );
  }
}
```

**知识扩展：withStructuredOutput vs 手动解析**

```
手动方式（不推荐）：
  const prompt = "请按 JSON 格式返回摘要，包含 title/summary/keywords/category 字段";
  const response = await llm.invoke(prompt);
  const result = JSON.parse(response.content); // 可能解析失败！
  // 问题：
  //   1. LLM 可能输出不规范 JSON（多逗号、少引号）
  //   2. 没有类型校验，可能缺少字段
  //   3. 每次都要写格式指令

withStructuredOutput（推荐）：
  const structuredLLM = llm.withStructuredOutput(schema);
  const result = await structuredLLm.invoke(prompt);
  // 好处：
  //   1. Schema 自动翻译成格式指令，LLM 输出更规范
  //   2. zod 自动校验，不符合 schema 抛异常
  //   3. TypeScript 类型自动推断，无需手动定义类型
  //   4. .describe() 帮助 LLM 理解每个字段该填什么
```

---

### 步骤 6.2：回答质量自评

```typescript
/**
 * 回答质量评估 Schema
 *
 * 职责：让 Agent 对自己的回答进行自我评估
 *
 * 流程：
 * 1. Agent 生成回答后，再用一次 withStructuredOutput 评估
 * 2. 如果 confidence 低或 needsMore 为 true，可以触发补充检索
 *
 * 关键细节：
 * - 这是 Agent 的"元认知"能力：知道自己知道什么、不知道什么
 * - confidence 用 0-1 的数值，配合 zod 的 .min() .max() 约束
 */
const answerQualitySchema = z.object({
  confidence: z.number().min(0).max(1).describe('回答的可信度，0表示完全不确定，1表示非常确定'),
  sources: z.array(z.string()).describe('回答所依据的文档标题列表'),
  needsMore: z.boolean().describe('是否需要更多信息来完善回答'),
  missingInfo: z.string().nullable().describe('缺少什么信息，needsMore为true时填写'),
});

const qualityLLM = new ChatOpenAI({
  model: 'qwen-plus',
  temperature: 0,
}).withStructuredOutput(answerQualitySchema);

async function evaluateAnswer(question: string, answer: string, context: string) {
  return qualityLLM.invoke(
    `请评估以下回答的质量：\n问题: ${question}\n回答: ${answer}\n参考上下文: ${context.substring(0, 1000)}`,
  );
}
```

**知识扩展：zod 数值字段的约束技巧**

```
z.number()               → 任意数字，LLM 可能输出 -5 或 999
z.number().min(0).max(1)  → 0 到 1 之间，LLM 输出更可控

为什么重要？
  zod 的约束不仅用于校验，还会被翻译成自然语言指令：
  "confidence: 数值类型，最小0，最大1" → LLM 知道应该输出 0.8 而不是 80

其他有用的约束：
  z.string().min(10).max(500) → 控制输出长度
  z.string().email()           → 邮箱格式校验
  z.array(z.string()).min(3)   → 至少3个元素
```

---

### 步骤 6.3：MCP 集成（知识库搜索暴露为 MCP Tool）

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

/**
 * MCP Server：将知识库搜索能力暴露为 MCP Tool
 *
 * 职责：让其他 AI 应用（如 Claude Desktop、Cursor）也能调用知识库搜索
 *
 * 流程：
 * 1. 创建 McpServer 实例
 * 2. 注册 knowledge_search 工具
 * 3. 通过 Stdio 传输启动
 *
 * 关键细节：
 * - MCP 是 Anthropic 提出的标准协议，用于 AI 应用之间的工具调用
 * - 与 LangChain Tool 的区别：MCP Tool 是跨应用的标准，LangChain Tool 只在 LangChain 内使用
 * - 本步骤将知识库搜索能力"标准化"，可以被任何支持 MCP 的客户端调用
 */

const server = new McpServer({
  name: 'knowledge-base',
  version: '1.0.0',
});

// 注册知识库搜索工具
server.tool(
  'knowledge_search',
  '在知识库中检索与问题相关的文档片段',
  { query: z.string().describe('搜索关键词或问题') },
  async ({ query }) => {
    // 这里调用 MilvusService.search
    // 实际项目中通过 HTTP API 调用后端服务
    const results = await fetch(
      `http://localhost:3000/chat/query`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: query }),
      },
    );
    const data = await results.json();
    return {
      content: [{ type: 'text', text: data.answer }],
    };
  },
);

// 启动 MCP Server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();
```

**知识扩展：MCP 的核心概念**

```
MCP (Model Context Protocol) 是 AI 应用之间的"USB 接口"：

  没有 MCP 之前：
    Claude → 只能用 Anthropic 提供的工具
    Cursor → 只能用内置的工具
    每个 AI 应用都是"孤岛"

  有了 MCP 之后：
    Claude → 调用 MCP Server → 获取外部能力（搜索、数据库、文件系统）
    Cursor → 调用同一个 MCP Server → 获取同样的能力

  MCP 的三个角色：
    Host（宿主）：Claude Desktop、Cursor 等 AI 应用
    Client（客户端）：Host 内部的 MCP 客户端
    Server（服务端）：提供工具能力的服务进程

  类比：
    MCP = USB 协议
    MCP Server = USB 设备（鼠标、键盘、U盘）
    MCP Client = 电脑的 USB 接口
    任何 USB 设备都能插入任何电脑 = 任何 MCP Server 都能被任何 Host 调用
```

**阶段六里程碑**：上传文档后自动提取结构化摘要，Agent 能自我评估回答质量，知识库搜索能力通过 MCP 暴露给外部应用

---

## 附录：完整项目启动流程

```bash
# 1. 启动基础设施
cd knowledge-base-assistant
docker compose up -d

# 2. 启动后端
cd server
pnpm install
cp .env.example .env  # 填入 API_KEY
pnpm start:dev

# 3. 启动前端
cd ../web
pnpm install
pnpm dev

# 4. 访问
# 前端: http://localhost:5173
# 后端: http://localhost:3000
```

## 附录：六阶段知识地图

```
阶段一 基础架构    → NestJS 模块化 + Docker + MySQL + Milvus 连接
    ↓
阶段二 文档向量化  → 文件解析 + 文本切分 + Embedding + Milvus 入库
    ↓
阶段三 基础 RAG    → 问题向量化 + 相似检索 + Prompt 组装 + LLM 生成
    ↓
阶段四 Agent 化    → Tool 定义 + ReAct 循环 + System Prompt + 错误处理
    ↓
阶段五 流式+记忆   → SSE 推送 + Agent 过程可视化 + 短期记忆 + MySQL 持久化
    ↓
阶段六 结构化+MCP  → withStructuredOutput + 质量自评 + MCP Tool 暴露
```

每个阶段都是在上一个阶段的基础上增加能力，不会推翻重来，符合渐进式学习的原则。
