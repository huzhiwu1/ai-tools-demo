---
trigger: always_on
---

# AI Agent 代码编写规则

> 当项目中涉及 AI Agent、LLM 应用、RAG、工具编排、Agent 工作流等相关代码时，必须遵循以下规则。

## 1. 核心架构原则

### 1.1 必须遵循 Agent 循环模型

任何 Agent 实现都必须包含清晰的 **感知(Perceive) → 思考(Think) → 行动(Act)** 循环：

```typescript
// ✅ 正确：显式定义 Agent 循环
class MyAgent {
  async run(input: string): Promise<string> {
    while (!this.isComplete()) {
      const observation = await this.perceive(input);   // 感知环境
      const decision = await this.think(observation);    // 推理决策
      const result = await this.act(decision);           // 执行行动
      if (this.shouldTerminate(result)) break;
    }
    return this.finalAnswer;
  }
}

// ❌ 错误：没有清晰循环结构的单体函数
async function agentDoSomething(input: string) {
  const r1 = await step1(input);
  const r2 = await step2(r1);
  return r3;
}
```

### 1.2 状态管理必须显式化

Agent 状态必须通过接口/类显式定义，禁止隐式状态：

```typescript
// ✅ 正确：显式状态定义
interface AgentState {
  task: string;
  observations: Observation[];
  memory: Memory;
  currentStep: number;
  isComplete: boolean;
}

// ❌ 错误：隐式状态，通过闭包或全局变量传递
let currentTask = '';
let history: string[] = [];
```

## 2. 四大组件规范

Agent 代码必须清晰分离以下四个组件：

| 组件                 | 职责               | 命名约定                       |
| -------------------- | ------------------ | ------------------------------ |
| **Planning（规划）** | 任务分解、方案生成 | `*Planner`, `*PlanningEngine`  |
| **Memory（记忆）**   | 信息存储与检索     | `*Memory`, `*Store`, `*Buffer` |
| **Tools（工具）**    | 外部能力封装       | `*Tool`, `*Adapter`            |
| **LLM（模型）**      | 推理与生成         | `*LLM`, `*Model`, `*Client`    |

### 2.1 规划组件

- 必须支持任务分解（Task Decomposition）
- 复杂任务优先考虑 **ReAct** 或 **Tree of Thoughts** 模式
- 计划必须包含 `steps`、`dependencies`、`expectedOutput`

```typescript
interface TaskPlan {
  goal: string;
  steps: PlanStep[];
}

interface PlanStep {
  id: number;
  description: string;
  expectedOutput: string;
  dependencies: number[];  // 显式声明依赖关系
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
}
```

### 2.2 记忆组件

- **短期记忆**：使用滑动窗口管理对话历史，设置 `maxHistoryLength`
- **长期记忆**：使用向量数据库存储，必须包含 `embedding` + `metadata` + `timestamp`
- **工作记忆**：当前任务相关的临时信息

```typescript
interface Memory {
  // 短期记忆：最近 N 轮交互
  shortTerm: Message[];
  maxShortTermSize: number;

  // 长期记忆：向量化存储
  longTerm: {
    query: (embedding: number[], topK: number) => Promise<MemoryChunk[]>;
    add: (chunk: MemoryChunk) => Promise<void>;
  };

  // 工作记忆：当前任务上下文
  working: Record<string, unknown>;
}
```

### 2.3 工具组件

- 每个工具必须实现统一的 `Tool` 接口
- 必须包含 `name`、`description`、`parameters`（用于 LLM 理解）
- 工具执行必须包装错误处理

```typescript
interface Tool {
  name: string;
  description: string;      // LLM 通过此描述选择工具
  parameters: ZodSchema;    // 参数校验模式
  execute: (input: unknown) => Promise<ToolResult>;
}

interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}
```

### 2.4 LLM 组件

- 必须封装为独立客户端，支持切换模型
- Prompt 必须集中管理，禁止硬编码在业务逻辑中
- 必须处理 token 限制和速率限制

```typescript
interface LLMClient {
  complete(prompt: string, options?: CompletionOptions): Promise<string>;
  chat(messages: Message[], options?: ChatOptions): Promise<string>;
}
```

## 3. 设计模式强制要求

### 3.1 ReAct 模式（推理 + 行动）

当 Agent 需要多步推理时，**必须**使用 ReAct 模式：

