# Qoder 任务：全链路日志埋点（NestJS Logger，方案 A）

> 项目：`/Users/huzhiwu/workspace/ai-tools-demo/src/agent-coze-workflow`
> 技术栈：NestJS 11 + pnpm workspace
> **目标：给项目补上系统日志——用 NestJS 内置 Logger（零新依赖）在关键链路埋点：Coze 平台请求、LLM 调用、Agent 工具调用、SSE 流、HTTP 请求入口。当前项目只有 15 处 console.log 散落，排查问题（如 Coze 认证失败）只能靠肉眼翻对话日志。**

---

## 一、项目现状（先读这些文件）

- `apps/api/src/main.ts` — 启动入口（3 处 console.log）
- `apps/api/src/mcp/cozeClient.ts` — Coze 平台 API 客户端（**最重要埋点对象**，目前无任何请求日志，排查 700012006 认证问题全靠猜）
- `apps/api/src/llm/deepseek.client.ts` — DeepSeek LLM 客户端（chatStructured 方法，无耗时/token 日志）
- `apps/api/src/agent/react-agent.service.ts` — ReAct Agent 核心（SSE 流事件、interrupt 检测，无日志）
- `apps/api/src/agent/tools/` — 8 个工具（无入参/出参/耗时日志）
- `apps/api/src/agent/react-agent.controller.ts` — HTTP 入口（chat/resume/upload）
- `apps/api/src/workflow/workflow.service.ts` — 旧链路（已有 8 处 console.warn，可保留或统一为 Logger）

**注意**：架构重构任务（agent/agents/mcp 目录调整）可能同时在进行，**本任务以当前实际目录结构为准**，不依赖重构后的路径。

---

## 二、目标

用 **NestJS 内置 `Logger`**（`@nestjs/common` 的 Logger 类，零新依赖）替换/补充日志，覆盖 6 个埋点位置，达到"任何一次请求/工具调用/API 调用都能从日志还原全过程"。

**日志约定（全项目统一）：**

- 级别：`debug`（详细数据）/ `info`（正常流程）/ `warn`（降级、重试、非致命异常）/ `error`（失败）
- 格式：`[上下文名] 消息` + 结构化字段（耗时、code 等）
- **敏感脱敏铁律**：任何日志不得打印完整 `session_key` / `API key` / `token`。需要打印时只打前 8 位 + `(len=N)`，例如 `session_key=eyJpZCI6…(len=214)`
- **日志级别控制**：读取环境变量 `LOG_LEVEL`（默认 `info`），`main.ts` 里 `Logger.overrideLogger([...])` 按级别过滤（debug 时全量输出）
- NestJS Logger 的使用：类内 `private readonly logger = new Logger(ClassName.name);`，方法内 `this.logger.log/warn/error/debug(msg, context?)`

---

## 三、埋点位置（按优先级）

### 1. CozeClient（最重要）— apps/api/src/mcp/cozeClient.ts

每个 API 请求都要有日志。在私有 `request()` 方法里统一埋点（所有接口自动覆盖）：

```ts
// request() 方法内：
// 请求前：debug 级别，记路径 + body 摘要（不含敏感字段）
this.logger.debug(`[CozeAPI] -> ${path} body=${this.summarize(body)}`);

// 响应成功：info 级别，记路径 + 耗时 + code
this.logger.log(`[CozeAPI] <- ${path} code=${json.code} ${durationMs}ms`);

// 响应失败（code !== 0）：warn 级别，记 code + msg
this.logger.warn(`[CozeAPI] !! ${path} code=${json.code} msg=${json.msg}`);

// 网络异常/超时：error 级别，记路径 + 错误
this.logger.error(`[CozeAPI] ✗ ${path} ${e.message}`);
```

**辅助方法 `summarize(body)`**：把请求体转 JSON 字符串，**超过 200 字符截断**；若 body 里含 session_key 之类敏感字段先脱敏。实现约 15 行。

**注意**：CozeClient 目前是普通类（非 Nest Provider 注入时也直接用），Logger 用法：`private readonly logger = new Logger("CozeClient")` 即可（不依赖 DI）。

### 2. DeepSeekClient — apps/api/src/llm/deepseek.client.ts

`chatStructured()` 方法埋点：

```ts
const start = Date.now();
// 调用前：debug 级别，记 model + systemPrompt 前 100 字符 + userPrompt 前 100 字符
// 调用成功：info 级别，记耗时 + 模型
this.logger.log(`[DeepSeek] chatStructured ok ${Date.now() - start}ms`);
// 调用失败：error 级别，记耗时 + 错误消息
```

token 用量：如果 result 上能取到 `usage`（ChatOpenAI 返回带 token 统计），`info` 级别带上 `promptTokens/completionTokens`；取不到就不打，不强求。

