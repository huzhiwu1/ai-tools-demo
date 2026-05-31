# 📚 hello-nest-langchain 知识扩展手册

> 这是配套 [README.md](./README.md) 的**纯知识文档**。README 教你"怎么跑"，本文档教你"为什么这样设计、底层在做什么"。
>
> 推荐阅读顺序：先按 README 跑通六站 → 再回来逐章细读。

---

## 目录

1. [Nest.js IoC 与依赖注入（DI）](#1-nestjs-ioc-与依赖注入di)
2. [Provider 四种写法对比](#2-provider-四种写法对比)
3. [模块封装与全局共享](#3-模块封装与全局共享)
4. [LangChain LCEL 链组装范式](#4-langchain-lcel-链组装范式)
5. [Server-Sent Events（SSE）协议详解](#5-server-sent-eventssse协议详解)
6. [Nest @Sse 装饰器底层做了什么](#6-nest-sse-装饰器底层做了什么)
7. [AsyncGenerator → Observable 适配](#7-asyncgenerator--observable-适配)
8. [常见踩坑与排查](#8-常见踩坑与排查)

---

## 1. Nest.js IoC 与依赖注入（DI）

### 概念区分

- **IoC（Inversion of Control，控制反转）**：对象的创建权交给容器，不再由开发者手动 `new`。
- **DI（Dependency Injection，依赖注入）**：容器把"你需要的依赖"主动塞给消费者。
- 两者关系：DI 是 IoC 的一种**实现手段**。

### Nest 的 IoC 容器构建时机

```
NestFactory.create(AppModule)
   ↓
扫描所有 @Module / @Injectable / @Controller 的元数据（reflect-metadata）
   ↓
解析依赖关系图（拓扑排序）
   ↓
按顺序实例化 Provider（默认单例）
   ↓
应用准备就绪，可以 listen 端口
```

### 为什么要用 IoC/DI？

| 不用 IoC（手写 new）                           | 用 IoC                  |
| ---------------------------------------------- | ----------------------- |
| `new BookService(new BookRepository())` 到处写 | 容器自动注入            |
| 改造一个底层依赖要改 N 处                      | 只改一处 Provider 配置  |
| 单元测试需要手动 mock 整条依赖链               | 测试时直接替换 Provider |

---

## 2. Provider 四种写法对比

| 写法                     | 何时用                           | 典型示例                                                                                     |
| ------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------- |
| **useClass**（默认简写） | 90% 的情况，直接挂个类           | `providers: [BookService]`                                                                   |
| **useValue**             | 注入常量、配置对象、Mock 测试    | `{ provide: 'CFG', useValue: { ttl: 60 } }`                                                  |
| **useFactory**           | 需要异步或读环境变量才能创建     | `{ provide: 'CHAT_MODEL', useFactory: cfg => new ChatOpenAI(...), inject: [ConfigService] }` |
| **useExisting**          | 给已有 Provider 起一个别名 Token | `{ provide: 'ALIAS', useExisting: RealService }`                                             |

### useFactory 关键要点

```ts
{
  provide: 'CHAT_MODEL',
  useFactory: (configService: ConfigService) => {
    return new ChatOpenAI({ /* ... */ });
  },
  inject: [ConfigService],   // ① 顺序决定工厂参数顺序
}
```

- **inject 数组顺序 = 工厂函数参数顺序**
- 工厂函数可以是 `async`，方便启动前预热（如建立数据库连接、加载向量库）
- 注入键（Token）可以是字符串或 Symbol；生产推荐用单独 `tokens.ts` 维护 `const`，避免到处拼写错误

### 两种"消费"方式

```ts
// ✅ 推荐：构造器注入
constructor(private readonly bookSvc: BookService) {}

// ⚠️ 特殊场景：属性注入（用于字符串/Symbol Token，或不想改构造器签名）
@Inject('BOOK_REPOSITORY') private readonly repo: any;
```

---

## 3. 模块封装与全局共享

### 默认封装规则

- 一个 Provider 必须被某 Module 声明在 `providers` 数组里，才会被 IoC 管理
- 模块默认是"封装"的：A 模块的 Provider，B 模块要用，必须 A 把它放进 `exports`

### 全局模块（绕开封装）

```ts
ConfigModule.forRoot({ isGlobal: true });
```

- `isGlobal: true` 让 `ConfigService` 全局可注入，免去到处 `imports: [ConfigModule]`
- 谨慎使用：滥用会破坏模块边界

### forRoot vs forFeature 命名约定

| 命名           | 作用                     | 例子                                         |
| -------------- | ------------------------ | -------------------------------------------- |
| `forRoot()`    | 根模块的"全局一次性"配置 | `TypeOrmModule.forRoot({ host, port, ... })` |
| `forFeature()` | 子模块的"局部增量"配置   | `TypeOrmModule.forFeature([UserEntity])`     |

---

## 4. LangChain LCEL 链组装范式

### 三件套

```ts
const prompt = PromptTemplate.fromTemplate('请回答：{query}');
const model  = new ChatOpenAI({ ... });
const parser = new StringOutputParser();

const chain = prompt.pipe(model).pipe(parser);
```

### 类型流（input → output）

```
{ query: string }
   ↓ PromptTemplate
ChatPromptValue
   ↓ ChatOpenAI
AIMessage（content + 元数据）
   ↓ StringOutputParser
string
```

### 三种调用方式

| 调用                    | 返回                  | 适用场景                     |
| ----------------------- | --------------------- | ---------------------------- |
| `chain.invoke(input)`   | 完整 string           | 后台任务、邮件生成、定时报表 |
| `chain.stream(input)`   | AsyncIterable<string> | 聊天机器人、打字机效果       |
| `chain.batch(inputs[])` | string[] 并发         | 批量翻译、批量摘要           |

### ⚠️ 性能规范

```ts
// ✅ 正确：构造器里组装一次，存为类字段
constructor(@Inject('CHAT_MODEL') model) {
  this.chain = prompt.pipe(model).pipe(parser);
}

// ❌ 错误：每个请求重新组装，浪费 GC 与初始化开销
async runChain(query) {
  const chain = prompt.pipe(model).pipe(parser); // 别这么写！
  return chain.invoke({ query });
}
```

---

## 5. Server-Sent Events（SSE）协议详解

### 协议本质

SSE = HTTP 之上的**服务器单向推送协议**。不是新协议，就是一个长连接的 HTTP 响应。

### 报文格式（这是关键！）

服务器响应头：

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

响应体（每条消息以双换行分隔）：

```
data: 你好
<空行>
data: 世界
<空行>
event: done
data: 结束
<空行>
```

### SSE vs WebSocket

| 维度     | SSE                                  | WebSocket                       |
| -------- | ------------------------------------ | ------------------------------- |
| 方向     | **服务器→客户端 单向**               | 双向                            |
| 协议     | HTTP（无需升级协议）                 | ws（独立协议，需 Upgrade 握手） |
| 复杂度   | 极低（浏览器原生 EventSource）       | 中（要自己处理心跳/重连/鉴权）  |
| 自动重连 | ✅ 内建                              | ❌ 需自己实现                   |
| 适用场景 | **LLM 流式输出**、行情推送、消息通知 | 聊天室、协同编辑、游戏          |

> AI 流式回答只需"服务器→浏览器"单向推送 → SSE 是绝配。

---

## 6. Nest @Sse 装饰器底层做了什么

```ts
@Sse('chat/stream')
chatStream(@Query('query') q: string): Observable<{ data: string }> {
  return from(this.aiService.streamChain(q)).pipe(
    map((chunk) => ({ data: chunk })),
  );
}
```

Nest 在底层会：

1. **设置响应头**：`Content-Type: text/event-stream`
2. **订阅 Observable**：每次 `next` 时按 SSE 协议写一行 `data: <JSON.stringify(对象)>`
3. **complete 时**自动关闭连接
4. **error 时**发送 `event: error` 并关闭

### 几个铁律

- ❌ `@Sse` 接口不能 `return` 普通对象 / Promise，**必须 return Observable**
- ✅ 返回的对象形如 `{ data: '<推送内容>' }`；`data` 是固定字段名
- ⚠️ Nest 默认会把 `data` 字段做 `JSON.stringify`，所以前端拿到的是带引号的 JSON 字符串，需要 `JSON.parse` 还原

---

## 7. AsyncGenerator → Observable 适配

LangChain 的 `chain.stream()` 返回 `AsyncIterable<string>`，但 Nest `@Sse` 要求 `Observable`。RxJS 的 `from()` 是万能桥梁：

```ts
import { from, map } from 'rxjs';

// AsyncGenerator → Observable
from(asyncGen).pipe(map(chunk => ({ data: chunk })));
```

### 为什么这能行

`from()` 能识别四种输入：

1. Promise → Observable<T>
2. Iterable → Observable<T>
3. **AsyncIterable → Observable<T>** ← 我们用的这个
4. Observable → 直接返回

### 完整链路图

```
PromptTemplate ─pipe→ ChatOpenAI ─pipe→ StringOutputParser
                              ↓
                    chain.stream({query})  ← AsyncIterable<string>
                              ↓
                          from(...)        ← RxJS 转换
                              ↓
                          .pipe(map)       ← 包装成 { data: chunk }
                              ↓
                          @Sse 订阅        ← Nest 按 SSE 协议推送
                              ↓
                       浏览器 EventSource  ← onmessage 事件
                              ↓
                        前端 DOM 拼接渲染
```

---

## 8. 常见踩坑与排查

### 8.1 ChatOpenAI 卡住没反应

| 原因                     | 排查                                                      |
| ------------------------ | --------------------------------------------------------- |
| `apiKey` 写错            | 终端 `echo $API_KEY` 检查                                 |
| `baseURL` 大小写错       | **必须是 `baseURL`（驼峰）**，不是 `base_url` / `baseUrl` |
| `BASE_URL` 漏 `/v1` 后缀 | 通义千问需 `/compatible-mode/v1`                          |

### 8.2 SSE 在浏览器收不到

| 原因                           | 解决                      |
| ------------------------------ | ------------------------- |
| Nginx 反代默认开 buffer        | 加 `proxy_buffering off;` |
| 浏览器 EventSource 不支持 POST | `@Sse` 接口必须是 GET     |
| CORS 跨域                      | `app.enableCors()`        |

### 8.3 找不到模块 @nestjs/common

依赖未装。`cd src/hello-nest && pnpm install`。

### 8.4 端口被占用 EADDRINUSE

改 `.env` 的 `PORT=3001` 重启。

### 8.5 装饰器报错 / 元数据缺失

确认 `tsconfig.json` 中：

- `experimentalDecorators: true`
- `emitDecoratorMetadata: true`

并且入口文件最顶部：`import 'reflect-metadata'`（Nest 已自动处理，无需手动加）。

---

## 🔗 延伸阅读

- [Nest 官方文档 · Custom providers](https://docs.nestjs.com/fundamentals/custom-providers)
- [LangChain JS 文档 · LCEL](https://js.langchain.com/docs/concepts/lcel)
- [MDN · Server-sent events](https://developer.mozilla.org/zh-CN/docs/Web/API/Server-sent_events)
- [RxJS · from operator](https://rxjs.dev/api/index/function/from)