```typescript
/**
 * ReAct 循环：
 * Thought -> Action -> Observation -> ... -> Final Answer
 *
 * 每一步 LLM 输出必须包含：
 * 1. Thought: 当前思考过程
 * 2. Action: 要调用的工具（如有）
 * 3. Observation: 工具返回的结果
 */
interface ReActStep {
  thought: string;       // 推理过程
  action?: ToolCall;     // 工具调用（可选，最后一步没有）
  observation?: string;  // 观察结果
}
```

### 3.2 多 Agent 协作

多 Agent 系统必须使用以下模式之一：

- **Supervisor 模式**：一个协调 Agent 分配任务给多个 Worker Agent
- **Peer-to-Peer 模式**：Agent 之间直接通信，使用统一消息协议
- **Pipeline 模式**：Agent 按流水线顺序处理数据

```typescript
// Supervisor 模式示例
interface SupervisorAgent {
  workers: Map<string, WorkerAgent>;

  async delegate(task: Task): Promise<Result> {
    const worker = this.selectWorker(task);  // 根据任务类型选择
    return worker.execute(task);
  }
}
```

## 4. 代码质量规范

### 4.1 注释规范

所有 Agent 相关代码必须包含以下注释：

```typescript
/**
 * [组件名称]
 *
 * 职责：一句话描述该组件的作用
 *
 * 流程：
 * 1. 步骤一
 * 2. 步骤二
 * 3. 步骤三
 *
 * 关键细节：
 * - 重要的实现决策
 * - 边界条件处理
 * - 性能考虑
 *
 * @example
 * const result = await component.execute(input);
 */
```

### 4.2 错误处理

- Agent 循环必须设置 **最大步数限制**（`maxSteps`），防止无限循环
- 工具调用失败必须有降级策略（fallback）
- LLM 输出必须校验格式，不符合时要求重新生成

```typescript
const MAX_STEPS = 10;  // 必须设置上限

async function safeAgentLoop(input: string) {
  for (let step = 0; step < MAX_STEPS; step++) {
    try {
      const result = await executeStep();
      if (isComplete(result)) return result;
    } catch (error) {
      // 记录错误，尝试恢复或降级
      await handleError(error);
    }
  }
  throw new Error(`Agent 在 ${MAX_STEPS} 步内未完成任务`);
}
```

### 4.3 日志与可观测性

- 每个 Agent 步骤必须记录：输入、输出、耗时
- 工具调用必须记录：工具名、参数、结果、耗时
- 使用结构化日志（JSON），便于后续分析

```typescript
interface AgentLog {
  step: number;
  type: 'perceive' | 'think' | 'act' | 'tool_call';
  input: unknown;
  output: unknown;
  durationMs: number;
  timestamp: Date;
}
```

## 5. 技术栈约定

本项目 AI Agent 开发使用以下技术栈：

| 用途     | 推荐库                                     | 说明                  |
| -------- | ------------------------------------------ | --------------------- |
| LLM 交互 | `@langchain/core`                          | 统一的 LLM 抽象接口   |
| 工具定义 | `@langchain/core/tools`                    | 标准 Tool 接口        |
| 记忆存储 | `@langchain/community/vectorstores/milvus` | Milvus 向量数据库     |
| 文本分块 | `@langchain/textsplitters`                 | 文档切分              |
| 数据校验 | `zod`                                      | 工具参数校验          |
| 工作流   | `@langchain/langgraph`                     | 复杂 Agent 工作流编排 |

## 6. 禁止事项

1. **禁止在 Agent 循环中阻塞等待用户输入** —— Agent 应该是自主的
2. **禁止将敏感信息（API Key、密码）硬编码** —— 使用环境变量
3. **禁止工具函数没有超时控制** —— 所有外部调用必须设置 timeout
4. **禁止 LLM 输出直接执行** —— 必须经过校验和确认（尤其是代码执行类工具）
5. **禁止 Agent 状态随意修改** —— 状态变更必须通过显式的方法，便于追踪
6. **禁止 JS/TS 注释中使用 Markdown 列表符号** —— `*` 和 `-` 在块注释中会导致语法解析错误
7. **禁止 zod schema 字段缺少 .describe()** —— 每个字段必须有自然语言描述，否则 LLM 无法理解字段用途

## 7. Prompt 工程规范

### 7.1 系统提示词必须包含的要素

系统提示词（SystemMessage）是 Agent 的"行为说明书"，必须包含以下四部分：

```typescript
const systemPrompt = `你是[角色名称]，使用工具完成用户任务。

