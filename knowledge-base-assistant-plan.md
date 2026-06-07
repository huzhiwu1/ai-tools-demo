# 智能知识库助手 — 项目方案文档

## 一、项目概述

### 1.1 项目目标

构建一个基于 AI Agent 的智能知识库助手，用户上传文档后，Agent 能自主完成：
- 文档解析、切分、向量化入库
- 基于检索增强（RAG）回答用户问题
- 多步推理：判断是否需要检索 → 检索 → 判断是否充分 → 补充检索 → 生成回答

### 1.2 核心学习目标

| Agent 能力 | 练习重点 |
|------------|----------|
| RAG 检索增强 | 文档切分 → embedding → Milvus 相似搜索 → 上下文组装 |
| 工具调用 | 定义 Tool（zod schema + describe），LLM 自主选择工具 |
| ReAct 循环 | Thought → Action → Observation 多步推理 |
| 结构化输出 | withStructuredOutput + zod 做文档摘要、质量评估 |
| 流式输出 | SSE 推送 Agent 思考过程 |
| 记忆管理 | 短期记忆（对话窗口）+ 长期记忆（Milvus 持久化） |

### 1.3 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 后端框架 | NestJS 11 | IoC + 模块化，复用 hello-nest 经验 |
| 前端框架 | React + Vite + TypeScript | 基于已有 react-todo-app 经验 |
| LLM | qwen-plus（通义千问） | 通过 OpenAI 兼容接口调用 |
| Embedding | text-embedding-v3 | 阿里云 embedding，1024 维 |
| 向量数据库 | Milvus v2.6 | 复用现有 Docker Compose |
| 关系数据库 | MySQL 8 | 文档元数据 + 对话历史 |
| 文本切分 | @langchain/textsplitters | RecursiveCharacterTextSplitter |
| 数据校验 | zod | Tool 参数校验 + 结构化输出 schema |
| 包管理 | pnpm | monorepo 统一管理 |

---

## 二、系统架构

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────┐
│                   React 前端                         │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ 文档上传  │  │ 问答聊天(SSE) │  │ 文档管理/搜索  │  │
│  └─────┬────┘  └──────┬───────┘  └───────┬───────┘  │
└────────┼──────────────┼──────────────────┼───────────┘
         │              │                  │
         ▼              ▼                  ▼
┌─────────────────────────────────────────────────────┐
│                  NestJS 后端                         │
│                                                     │
│  ┌─────────────────────────────────────────────────┐│
│  │            DocumentsModule（文档管理）            ││
│  │  上传 → 解析 → 切分 → Embedding → 写入 Milvus   ││
│  └─────────────────────────────────────────────────┘│
│                                                     │
│  ┌─────────────────────────────────────────────────┐│
│  │             ChatModule（Agent 对话）              ││
│  │                                                 ││
│  │  ┌───────────┐   ┌──────────────────────────┐  ││
│  │  │ ReAct Agent│──▶│  Tools                   │  ││
│  │  │           │   │  - knowledge_search       │  ││
│  │  │ 感知→思考  │   │  - document_query         │  ││
│  │  │ →行动循环  │   │  - direct_answer          │  ││
│  │  └───────────┘   └──────────────────────────┘  ││
│  │                                                 ││
│  │  ┌───────────┐   ┌──────────────────────────┐  ││
│  │  │ Memory    │   │  SSE 流式输出              │  ││
│  │  │ 短期+长期  │   │  推送 Agent 每步状态       │  ││
│  │  └───────────┘   └──────────────────────────┘  ││
│  └─────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────┘
         │              │
         ▼              ▼
┌──────────────┐ ┌──────────────┐
│   MySQL 8    │ │   Milvus     │
│              │ │              │
│ - documents  │ │ - knowledge_ │
│ - chat_      │ │   chunks     │
│   sessions   │ │   (embedding)│
│ - messages   │ │              │
└──────────────┘ └──────────────┘
      Docker        Docker
```

### 2.2 数据流

**文档入库流：**
```
用户上传文件
  → NestJS 接收文件（multer）
  → 解析为纯文本（txt/md/pdf）
  → RecursiveCharacterTextSplitter 切分
  → OpenAI Embedding API 向量化
  → 写入 Milvus（content + embedding + doc_id）
  → 更新 MySQL 文档状态为 indexed
