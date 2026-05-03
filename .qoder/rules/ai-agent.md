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

## 7. 示例：合规的 Agent 代码结构

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
