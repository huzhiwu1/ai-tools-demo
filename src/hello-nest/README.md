# hello-nest-langchain · 小白入门六站式教学

> 一个用 **Nest.js + LangChain LCEL** 构建的 AI 后端入门项目，按"六站式"渐进学习路径设计，每个文件都有详细注释、关键步骤、知识扩展和小白注意点。

📖 想深入理解每个概念的"为什么"？请配套阅读 **[KNOWLEDGE.md（知识扩展手册）](./KNOWLEDGE.md)**。

## 🎯 学完你将掌握

- Nest.js 的核心概念：模块、控制器、服务、IoC 容器、依赖注入
- 三种自定义 Provider：`useClass` / `useValue` / `useFactory`
- 用 LangChain LCEL 用 `.pipe()` 组装"提示词→模型→解析器"链
- 把 LangChain 流式输出包装成 SSE 接口，前端用 `EventSource` 消费

## 📚 学习路线（推荐按顺序读代码）

| 站点       | 文件                                                                                                                             | 学习要点                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 第一站     | [src/main.ts](./src/main.ts)                                                                                                     | 启动入口、bootstrap、NestFactory                   |
| 第二站     | [src/app.module.ts](./src/app.module.ts) + [app.controller.ts](./src/app.controller.ts) + [app.service.ts](./src/app.service.ts) | @Module / @Controller / @Injectable 三大装饰器     |
| 第三站     | [src/book/](./src/book/)                                                                                                         | DI、自定义 Provider、useFactory、Token 注入、CRUD  |
| 第四站 - ① | [src/ai/ai.module.ts](./src/ai/ai.module.ts)                                                                                     | useFactory + ConfigService 注入 ChatOpenAI         |
| 第四站 - ② | [src/ai/ai.service.ts](./src/ai/ai.service.ts)                                                                                   | LangChain LCEL `.pipe()` 链、`invoke` vs `stream`  |
| 第四站 - ③ | [src/ai/ai.controller.ts](./src/ai/ai.controller.ts)                                                                             | @Sse 装饰器、SSE 协议、AsyncGenerator → Observable |
| 第五站     | [public/sse-test.html](./public/sse-test.html)                                                                                   | 前端 EventSource 消费 SSE                          |

## 🛠️ 快速开始

### 1. 安装依赖

```bash
cd src/hello-nest
pnpm install     # 或 npm install
```

### 2. 配置环境变量

复制模板：

```bash
cp .env.example .env
```

编辑 `.env`，填入你的模型配置（兼容通义千问 / DeepSeek / Kimi 等任何 OpenAI 兼容协议）：

```ini
API_KEY=sk-xxx
BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MODEL_NAME=qwen-plus
```

> 💡 项目根目录已有 `.env`，本项目会自动回退读取根目录配置，无需重复填写。

### 3. 启动

```bash
pnpm start:dev      # 开发模式（热更新）
```

看到下面这两行说明启动成功：

```
🚀 服务已启动: http://localhost:3000
📄 SSE 测试页面: http://localhost:3000/sse-test.html
```

## 🧪 接口速查 / 自测

### Hello

```bash
curl http://localhost:3000
```

### 图书 CRUD（第三站）

```bash
# 查全部
curl http://localhost:3000/book

# 查单本
curl http://localhost:3000/book/1

# 新建
curl -X POST -H "Content-Type: application/json" \
  -d '{"title":"《Nest 进阶》"}' \
  http://localhost:3000/book

# 更新
curl -X PATCH -H "Content-Type: application/json" \
  -d '{"title":"新标题"}' \
  http://localhost:3000/book/1

# 删除
curl -X DELETE http://localhost:3000/book/1
```

### AI 普通对话（第四站 - 一次性）

```bash
curl "http://localhost:3000/ai/chat?query=你好，自我介绍一下"
```

### AI 流式对话（第四站 - SSE）

**方法 1：用 curl 看原始流**

```bash
curl -N "http://localhost:3000/ai/chat/stream?query=讲一个程序员笑话"
```

**方法 2：浏览器打开测试页（推荐）**