```

**Agent 问答流：**
```
用户提问
  → Agent 感知：接收问题 + 对话历史
  → Agent 思考：LLM 决定是否需要调用工具
  → Agent 行动：
      ├─ knowledge_search → Milvus 检索相关 chunk
      ├─ document_query   → MySQL 查询文档元数据
      └─ direct_answer    → 直接基于上下文回答
  → 判断是否充分 → 不充分则继续循环
  → 生成最终回答 → SSE 流式推送给前端
```

---

## 三、数据库设计

### 3.1 MySQL 表结构

**documents 表 — 文档元数据**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INT AUTO_INCREMENT | 主键 |
| title | VARCHAR(255) | 文档标题 |
| file_path | VARCHAR(512) | 文件存储路径 |
| file_type | VARCHAR(20) | 文件类型（txt/md/pdf） |
| status | VARCHAR(20) | 状态：uploading / indexing / indexed / failed |
| chunk_count | INT | 切分块数 |
| summary | TEXT | AI 生成的文档摘要 |
| keywords | JSON | AI 提取的关键词 |
| created_at | DATETIME | 创建时间 |
| updated_at | DATETIME | 更新时间 |

**chat_sessions 表 — 对话会话**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INT AUTO_INCREMENT | 主键 |
| session_id | VARCHAR(64) | 会话唯一标识（UUID） |
| title | VARCHAR(255) | 会话标题 |
| created_at | DATETIME | 创建时间 |

**messages 表 — 对话消息**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INT AUTO_INCREMENT | 主键 |
| session_id | VARCHAR(64) | 关联会话 |
| role | VARCHAR(20) | 角色：user / assistant / tool |
| content | TEXT | 消息内容 |
| tool_name | VARCHAR(64) | 工具名称（tool 消息时） |
| step_index | INT | Agent 步骤序号 |
| created_at | DATETIME | 创建时间 |

### 3.2 Milvus Collection

**knowledge_chunks — 知识块向量**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INT64 | 主键（auto_id） |
| content | VARCHAR(2048) | 文本内容 |
| doc_id | INT64 | 关联文档 ID |
| doc_title | VARCHAR(255) | 文档标题（冗余，减少回表） |
| chunk_index | INT32 | 在原文中的块序号 |
| embedding | FLOAT_VECTOR(1024) | 文本向量 |

索引：IVF_FLAT，metric_type: COSINE，nlist: 1024

---

## 四、NestJS 模块设计

### 4.1 模块划分

```
src/
├── app.module.ts              # 根模块
├── main.ts                    # 启动入口
│
├── documents/                  # 文档管理模块
│   ├── documents.module.ts
│   ├── documents.controller.ts    # 上传、列表、删除
│   ├── documents.service.ts       # 业务编排
│   ├── document-parser.service.ts # 文件解析（txt/md/pdf）
│   ├── document-chunker.service.ts# 文本切分
│   └── dto/
│       └── upload-response.dto.ts
│
├── chat/                       # Agent 对话模块
│   ├── chat.module.ts
│   ├── chat.controller.ts         # 问答接口（普通 + SSE）
│   ├── chat.service.ts            # Agent 编排
│   ├── agent/
│   │   ├── react-agent.ts         # ReAct Agent 主类
│   │   ├── agent-state.ts         # Agent 状态定义
│   │   └── prompts.ts             # 集中管理 Prompt
│   ├── tools/
│   │   ├── knowledge-search.tool.ts   # Milvus 检索工具
│   │   ├── document-query.tool.ts     # MySQL 文档查询工具
│   │   └── direct-answer.tool.ts      # 直接回答工具
│   └── memory/
│       └── chat-memory.service.ts # 短期 + 长期记忆管理
│
├── milvus/                     # Milvus 向量库模块
│   ├── milvus.module.ts
│   └── milvus.service.ts          # 连接、建表、insert、search
│
├── database/                   # MySQL 数据库模块
│   ├── database.module.ts
│   └── database.service.ts        # 连接池、CRUD
│
└── common/                     # 公共模块
    ├── config/
    │   └── configuration.ts       # 环境变量配置
    └── types/
        └── index.ts               # 公共类型定义
```

### 4.2 模块依赖关系

```
AppModule
  ├── DocumentsModule ──→ MilvusModule, DatabaseModule
  ├── ChatModule ──────→ MilvusModule, DatabaseModule
  ├── MilvusModule
  └── DatabaseModule
