# DeepAgents 从零实战 — 任务文档

> 7 个从零开始的任务，每个都是一个小项目，从需求出发写代码
>
> `src/exercise-01~07.mjs` 是参考代码（有详细注释），本文档的任务要求你从空白文件开始写

---

## 如何使用

1. 每个任务创建一个新文件，如 `src/task-01.mjs`
2. 按需求描述从零编写代码
3. 遇到困难时，打开对应的 `exercise-XX.mjs` 参考注释
4. 完成后运行验证，把代码发给我审查

---

## Task 01：最小可用 Agent

**难度**：入门  
**参考**：exercise-01.mjs  
**目标**：从零搭建一个能对话的 Agent，理解 DeepAgents 的基本骨架

### 场景

你要做一个"编程知识问答助手"，用户问编程问题，Agent 用中文回答。

### 需求

1. 创建 `src/task-01.mjs`
2. 使用 `createAgent` 创建一个 Agent，配置：
   - `model`：使用 `.env` 中的 `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `MODEL_NAME`
   - `systemPrompt`：定义角色为"编程知识问答助手，用中文回答，回答要简洁"
   - `tools`：空数组（纯对话，不调用工具）
   - `middleware`：空数组（先不用中间件）
3. 用 `agent.invoke` 发送一条 `HumanMessage`，提问："什么是 Middleware 模式？"
4. 打印 Agent 的回复

### 验收标准

- 运行 `node src/task-01.mjs`，能输出关于 Middleware 模式的中文回答
- 不报错，不使用任何 Middleware

### 关键 API

```js
import { createAgent, HumanMessage } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
```

---

## Task 02：带日志和计时 Middleware 的 Agent

**难度**：基础  
**参考**：exercise-01.mjs（4 个钩子）、exercise-02.mjs（wrapModelCall）  
**目标**：自己写两个 Middleware，理解生命周期钩子和状态共享

### 场景

你的团队需要一个"可观测"的 Agent —— 每次调用都有日志记录、耗时统计、模型调用次数统计。

### 需求

1. 创建 `src/task-02.mjs`
2. 创建 `LoggingMiddleware`，要求：
   - `stateSchema` 包含 `modelCallCount`（number，default 0）和 `totalDurationMs`（number，default 0）
   - `beforeAgent`：打印 "Agent 开始"，记录开始时间（可用 `Date.now()` 存到闭包变量）
   - `beforeModel`：打印 "即将调用模型，第 N 次"
   - `afterModel`：累加 `modelCallCount`，累加本次模型调用的耗时到 `totalDurationMs`
   - `afterAgent`：打印 "Agent 结束，共调用模型 N 次，总耗时 Mms"
3. 创建 `StyleMiddleware`，要求：
   - 使用 `wrapModelCall`，在 `systemMessage` 末尾追加 `"请用 Markdown 格式回答，包含代码示例。"`
4. 创建 Agent，`middleware` 数组中同时使用这两个 Middleware
5. 发送一条提问："Node.js 中如何读取文件？"
6. 打印回复、`modelCallCount`、`totalDurationMs`

### 验收标准

- 控制台输出包含 `[Logging]` 开头的日志
- 日志中包含模型调用次数和总耗时
- 回复内容包含 Markdown 格式和代码示例
- `result.modelCallCount` 和 `result.totalDurationMs` 有值

### 关键知识点

- `beforeAgent` / `beforeModel` / `afterModel` / `afterAgent` 的执行顺序
- `afterModel` 返回对象来更新 state
- `wrapModelCall` 修改 `request.systemMessage`
- Middleware 顺序的影响：先注册的 Middleware 在外层

---

## Task 03：敏感词拦截 + 工具注入 Agent

**难度**：中等  
**参考**：exercise-01.mjs（jumpTo）、exercise-02.mjs（tools + wrapToolCall + Command）  
**目标**：实现安全拦截和动态工具注入，理解 Middleware 的"拦截"和"增强"两种模式

### 场景

你要做一个"智能客服 Agent"，它有两个特殊需求：

1. 用户消息中如果包含敏感词（如"密码"、"token"、"secret"），必须拦截
2. Agent 本身没有工具，但通过 Middleware 按需注入一个"查天气"工具

### 需求

1. 创建 `src/task-03.mjs`
2. 创建 `ContentFilterMiddleware`，要求：
   - `name`：`"ContentFilterMiddleware"`
   - 敏感词列表：`["密码", "token", "secret"]`
   - 使用 `beforeModel`（带 `canJumpTo: ["end"]`）检查用户消息
   - 如果最后一条消息包含敏感词，打印 `[Filter] 检测到敏感词，拦截`，返回 `jumpTo: "end"` + 一条 AIMessage
   - 如果不包含，正常放行
3. 创建 `WeatherToolsMiddleware`，要求：
   - `stateSchema` 包含 `toolCallCount`（number，default 0）
   - `tools` 字段注入一个 `get_weather` 工具（模拟即可，返回 `"北京：晴，25°C"`）
   - 使用 `wrapToolCall` 包装工具执行：在执行前打印工具名和参数，执行后累加 `toolCallCount`
   - 使用 `Command` 同时更新 state 和返回 ToolMessage
4. 创建 Agent，`tools` 为空数组，`middleware` 为上面两个
5. 测试两个场景：
   - 正常提问："北京今天天气怎么样？"（应调用工具）
   - 敏感词："帮我查一下服务器的密码"（应被拦截）

### 验收标准

- 正常提问场景：Agent 调用了 `get_weather` 工具，返回天气信息
- 敏感词场景：Agent 被 ContentFilterMiddleware 拦截，返回拦截消息
- `result.toolCallCount` 在正常场景下为 1
- 敏感词场景下 `modelCallCount` 为 0（模型未被调用）

### 关键知识点

- `beforeModel` + `canJumpTo` + `jumpTo` 实现拦截
- `tools` 字段通过 Middleware 注入工具（Agent 的 tools 为空）
- `wrapToolCall` + `Command` 同时更新状态和返回消息
- 多个 Middleware 的协作

---

## Task 04：私有文件保险箱 Agent

**难度**：中等  
**参考**：exercise-03.mjs（FilesystemMiddleware + permissions）  
**目标**：设计一套权限规则，让 Agent 能操作文件但受限

### 场景

你有一个虚拟工作区，里面有"公开资料"和"机密文件"。你需要让 Agent 能：

- 读取公开资料
- 编辑自己的笔记本
- 不能读机密、不能删除任何文件

### 需求

1. 创建 `src/task-04.mjs`
2. 准备虚拟工作区：
   - 创建 `workspace` 目录
   - 预置文件：`/public/readme.md`（内容："项目说明文档"）、`/secret/keys.txt`（内容："AK=xxx SK=yyy"）
   - 预置空文件：`/notes/my-note.md`（内容："# 我的笔记本\n"）
3. 设计权限规则（permissions），要求：
   - 允许读取 `/public/**` 下的所有文件
   - 允许对 `/notes/**` 进行 read 和 write 操作
   - 禁止读取 `/secret/**`
   - 禁止对 `/public/**` 进行 write 操作（公开资料只读）
   - 其他所有写操作默认禁止
4. 创建 Agent，使用 `createFilesystemMiddleware` + `FilesystemBackend`
5. 测试以下场景（每个场景独立 invoke，不复用 messages）：
   - 读取 `/public/readme.md` → 应成功
   - 读取 `/secret/keys.txt` → 应被拒绝
   - 写入 `/notes/my-note.md` 追加一条笔记 → 应成功
   - 写入 `/public/readme.md` 修改内容 → 应被拒绝
   - 写入 `/hack.txt` → 应被拒绝

### 验收标准

- 5 个测试场景的通过/拒绝结果都符合预期
- 权限规则使用了"先匹配先生效"原则
- 运行结束后检查 `workspace/notes/my-note.md`，确实有新内容

### 关键知识点

- `FilesystemBackend` 的 `virtualMode: true` + `rootDir`
- permissions 规则的顺序设计（先匹配先生效）
- 通配符 `/**` 的使用
- `operations` 类型：read / write / edit / ls

---

## Task 05：私人记忆管家 Agent

**难度**：中高  
**参考**：exercise-04.mjs（MemoryMiddleware）  
**目标**：构建一个能跨对话记住用户偏好的 Agent，并验证记忆的分类存储

### 场景

你有一个"私人助手"，需要记住你的项目信息和偏好设置。不同类型的信息要分开存储，避免混写。

### 需求

1. 创建 `src/task-05.mjs`
2. 定义三个记忆文件路径：
   - `/AGENTS.md` —— 项目信息（技术栈、架构、入口脚本）
   - `/memory/preferences.md` —— 用户偏好（语言、包管理器、回答风格）
   - `/memory/context.md` —— 对话上下文（当前任务、待办事项）
3. 创建 Agent，使用 `createFilesystemMiddleware` + `createMemoryMiddleware`
4. `systemPrompt` 中必须包含记忆的写入规则，明确每种信息应写入哪个文件
5. 多轮对话测试（复用 messages），按顺序发送：
   - "记住：项目使用 DeepAgents 框架 + LangChain"
   - "记住：我偏好 TypeScript 而非 JavaScript"
   - "记住：当前任务是学习 MemoryMiddleware"
   - "我偏好的语言是什么？项目用了什么框架？当前在做什么？分别回答"
6. 对话结束后，读取三个记忆文件，打印内容
7. 验证：
   - 项目信息在 `/AGENTS.md`，不在 `/memory/preferences.md`
   - 偏好信息在 `/memory/preferences.md`，不在 `/AGENTS.md`
   - 上下文信息在 `/memory/context.md`

### 验收标准

- Agent 能基于记忆正确回答偏好、项目信息、当前任务
- 三个文件各自只包含对应类型的信息，没有混写
- 运行结束后检查工作区文件，内容正确

### 关键知识点

- `createMemoryMiddleware` 的 `sources` 数组
- `<agent_memory>` 的自动注入机制
- 记忆分类存储的必要性和实现方式
- `systemPrompt` 中定义写入规则的重要性

---

## Task 06：自动摘要 + 记忆的持久对话 Agent

**难度**：高  
**参考**：exercise-04.mjs（Memory）+ exercise-05.mjs（Summarization）  
**目标**：组合 MemoryMiddleware 和 SummarizationMiddleware，构建一个既能记住偏好、又能自动压缩长对话的 Agent

### 场景

你有一个"长期对话助手"，用户会反复使用它。需要两个能力：

1. 记住用户的偏好（跨会话持久化）
2. 对话太长时自动压缩（节省 token）

### 需求

1. 创建 `src/task-06.mjs`
2. 创建 Agent，同时使用三个 Middleware：
   - `createFilesystemMiddleware`：提供文件操作
   - `createMemoryMiddleware`：读取偏好文件 `/memory/preferences.md`
   - `createSummarizationMiddleware`：自动压缩长对话
3. 配置 `createSummarizationMiddleware`：
   - `trigger: { type: "messages", value: 6 }`（6 条消息触发摘要）
   - `keep: { type: "messages", value: 4 }`（保留最近 4 条）
   - 自定义 `summaryPrompt`（用中文摘要）
4. 多轮对话测试，按顺序发送 5 条消息：
   - "记住：我喜欢用 pnpm"
   - "记住：我叫小明"
   - "记住：我在学习 DeepAgents"
   - "记住：我的目标是成为 AI 工程师"
   - "我叫什么？喜欢用什么包管理器？在学什么？目标是什么？"
5. 对话结束后：
   - 检查 `conversation_history` 目录是否有摘要文件
   - 检查 `/memory/preferences.md` 是否有偏好信息
   - 打印当前消息数（应少于原始消息数，因为触发了摘要）

### 验收标准

- Agent 正确回答了所有个人信息
- `conversation_history` 目录下生成了摘要文件
- `/memory/preferences.md` 包含用户偏好
- 最后一条回复后打印的消息数小于原始消息总数（说明摘要生效）

### 关键知识点

- 三个 Middleware 的组合使用
- `createSummarizationMiddleware` 的 trigger/keep 机制
- 摘要后消息数的变化
- 摘要和记忆的分工：摘要压缩对话历史，记忆存储持久偏好

---

## Task 07：多角色协作的代码审查 Agent

**难度**：挑战  
**参考**：exercise-06.mjs（SubAgentMiddleware）  
**目标**：从零设计一个多 Agent 协作系统，实现代码审查的完整工作流

### 场景

你是一个开发团队的 Tech Lead，需要一个"代码审查助手"。当开发者提交一段代码时，助手自动完成：

1. 静态分析（检查命名规范、潜在 bug）
2. 测试建议（建议应该写什么测试）
3. 改进建议（提出优化方案）

### 需求

1. 创建 `src/task-07.mjs`
2. 定义三个工具：
   - `check_naming`：检查代码中的变量命名是否符合驼峰命名法
     - 参数：`code`（string，待检查的代码）
     - 返回：JSON，包含 `issues` 数组，每个 issue 包含 `line`、`name`、`suggestion`
     - 实现提示：用正则匹配 `_` 开头或包含 `-` 的变量名
   - `count_complexity`：统计代码复杂度（函数数量、最长函数行数）
     - 参数：`code`（string）
     - 返回：JSON，包含 `functionCount`、`maxLines`
   - `suggest_test`：根据函数名生成测试建议
     - 参数：`functionName`（string）、`description`（string，函数功能描述）
     - 返回：JSON，包含 `testCases` 数组，每项包含 `name`、`input`、`expected`
     - 实现提示：可以硬编码几条常见模式的测试建议，或返回固定模板
3. 定义三个子 Agent：
   - `code-analyzer`：用 `check_naming` 和 `count_complexity` 做静态分析
   - `test-advisor`：用 `suggest_test` 生成测试建议
   - `improvement-suggester`：根据分析结果和测试建议，提出优化方案（无工具，纯 LLM 推理）
4. 创建主 Agent，`generalPurposeAgent: false`，`systemPrompt` 中定义委派顺序
5. 发送一段有问题的代码进行审查：

```javascript
const my_var = 10;
const _hidden = true;

function calculateTotal(price, tax, discount) {
  let result = price * tax;
  result = result - discount;
  result = result + price;
  result = result * 0.9;
  result = result + 10;
  result = result - 5;
  result = result / 2;
  return result;
}
```

6. 使用流式输出（`streamEvents`），实时打印文本和工具调用

### 验收标准

- 主 Agent 按顺序委派了三个子 Agent
- `code-analyzer` 调用了 `check_naming` 和 `count_complexity`
- `test-advisor` 调用了 `suggest_test`
- `improvement-suggester` 给出了优化建议
- 最终汇总包含：命名问题、复杂度统计、测试建议、优化方案
- 流式输出实时显示中间过程

### 关键知识点

- `createSubAgentMiddleware` 的子 Agent 定义
- 子 Agent 的 `description` 对委派准确性的影响
- `generalPurposeAgent: false` 的职责分离
- 流式输出 `streamEvents` 的使用
- 自定义工具的 `tool()` 函数 + `zod` schema

---

## 任务进度追踪

| 任务                                      | 状态   | 完成时间 |
| ----------------------------------------- | ------ | -------- |
| Task 01：最小可用 Agent                   | 待完成 |          |
| Task 02：带日志和计时 Middleware 的 Agent | 待完成 |          |
| Task 03：敏感词拦截 + 工具注入 Agent      | 待完成 |          |
| Task 04：私有文件保险箱 Agent             | 待完成 |          |
| Task 05：私人记忆管家 Agent               | 待完成 |          |
| Task 06：自动摘要 + 记忆的持久对话 Agent  | 待完成 |          |
| Task 07：多角色协作的代码审查 Agent       | 待完成 |          |

每完成一个任务，把代码发给我审查，通过后进入下一个任务！