直接访问 <http://localhost:3000/sse-test.html>，输入问题点"开始"，看到打字机效果。

## 🧱 项目结构

```
src/hello-nest/
├── package.json              # 依赖与脚本
├── tsconfig.json             # TS 编译配置
├── nest-cli.json             # Nest CLI 配置
├── .env.example              # 环境变量模板
├── public/
│   └── sse-test.html         # 第五站：前端 SSE 测试页
└── src/
    ├── main.ts               # 第一站：启动入口
    ├── app.module.ts         # 第二站：根模块
    ├── app.controller.ts
    ├── app.service.ts
    ├── book/                 # 第三站：DI + CRUD 范式
    │   ├── book.module.ts
    │   ├── book.controller.ts
    │   ├── book.service.ts
    │   ├── dto/
    │   │   ├── create-book.dto.ts
    │   │   └── update-book.dto.ts
    │   └── entities/
    │       └── book.entity.ts
    └── ai/                   # 第四站：LangChain LCEL + SSE
        ├── ai.module.ts
        ├── ai.controller.ts
        └── ai.service.ts
```

## 🧠 核心概念速记

### IoC 与 DI

- **IoC（Inversion of Control，控制反转）**：对象的创建权交给容器，不再由你 `new`。
- **DI（Dependency Injection，依赖注入）**：容器把"你需要的依赖"主动塞给你。
- Nest 的 IoC 容器在 `NestFactory.create()` 时构建完成。

### Provider 三种写法

| 写法         | 示例                                                                                         | 适用场景             |
| ------------ | -------------------------------------------------------------------------------------------- | -------------------- |
| `useClass`   | `BookService` 简写                                                                           | 90% 情况             |
| `useValue`   | `{ provide: 'CFG', useValue: {...} }`                                                        | 配置对象、Mock 测试  |
| `useFactory` | `{ provide: 'CHAT_MODEL', useFactory: cfg => new ChatOpenAI(...), inject: [ConfigService] }` | 需要异步或读环境变量 |

### LCEL 链路

```
PromptTemplate  ─pipe→  ChatOpenAI  ─pipe→  StringOutputParser
   { query }              ChatPromptValue        AIMessage           string
```

调用方式有 3 种：

- `chain.invoke(input)` —— 一次性返回
- `chain.stream(input)` —— 异步迭代器流式返回
- `chain.batch(inputs[])` —— 批量并发返回

### SSE vs WebSocket

| 维度       | SSE                    | WebSocket         |
| ---------- | ---------------------- | ----------------- |
| 方向       | 服务器→客户端 单向     | 双向              |
| 协议       | HTTP                   | ws                |
| 浏览器 API | EventSource（原生）    | WebSocket（原生） |
| 复杂度     | 低                     | 中                |
| 适用       | LLM 流式输出、行情推送 | 聊天室、协同编辑  |

## ❓ 常见问题

**Q: 启动报"找不到模块 @nestjs/common"？**
A: 还没装依赖，运行 `pnpm install`。

**Q: AI 接口报 401 / 认证失败？**
A: 检查 `.env` 的 `API_KEY` 是否正确、`BASE_URL` 是否漏写 `/v1` 后缀。

**Q: SSE 接口收不到内容？**
A: 浏览器开 DevTools → Network → 选中流式请求 → 看 EventStream 标签页。常见原因是反向代理（Nginx）默认开了 buffer，需加 `proxy_buffering off`。

**Q: 端口被占用？**
A: 在 `.env` 改 `PORT=3001` 重启即可。

## 📦 参考来源

源项目：<https://github.com/QuarkGluonPlasma/ai-agent-course-code/tree/main/hello-nest-langchain>

本项目在原有结构上做了以下"小白友好化"改造：

- 全部文件加了"职责 / 关键步骤 / 知识扩展 / 小白注意"四段注释
- BookModule 工厂函数补全了完整 CRUD（原项目仅 findAll）
- AiModule 兼容两套环境变量命名（`OPENAI_*` 与 `API_KEY`/`BASE_URL`）
- 前端 SSE 测试页加了"停止"按钮、JSON 解析处理
- 增加了 README 学习路线、接口速查、核心概念速记