```

### 4.3 核心 API 设计

**文档管理**

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /documents/upload | 上传文档（multipart/form-data） |
| GET | /documents | 文档列表 |
| GET | /documents/:id | 文档详情（含摘要、关键词） |
| DELETE | /documents/:id | 删除文档（同时清理 Milvus 中的 chunk） |

**Agent 对话**

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /chat/query | 普通问答（返回完整结果） |
| GET | /chat/stream | SSE 流式问答（推送 Agent 过程） |
| GET | /chat/sessions | 会话列表 |
| GET | /chat/sessions/:id/messages | 历史消息 |

---

## 五、Agent 核心设计

### 5.1 ReAct 循环

```
用户提问
    │
    ▼
┌─────────────────────────────┐
│ Step 1: 感知（Perceive）     │
│ 接收问题 + 对话历史 + 工作记忆 │
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│ Step 2: 思考（Think）        │
│ LLM 决定：                   │
│ - 是否需要调用工具？          │
│ - 调用哪个工具？              │
│ - 参数是什么？                │
└─────────────┬───────────────┘
              │
        ┌─────┴─────┐
        │           │
   不需要工具     需要工具
        │           │
        ▼           ▼
   直接回答    ┌──────────────────┐
              │ Step 3: 行动（Act）│
              │ 执行 Tool          │
              │ 返回 Observation   │
              └────────┬─────────┘
                       │
                       ▼
              ┌──────────────────┐
              │ 判断是否充分？     │
              │ - 充分 → 生成回答  │
              │ - 不充分 → 回到 Step 2 │
              └──────────────────┘
```

### 5.2 Agent 状态定义

```typescript
interface AgentState {
  task: string;              // 用户原始问题
  history: ReActStep[];      // 已执行的步骤
  chatHistory: Message[];    // 对话历史（短期记忆）
  currentStep: number;       // 当前步数
  isComplete: boolean;       // 是否完成
}

interface ReActStep {
  thought: string;           // LLM 的推理过程
  action?: {                 // 工具调用（最后一步可能没有）
    tool: string;            // 工具名
    input: Record<string, unknown>; // 工具参数
  };
  observation?: string;      // 工具返回结果
}
```

### 5.3 工具定义

**Tool 1: knowledge_search**

```
名称：knowledge_search
描述：在知识库中检索与问题相关的文档片段。当用户的问题涉及已上传文档的内容时使用。
参数：
  - query (string): 搜索关键词或问题
  - topK (number): 返回结果数量，默认 5
```

**Tool 2: document_query**

```
名称：document_query
描述：查询知识库中的文档元数据信息（标题、摘要、状态等）。当用户询问有哪些文档、文档概要时使用。
参数：
  - keyword (string): 文档标题关键词
  - status (string): 文档状态筛选（indexed/uploading/failed）
```

**Tool 3: direct_answer**

```
名称：direct_answer
描述：当问题不需要检索知识库时（如闲聊、常识问题），直接回答。
参数：
  - answer (string): 回答内容
```

### 5.4 System Prompt 设计

```
你是智能知识库助手，帮助用户回答关于已上传文档的问题。

## 可用工具
1. knowledge_search: 在知识库中检索相关文档片段，当问题涉及文档内容时使用
2. document_query: 查询文档元数据（标题、摘要、状态），当用户问有哪些文档时使用
3. direct_answer: 当问题不需要检索知识库时直接回答

## 使用规则
- 涉及文档内容的问题，必须先调用 knowledge_search 检索，不能凭记忆回答
- 如果第一次检索结果不充分，可以换关键词再次检索
- 闲聊或常识问题，使用 direct_answer
- 每次检索后，基于检索结果回答，不要编造文档中没有的内容
- 最多执行 5 步，避免无限循环