## 可用工具
1. tool_name: 工具功能简述
2. ...

## 使用规则
- 规则1
- 规则2

## 输出格式
- 思考过程：...
- 工具调用：...
- 最终答案：...
`;
```

### 7.2 关键点说明

1. **身份定位**：LLM 必须清楚自己是什么角色（编程助手、数据分析师等）
2. **工具清单**：列出所有可用工具及其用途，description 决定了 LLM 选工具的准确率
3. **调用规则**：何时调用工具、如何传参、常见错误示例（如 execute_command 中禁止 cd）
4. **输出格式**：明确期望的返回格式（JSON、Markdown、纯文本）

### 7.3 知识扩展

系统提示词决定了 LLM 的"行为模式"。如果把 LLM 比作演员，系统提示词就是剧本：

- 没有剧本：演员自由发挥，可能偏离主题
- 有好剧本：演员按照设定角色精准表演

好的系统提示词能让 LLM 的 tool_call 准确率提升 30% 以上。

## 8. 流式输出与增量解析规范

### 8.1 使用场景

| 场景           | 是否推荐流式 | 原因                     |
| -------------- | ------------ | ------------------------ |
| 聊天机器人     | ✅ 推荐      | 用户感知更快，体验更好   |
| 代码生成       | ✅ 推荐      | 实时预览，像 Cursor 一样 |
| 结构化数据提取 | ⚠️ 谨慎      | 需要完整数据才能解析     |
| 工具调用       | ✅ 推荐      | 可实时预览工具参数       |

### 8.2 关键流程

```typescript
async function streamProcess() {
  // 1. 获取流
  const stream = await model.stream(messages);

  // 2. 准备累积容器
  let fullMessage = null;

  // 3. 遍历流
  for await (const chunk of stream) {
    // 3.1 累积 chunk（必须用 concat，不能 +=）
    fullMessage = fullMessage ? fullMessage.concat(chunk) : chunk;

    // 3.2 尝试增量解析（如 tool_call）
    try {
      const partial = await parser.parsePartialResult(fullMessage);
      // 处理部分结果...
    } catch (e) {
      // JSON 不完整，忽略，继续等待下一块
    }

    // 3.3 实时输出文本内容
    if (chunk.content) {
      process.stdout.write(chunk.content);
    }
  }

  // 4. 流结束后，fullMessage 是完整消息，存入历史
  return fullMessage;
}
```

### 8.3 关键点说明

1. **必须用 concat() 而非 +=**：AIMessageChunk 是对象，+= 会导致数据丢失
2. **增量解析失败是正常的**：JSON 还没闭合时 parse 会失败，try/catch 忽略即可
3. **记录已处理长度**：如 write_file 的 content，用 Map 记录已打印长度，避免重复输出
4. **必须设置超时**：流式输出可能卡住，需要设置合理的超时时间

### 8.4 知识扩展：流式输出 vs 非流式

| 维度       | 流式（stream）     | 非流式（invoke） |
| ---------- | ------------------ | ---------------- |
| 用户体验   | 实时看到内容       | 等待全部生成     |
| 实现复杂度 | 高（需处理 chunk） | 低（直接拿结果） |
| 适用场景   | 交互式应用         | 后台任务         |
| 资源占用   | 连接时间长         | 一次性返回       |

## 9. 结构化输出规范

### 9.1 必须使用 zod 定义 schema

```typescript
// ✅ 正确：每个字段都有 describe
const userSchema = z.object({
  name: z.string().describe('用户姓名'),
  age: z.number().describe('年龄，数字类型'),
  email: z.string().email().describe('邮箱地址').nullable(),
});

// ❌ 错误：缺少 describe，LLM 无法理解字段含义
const badSchema = z.object({
  name: z.string(),
  age: z.number(),
});
```

### 9.2 优先使用 withStructuredOutput

```typescript
// ✅ 推荐：自动处理格式指令和解析
const structuredModel = model.withStructuredOutput(userSchema);
const result = await structuredModel.invoke(prompt);

// ❌ 不推荐：手动拼接格式指令 + 手动解析
const raw = await model.invoke(prompt + '请按 JSON 格式返回');
const result = JSON.parse(raw.content); // 容易解析失败
```

### 9.3 关键点说明

1. **.describe() 是灵魂**：LLM 通过描述理解每个字段应该填什么
2. **.nullable() 表示可选**：字段找不到时 LLM 会返回 null，不会瞎编
3. **数组用 z.array()**：批量数据必须定义数组 schema
4. **错误处理**：LLM 返回不符合 schema 的数据时会抛异常，必须捕获