### 3. react-agent.service.ts — SSE 流事件

`streamAgentEvents()` 里对关键事件打 `debug` 级别日志：
- `on_chat_model_stream`：不打（太频繁，每 token 一条会刷屏）
- `on_tool_start`：`debug` 级别 `[Agent] tool_start ${toolName}`
- `on_tool_end`：`debug` 级别 `[Agent] tool_end ${toolName} (输出前 200 字符)`
- interrupt 检测到：`info` 级别 `[Agent] interrupt: ${question 前 100 字符}`
- 流结束 done：`info` 级别 `[Agent] done`

`handleChat` / `handleResume` 入口：`info` 级别 `[Agent] chat session=${sessionId} msg=${message 前 100 字符}`。

### 4. tools/ — 工具入参出参

每个工具函数开头和结尾埋点。为了不重复 8 遍，**在 tools/index.ts 加一个包装函数**，或者每个工具文件内手动加（二选一，推荐包装函数）：

```ts
// tools/index.ts 里新增（或单独 helper 文件）
export function withToolLog<T extends (...args: any[]) => Promise<any>>(
  toolName: string,
  fn: T,
): T {
  const logger = new Logger("Tool");
  return (async (...args: any[]) => {
    const start = Date.now();
    logger.debug(`[Tool] ${toolName} 入参=${JSON.stringify(args[0] ?? {}).slice(0, 300)}`);
    try {
      const result = await fn(...args);
      logger.log(`[Tool] ${toolName} ok ${Date.now() - start}ms 出参=${String(result).slice(0, 300)}`);
      return result;
    } catch (e) {
      logger.error(`[Tool] ${toolName} ✗ ${Date.now() - start}ms ${(e as Error).message}`);
      throw e;
    }
  }) as T;
}
```

然后 `ALL_TOOLS` 注册时用 `withToolLog(name, tool)` 包一层。**注意**：tools 的 `tool()` 返回对象，包装要兼容（可在 `tool()` 的 async 回调内部调 withToolLog 包装的函数，或直接在回调里手动打日志——**如果包装对象复杂，退化为在每个 tool 的 async 回调开头/结尾手动打日志**，效果一样）。

### 5. react-agent.controller.ts — HTTP 入口

三个接口（chat / resume / upload）入口打 `info`：
- `[HTTP] POST /api/agent/chat session=${sessionId ?? "new"} msgLen=${message.length}`
- `[HTTP] POST /api/agent/chat/resume session=${sessionId}`
- `[HTTP] POST /api/agent/upload name=${file?.originalname} size=${file?.size}`

可用 NestJS 的 `Logger` 在 controller 里注入，或简单的 `new Logger("HTTP")`。

### 6. main.ts — 启动日志 + 全局级别

- 保留现有启动日志，改用 `Logger.log`
- 加 LOG_LEVEL 读取：
```ts
const logLevel = process.env.LOG_LEVEL ?? "info";
Logger.overrideLogger(
  logLevel === "debug"
    ? ["log", "warn", "error", "debug", "verbose"]
    : ["log", "warn", "error"],
);
```

### 7. 旧链路 workflow.service.ts（可选）

现有 8 处 `console.warn` 可保留（旧链路已不维护），但**建议顺手换成 Logger**（同名 console.warn 替换为 this.logger.warn，工作量小）。换不换都行，注释说明即可。

---

## 四、验收标准

1. `pnpm typecheck` 全绿；`pnpm build` 全绿
2. **启动日志**：`LOG_LEVEL=debug pnpm --filter @coze-workflow/api dev` 启动后，控制台能看到启动日志且 debug 级别生效
3. **Coze 请求日志**（实测）：调一次 `POST /api/agent/chat`（触发 save_to_coze 或任意 Coze 调用），控制台能看到 `[CozeAPI] -> create`、`[CozeAPI] <- create code=0 xxxms` 格式日志
4. **LLM 日志**：触发 plan_workflow（调 DeepSeek），能看到 `[DeepSeek] chatStructured ok xxxms`
5. **工具日志**：触发任意工具调用，能看到 `[Tool] xxx ok/✗` 格式
6. **无敏感泄露**：grep 日志输出，确认没有完整 session_key / API key 出现
7. 现有功能不回归：chat / upload / workflow/run 正常

---

## 五、红线

- ❌ 不加新依赖（用 @nestjs/common 内置 Logger）
- ❌ 不改变业务逻辑（只加日志，不改任何请求/响应/工具行为）
- ❌ 不打印敏感信息（session_key、API key、完整 prompt 超长内容）
- ❌ 不在 `on_chat_model_stream` 每 token 打日志（会刷屏）
- ✅ 日志用英文或中文均可，但全项目保持统一风格
- ✅ 各文件 Logger 上下文名清晰（CozeClient / DeepSeek / Agent / Tool / HTTP）