## 输出格式
- Thought: 你的推理过程
- Action: 要调用的工具及参数（如有）
- Final Answer: 最终回答（最后一步）
```

---

## 六、前端设计

### 6.1 页面结构

```
┌─────────────────────────────────────────────┐
│  智能知识库助手                    [管理] [设置] │
├─────────────┬───────────────────────────────┤
│             │                               │
│  文档列表    │       问答聊天区               │
│             │                               │
│  📄 技术文档  │  ┌───────────────────────┐   │
│  📄 产品需求  │  │ Agent 思考过程（折叠）   │   │
│  📄 API 手册  │  │ 🔍 检索到 3 个相关片段   │   │
│             │  │ 💭 基于检索结果分析...    │   │
│  ─────────  │  └───────────────────────┘   │
│  [+ 上传文档] │                               │
│             │  🤖 根据文档内容，答案是...      │
│             │                               │
│             │  ┌───────────────────────┐   │
│             │  │ 输入你的问题...    发送 │   │
│             │  └───────────────────────┘   │
└─────────────┴───────────────────────────────┘
```

### 6.2 核心组件

| 组件 | 职责 |
|------|------|
| DocumentList | 左侧文档列表，上传、删除、查看状态 |
| ChatPanel | 右侧聊天区，消息展示 + 输入框 |
| AgentProcess | Agent 思考过程展示（可折叠），SSE 实时更新 |
| MessageBubble | 单条消息气泡（区分 user/assistant/tool） |
| UploadModal | 文档上传弹窗，支持拖拽 |
| DocumentDetail | 文档详情（摘要、关键词、chunk 预览） |

### 6.3 SSE 流式交互

```
前端                          后端
  │                            │
  │── GET /chat/stream ───────▶│
  │                            │── Agent Step 1: Thought
  │◀── event: thought ─────────│
  │                            │── Agent Step 2: Action
  │◀── event: action ──────────│
  │                            │── Tool 执行中...
  │◀── event: observation ─────│
  │                            │── Agent Step 3: 生成回答
  │◀── event: answer (chunk) ──│
  │◀── event: answer (chunk) ──│
  │◀── event: done ────────────│
```

---

## 七、环境配置

### 7.1 环境变量

```env
# LLM 配置（复用现有）
MODEL_NAME=qwen-plus
BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
API_KEY=sk-xxx

# Embedding 配置（复用现有）
EMBEDDINGS_MODEL_NAME=text-embedding-v3
EMBEDDINGS_DIMENSIONS=1024

# Milvus 配置（复用现有）
MILVUS_ADDRESS=127.0.0.1:19530
COLLECTION_NAME=knowledge_chunks

# MySQL 配置（新增）
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=123456
MYSQL_DATABASE=knowledge_base

# 切分配置
CHUNK_SIZE=500
CHUNK_OVERLAP=50

# Agent 配置
MAX_STEPS=5
TOOL_TIMEOUT=5000
```

### 7.2 Docker Compose（在现有基础上新增 MySQL）

```yaml
services:
  # 复用现有 Milvus 相关服务（etcd, minio, standalone）
  # ...

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
    command: --default-authentication-plugin=caching_sha2_password