### 9.4 知识扩展：为什么 withStructuredOutput 更可靠？

传统方式：

```
Prompt → LLM 自由发挥 → 手动解析 JSON → 容易出错
```

withStructuredOutput 方式：

```
Prompt + Schema → LLM 按约束生成 → 自动解析 + zod 校验 → 类型安全
```

Schema 会被翻译成自然语言指令插入到 Prompt 中，LLM 明确知道输出格式约束。

## 10. 数据持久化规范

### 10.1 数据库连接管理

```typescript
// ✅ 正确：使用连接池，用完释放
const pool = mysql.createPool({ connectionLimit: 10, ... });

// ❌ 错误：每次创建新连接，不关闭
const conn = await mysql.createConnection(config);
// 忘记 await conn.end() → 连接泄漏
```

### 10.2 SQL 注入防护

```typescript
// ✅ 正确：使用参数化查询
await connection.query('SELECT * FROM users WHERE id = ?', [userId]);

// ❌ 错误：字符串拼接
await connection.query(`SELECT * FROM users WHERE id = ${userId}`);
```

### 10.3 批量插入规范

```typescript
// ✅ 正确：单条 SQL 批量插入
const values = [[row1], [row2], [row3]];
await connection.query('INSERT INTO table (a, b) VALUES ?', [values]);

// ❌ 错误：循环单条插入（N 次网络往返）
for (const row of rows) {
  await connection.query('INSERT INTO table (a, b) VALUES (?, ?)', row);
}
```

### 10.4 关键点说明

1. **连接必须关闭**：无论成功还是失败，finally 里必须释放连接
2. **禁止 multipleStatements**：除非确实需要，否则保持默认关闭（防注入）
3. **批量操作优先**：减少数据库往返次数，提升性能
4. **事务包裹**：多步操作必须使用事务，保证数据一致性

## 11. 测试规范

### 11.1 Agent 测试策略

1. **单元测试**：每个工具独立测试（mock 外部依赖）
2. **集成测试**：测试完整的 ReAct 循环（使用测试 LLM 或 mock）
3. **边界测试**：测试 maxSteps 到达上限、工具失败、LLM 返回异常格式等场景

## 12. 示例：合规的 Agent 代码结构

```typescript
import { Tool } from '@langchain/core/tools';
import { ChatOpenAI } from '@langchain/openai';

// ============================================
// 1. 定义状态
// ============================================
interface MyAgentState {
  task: string;
  history: ReActStep[];
  currentStep: number;
}

// ============================================
// 2. 定义工具（符合 Tool 接口）
// ============================================
class SearchTool extends Tool {
  name = 'web_search';
  description = '搜索网络信息，输入应为搜索关键词';

  async _call(input: string): Promise<string> {
    // 实现搜索逻辑，带超时和错误处理
    const result = await this.searchWithTimeout(input, 5000);
    return result;
  }
}

// ============================================
// 3. Agent 主类
// ============================================
class ReActAgent {
  private llm: ChatOpenAI;
  private tools: Map<string, Tool>;
  private maxSteps = 10;

  constructor(tools: Tool[]) {
    this.llm = new ChatOpenAI({ modelName: 'gpt-4' });
    this.tools = new Map(tools.map(t => [t.name, t]));
  }

  async run(task: string): Promise<string> {
    const state: MyAgentState = {
      task,
      history: [],
      currentStep: 0,
    };

    while (state.currentStep < this.maxSteps) {
      state.currentStep++;

      // 构造 ReAct Prompt
      const prompt = this.buildReActPrompt(state);

      // 调用 LLM
      const response = await this.llm.invoke(prompt);

      // 解析 Thought / Action
      const parsed = this.parseResponse(response.content as string);

      if (parsed.action) {
        // 执行工具
        const tool = this.tools.get(parsed.action.tool);
        const observation = await tool?.invoke(parsed.action.input);
        state.history.push({
          thought: parsed.thought,
          action: parsed.action,
          observation,
        });
      } else {
        // 最终答案
        return parsed.thought;
      }
    }

    throw new Error('达到最大步数限制');
  }

  private buildReActPrompt(state: MyAgentState): string {
    // 集中管理 Prompt
    return `...`;
  }

  private parseResponse(response: string) {
    // 解析 LLM 输出，校验格式
    return { thought: '', action: null };
  }
}
```