```

---

## 八、六阶段实施计划

### 阶段一：基础架构搭建（预计 2-3 小时）

| 步骤 | 内容 | 验证标准 |
|------|------|----------|
| 1.1 | 创建 NestJS 项目 `knowledge-base-assistant/server` | `pnpm start:dev` 能启动 |
| 1.2 | Docker Compose 新增 MySQL 服务 | MySQL 容器 healthy |
| 1.3 | NestJS DatabaseModule 连接 MySQL，建 documents/chat_sessions/messages 表 | 能执行 CRUD |
| 1.4 | NestJS MilvusModule 连接 Milvus，创建 knowledge_chunks collection | 能 insert + search |
| 1.5 | 创建 React 前端项目 `knowledge-base-assistant/web` | 页面能打开 |

**里程碑**：后端启动无报错，两个数据库都能连接

### 阶段二：文档上传与向量化（预计 3-4 小时）

| 步骤 | 内容 | 验证标准 |
|------|------|----------|
| 2.1 | DocumentsController 上传接口，multer 接收文件 | 文件保存到本地 |
| 2.2 | DocumentParserService：支持 txt、md 解析 | 输出纯文本 |
| 2.3 | DocumentChunkerService：RecursiveCharacterTextSplitter 切分 | 切分结果合理 |
| 2.4 | 调用 OpenAI Embedding API 向量化 | 拿到 float[] |
| 2.5 | 写入 Milvus + 更新 MySQL 状态 | 完整链路跑通 |
| 2.6 | 前端上传页面 + 文档列表 | 上传后能看到文档 |

**里程碑**：上传一个 txt 文件，Milvus 中能搜到相关 chunk

### 阶段三：基础 RAG 问答（预计 2-3 小时）

| 步骤 | 内容 | 验证标准 |
|------|------|----------|
| 3.1 | ChatController 问答接口 POST /chat/query | 接口可调 |
| 3.2 | 问题向量化 → Milvus topK=5 检索 | 返回相关 chunk |
| 3.3 | 组装 Prompt（system + context + question）→ ChatOpenAI | 回答相关 |
| 3.4 | 前端基础聊天界面 | 能问答 |

**里程碑**：问文档相关问题，能基于文档内容回答

### 阶段四：Agent 化（核心，预计 4-5 小时）

| 步骤 | 内容 | 验证标准 |
|------|------|----------|
| 4.1 | 定义 3 个 Tool（zod schema + describe） | LLM 能识别 |
| 4.2 | 定义 AgentState 接口 | 状态可追踪 |
| 4.3 | 实现 ReAct 循环（maxSteps=5） | 多步推理正确 |
| 4.4 | 编写 System Prompt | tool_call 准确 |
| 4.5 | 错误处理：maxSteps 上限 + tool 超时 + 降级 | 异常不崩溃 |
| 4.6 | 场景验证：简单问题→直接回答，文档问题→检索回答，多步→多次检索 | 三种场景 OK |

**里程碑**：Agent 能根据问题自主选择工具，多步推理正确

### 阶段五：流式输出 + 记忆（预计 3-4 小时）

| 步骤 | 内容 | 验证标准 |
|------|------|----------|
| 5.1 | NestJS SSE 端点，推送 Agent 每步状态 | EventSource 能收到 |
| 5.2 | Agent 步骤结构化日志 | 日志可追踪 |
| 5.3 | 短期记忆（InMemoryChatMessageHistory，最近 10 轮） | 多轮对话有上下文 |
| 5.4 | MySQL 持久化对话历史 | 刷新不丢失 |
| 5.5 | 前端 SSE 展示：思考过程 + 流式回答 | 体验流畅 |

**里程碑**：多轮对话流畅，能看到 Agent 思考过程

### 阶段六：结构化输出 + 高级功能（预计 3-4 小时）

| 步骤 | 内容 | 验证标准 |
|------|------|----------|
| 6.1 | withStructuredOutput 提取文档摘要/关键词 | 结构化数据准确 |
| 6.2 | 回答质量自评（confidence, sources, needsMore） | 评估结果合理 |
| 6.3 | 智能推荐相关文档 | 推荐相关 |
| 6.4 | MCP 集成：知识库搜索暴露为 MCP Tool | 外部可调用 |

**里程碑**：完整的智能知识库助手，具备文档管理 + Agent 问答 + 流式输出 + 结构化提取

---

## 九、项目目录结构

```
knowledge-base-assistant/
├── docker-compose.yml          # MySQL + Milvus
├── .env                        # 环境变量
│
├── server/                     # NestJS 后端
│   ├── src/
│   │   ├── app.module.ts
│   │   ├── main.ts
│   │   ├── documents/          # 文档管理模块
│   │   ├── chat/               # Agent 对话模块
│   │   ├── milvus/             # Milvus 模块
│   │   ├── database/           # MySQL 模块
│   │   └── common/             # 公共模块
│   ├── uploads/                # 上传文件存储
│   ├── package.json
│   ├── tsconfig.json
│   └── nest-cli.json
│
├── web/                        # React 前端
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── DocumentList.tsx
│   │   │   ├── ChatPanel.tsx
│   │   │   ├── AgentProcess.tsx
│   │   │   └── UploadModal.tsx
│   │   ├── services/
│   │   │   └── api.ts          # 后端 API 调用
│   │   └── types/
│   │       └── index.ts
│   ├── package.json
│   ├── vite.config.ts
│   └── tsconfig.json
│
└── README.md
```

---

## 十、关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| ORM 方案 | mysql2（不用 TypeORM） | 项目简单，手写 SQL 更透明，避免 ORM 黑盒 |
| 文件存储 | 本地文件系统 | 小项目无需对象存储，NestJS 通过 ServeStaticModule 暴露 |
| Agent 框架 | 手写 ReAct（不用 LangGraph） | 学习目的，手写更能理解 Agent 循环本质 |
| 向量库索引 | IVF_FLAT + COSINE | 中小规模数据，IVF_FLAT 足够，COSINE 适合语义搜索 |
| 前端状态 | useState + Context | 项目规模小，无需引入 Redux |
| 前端 UI 库 | 无（手写 CSS） | 学习项目，保持简单 |
| chunk_size | 500 | 平衡检索精度和上下文完整度 |
| topK | 5 | 返回 5 个最相关片段，覆盖多数场景 |
