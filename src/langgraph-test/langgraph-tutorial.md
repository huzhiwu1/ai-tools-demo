# LangGraph.js 小白教程：从零构建 AI Agent 工作流

> 基于 [ai-agent-course-code/langgraph-test/src](https://github.com/QuarkGluonPlasma/ai-agent-course-code/tree/main/langgraph-test/src) 项目代码，循序渐进地讲解 LangGraph.js 的核心概念与实战用法。

---

## 学习路线总览

```
第1课: 基础图（线性流程）        ← 从这里开始
  ↓
第2课: 条件路由（分支决策）      ← 学会让图"思考"
  ↓
第3课: 循环与重试                ← 学会让图"反复尝试"
  ↓
第4课: 错误处理                  ← 学会让图"优雅失败"
  ↓
第5课: 状态持久化（Checkpointer） ← 学会让图"记住过去"
  ↓
第6课: 人机交互（Interrupt）     ← 学会让图"等人类确认"
  ↓
第7课: 工具调用（ToolNode）      ← 学会给图"装上手脚"
  ↓
第8课: 预置 Agent（createAgent） ← 快速搭建完整 Agent
  ↓
第9课: 多 Agent 协作（Supervisor）← 终极形态：团队协作
```

---

## 第1课：基础图 —— 线性流程

**对应文件**：`basic-graph.mjs`

### 核心概念

LangGraph 的核心是**状态图（StateGraph）**——一种有向图，其中：

- **节点（Node）** = 处理步骤，是一个接收状态、返回状态更新的函数
- **边（Edge）** = 步骤之间的连接，决定数据流向
- **状态（State）** = 在节点之间流动的数据，用 `Annotation` 定义

### 代码解读

```javascript
import "dotenv/config";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

// 1️⃣ 定义状态 —— 图的"共享数据结构"
const StateAnnotation = Annotation.Root({
  text: Annotation({
    reducer: (_prev, next) => next, // reducer：新值覆盖旧值
    default: () => "", // 默认值
  }),
});

// 2️⃣ 定义节点 —— 每个节点是一个函数，接收 state，返回 state 的部分更新
const step1 = (state) => ({ text: `${state.text} -> step1` });
const step2 = (state) => ({ text: `${state.text} -> step2` });

// 3️⃣ 构建图 —— 声明节点和边的连接关系
const graph = new StateGraph(StateAnnotation)
  .addNode("step1", step1) // 添加节点
  .addNode("step2", step2)
  .addEdge(START, "step1") // START → step1
  .addEdge("step1", "step2") // step1 → step2
  .addEdge("step2", END) // step2 → END
  .compile(); // 编译为可执行的图

// 4️⃣ 运行图
const result = await graph.invoke({ text: "hello" });
// result.text = "hello -> step1 -> step2"
```

### 图的流程可视化

```
START → step1 → step2 → END
```

### 关键知识点扩展

#### 什么是 Annotation？

`Annotation` 是 LangGraph 定义状态的方式，每个字段需要指定：

| 属性      | 作用                                 | 示例                                 |
| --------- | ------------------------------------ | ------------------------------------ |
| `reducer` | 定义状态如何更新（旧值+新值→最终值） | `(_prev, next) => next` 表示直接覆盖 |
| `default` | 字段的默认值                         | `() => ""` 表示初始为空字符串        |

**reducer 的两种常见模式**：

- **覆盖模式**：`(_prev, next) => next` —— 新值直接替换旧值（最常用）
- **累加模式**：`(prev, next) => prev + next` —— 新值追加到旧值上

#### START 和 END 是什么？

- `START`：虚拟节点，代表图的入口
- `END`：虚拟节点，代表图的出口
- 每个图必须有 `START → ... → END` 的完整路径

#### 生成 Mermaid 流程图

```javascript
const drawable = await graph.getGraphAsync();
const mermaid = drawable.drawMermaid({ withStyles: true });
console.log(mermaid);
```

这段代码可以生成 Mermaid 格式的流程图，粘贴到 [Mermaid Live](https://mermaid.live) 即可可视化。

---

## 第2课：条件路由 —— 让图"做决策"

**对应文件**：`conditional-routing.mjs`

### 核心概念

真实场景中，流程不是简单的线性，而是**根据条件走不同分支**。LangGraph 用 `addConditionalEdges` 实现条件路由。

### 代码解读

```javascript
const StateAnnotation = Annotation.Root({
  query: Annotation({ reducer: (_prev, next) => next, default: () => "" }),
  route: Annotation({ reducer: (_prev, next) => next, default: () => "chat" }),
  answer: Annotation({ reducer: (_prev, next) => next, default: () => "" }),
});

// 1️⃣ 路由节点 —— 根据 query 内容决定走哪条路
const router = (state) => {
  const isMath = /[+\-*/]/.test(state.query); // 检测是否含数学运算符
  return { route: isMath ? "math" : "chat" };
};

// 2️⃣ 数学节点 —— 计算表达式
const mathNode = (state) => {
  try {
    return { answer: String(eval(state.query)) };
  } catch {
    return { answer: "计算出错，请检查表达式" };
  }
};

// 3️⃣ 聊天节点 —— 直接回复
const chatNode = (state) => ({ answer: `你的问题是：${state.query}` });

// 4️⃣ 构建带条件路由的图
const graph = new StateGraph(StateAnnotation)
  .addNode("router", router)
  .addNode("math", mathNode)
  .addNode("chat", chatNode)
  .addEdge(START, "router")
  .addConditionalEdges("router", (state) => state.route, {
    math: "math", // route === "math" → 走 math 节点
    chat: "chat", // route === "chat" → 走 chat 节点
  })
  .addEdge("math", END)
  .addEdge("chat", END)
  .compile();
```

### 图的流程可视化

```
         ┌─ math ──→ END
START → router ─┤
         └─ chat ──→ END
```

### 关键知识点扩展

#### addConditionalEdges 三要素

```javascript
.addConditionalEdges(
  "router",                          // 1. 从哪个节点出发
  (state) => state.route,            // 2. 路由函数：从 state 中取路由值
  { math: "math", chat: "chat" }    // 3. 映射表：路由值 → 目标节点名
)
```

**路由函数**的返回值必须能在映射表中找到对应的 key，否则会报错。

#### 与 if-else 的区别

传统代码用 if-else 控制流程，LangGraph 用**声明式**方式：你只描述"在什么条件下走哪条路"，框架负责执行。这样做的好处是：

1. **可可视化**：图的结构一目了然
2. **可追踪**：每一步的决策都有记录
3. **可组合**：条件路由可以嵌套、组合

---

## 第3课：循环与重试 —— 让图"反复尝试"

**对应文件**：`loop-retry.mjs`

### 核心概念

很多场景需要**循环执行**某个步骤直到条件满足（如重试失败的操作、轮询等待结果）。LangGraph 通过 `addConditionalEdges` 让边指回自身节点来实现循环。

### 代码解读

```javascript
const StateAnnotation = Annotation.Root({
  tries: Annotation({ reducer: (_prev, next) => next, default: () => 0 }),
  ok: Annotation({ reducer: (_prev, next) => next, default: () => false }),
  message: Annotation({ reducer: (_prev, next) => next, default: () => "" }),
});

const attempt = (state) => {
  const tries = state.tries + 1;
  const ok = tries >= 3; // 第3次才成功
  return {
    tries,
    ok,
    message: ok ? `第 ${tries} 次成功了！` : `第 ${tries} 次失败了，请再试一次`,
  };
};

const graph = new StateGraph(StateAnnotation)
  .addNode("attempt", attempt)
  .addEdge(START, "attempt")
  // 关键：条件边让 attempt 节点指回自身，形成循环！
  .addConditionalEdges("attempt", (state) => (state.ok ? "done" : "retry"), {
    retry: "attempt", // 失败 → 回到 attempt，形成循环
    done: END, // 成功 → 结束
  })
  .compile();

const result = await graph.invoke({ tries: 0 });
// 执行3次后结束，result.message = "第 3 次成功了！"
```

### 图的流程可视化

```
         ┌── retry ←──┐
START → attempt ───────┘
         │
         └─ done → END
```

### 关键知识点扩展

#### 循环的潜在风险：无限循环

如果条件永远不满足（如 `ok` 永远为 `false`），图会无限循环！**必须设置最大步数限制**。

推荐做法：

```javascript
const MAX_RETRIES = 10;

const attempt = (state) => {
  const tries = state.tries + 1;
  const ok = tries >= 3;
  const maxReached = tries >= MAX_RETRIES; // 安全阀
  return {
    tries,
    ok: ok || maxReached, // 达到上限也强制结束
    message: ok ? `成功` : maxReached ? `已达最大重试次数` : `失败，重试中`,
  };
};
```

#### 循环 vs 递归

LangGraph 的循环是**图层面的循环**（边指回自身），而不是函数递归。每次循环都是一次独立的节点执行，状态完整保存在 `state` 中。

---

## 第4课：错误处理 —— 让图"优雅失败"

**对应文件**：`trigger-error.mjs`

### 核心概念

图执行中可能抛出异常。LangGraph 中节点抛出的错误**不会自动捕获**，会直接传播到调用方。因此必须在 `invoke` 外层用 `try/catch` 处理。

### 代码解读

```javascript
const StateAnnotation = Annotation.Root({
  text: Annotation({ reducer: (_prev, next) => next, default: () => "" }),
});

const stepOk = (state) => ({ text: `${state.text}[ok]` });

// 这个节点会故意抛出错误
const stepThrow = () => {
  throw new Error("DemoError: 模拟业务异常（trigger-error.mjs）");
};

const graph = new StateGraph(StateAnnotation)
  .addNode("step_ok", stepOk)
  .addNode("step_throw", stepThrow)
  .addEdge(START, "step_ok")
  .addEdge("step_ok", "step_throw")
  .addEdge("step_throw", END)
  .compile();

// 错误处理：try/catch 包裹 invoke
try {
  await graph.invoke({ text: "start" });
  console.log("不会到达这里");
} catch (err) {
  console.error("捕获异常：", err?.message ?? err);
  process.exitCode = 1;
}
```

### 图的流程可视化

```
START → step_ok → step_throw → END
                       ↑
                  这里会抛异常！
```

### 关键知识点扩展

#### 三种错误处理策略

| 策略                 | 方式                                         | 适用场景                   |
| -------------------- | -------------------------------------------- | -------------------------- |
| **外层 try/catch**   | `try { await graph.invoke() } catch { ... }` | 简单场景，整个图失败       |
| **节点内 try/catch** | 在节点函数内部捕获，将错误写入 state         | 需要根据错误类型做不同处理 |
| **降级节点**         | 用条件路由，错误时跳转到降级处理节点         | 需要优雅降级的场景         |

**节点内捕获示例**：

```javascript
const safeStep = (state) => {
  try {
    const result = mightFail(state);
    return { text: result, error: null };
  } catch (err) {
    return { text: "", error: err.message }; // 把错误写入 state
  }
};
```

#### 未捕获异常的后果

如果异常没有被捕获，图的执行会中断，状态不会保存。如果使用了 Checkpointer（下节内容），下次可以从断点恢复。

---

## 第5课：状态持久化（Checkpointer）—— 让图"记住过去"

**对应文件**：`checkpointer-memory.mjs`、`checkpointer-sqlite.mjs`

### 核心概念

默认情况下，图的每次 `invoke` 都是**独立的**，不会记住上一次的状态。`Checkpointer` 可以持久化状态，实现：

1. **跨调用保持状态** —— 同一个 thread_id 的多次调用共享状态
2. **断点恢复** —— 中断后可从上次的位置继续

### 代码解读 —— 内存版

```javascript
import {
  Annotation,
  END,
  MemorySaver,
  START,
  StateGraph,
} from "@langchain/langgraph";

// 定义状态：visitCount 记录访问次数，message 记录提示信息
const StateAnnotation = Annotation.Root({
  visitCount: Annotation({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  message: Annotation({
    reducer: (_prev, next) => next,
    default: () => "",
  }),
});

// 记录访问次数的节点：每次调用 visitCount + 1
function recordVisit(state) {
  const visitCount = state.visitCount + 1;
  const message =
    visitCount === 1
      ? "你是今年第 1 位访客！"
      : `你是今年第 ${visitCount} 位访客`;
  return { visitCount, message };
}

const graph = new StateGraph(StateAnnotation)
  .addNode("recordVisit", recordVisit)
  .addEdge(START, "recordVisit")
  .addEdge("recordVisit", END);

// 关键：编译时传入 checkpointer
const checkpointer = new MemorySaver();
const app = graph.compile({ checkpointer });

// 用 thread_id 区分不同会话
const user1 = { configurable: { thread_id: "用户-张三" } };
const user2 = { configurable: { thread_id: "用户-李四" } };

const res1 = await app.invoke({}, user1); // visitCount = 1
const res2 = await app.invoke({}, user1); // visitCount = 2（张三的计数累加！）
const res3 = await app.invoke({}, user1); // visitCount = 3
const res4 = await app.invoke({}, user2); // visitCount = 1（李四独立计数）
```

### 代码解读 —— SQLite 持久化版

```javascript
import { existsSync, unlinkSync } from "node:fs";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

// 状态定义与内存版完全一致（此处省略，见上方内存版）
const StateAnnotation = Annotation.Root({
  visitCount: Annotation({ reducer: (_prev, next) => next, default: () => 0 }),
  message: Annotation({ reducer: (_prev, next) => next, default: () => "" }),
});

// 节点定义也完全一致
function recordVisit(state) {
  const visitCount = state.visitCount + 1;
  const message =
    visitCount === 1
      ? "你是今年第 1 位访客！"
      : `你是今年第 ${visitCount} 位访客`;
  return { visitCount, message };
}

const dbPath = "./src/checkpointer-demo.sqlite";
const graph = new StateGraph(StateAnnotation)
  .addNode("recordVisit", recordVisit)
  .addEdge(START, "recordVisit")
  .addEdge("recordVisit", END);

// 每次运行先删除旧数据库（仅 demo 用，生产环境不要删！）
if (existsSync(dbPath)) {
  unlinkSync(dbPath);
}

// 用 SQLite 替代内存，状态保存到文件
const checkpointer = SqliteSaver.fromConnString(dbPath);
const app = graph.compile({ checkpointer });
```

### 关键知识点扩展

#### MemorySaver vs SqliteSaver

| 特性     | MemorySaver        | SqliteSaver            |
| -------- | ------------------ | ---------------------- |
| 存储位置 | 内存（进程内）     | SQLite 文件            |
| 持久性   | 进程退出即丢失     | 永久保存               |
| 性能     | 极快               | 稍慢（磁盘 IO）        |
| 适用场景 | 开发测试、短期会话 | 生产环境、需要长期保存 |

#### thread_id 的作用

`thread_id` 是区分不同"会话"的关键。相同 `thread_id` 的调用共享状态，不同的 `thread_id` 互相隔离。

```
用户A (thread_id: "A") → visitCount: 1, 2, 3 ...
用户B (thread_id: "B") → visitCount: 1, 2, 3 ...  (独立计数)
```

生产环境通常用**用户ID + 会话ID**作为 `thread_id`。

---

## 第6课：人机交互（Interrupt）—— 让图"等人类确认"

**对应文件**：`graph-interrupt.mjs`

### 核心概念

很多场景需要**人类确认**后才能继续（如转账确认、审批流程）。LangGraph 的 `interrupt()` 函数可以让图暂停执行，等待外部输入后用 `Command` 恢复。

### 代码解读

```javascript
import { Command, interrupt } from "@langchain/langgraph";

const StateAnnotation = Annotation.Root({
  actionSummary: Annotation({ ... }),
  userInput: Annotation({ ... }),
});

// 1️⃣ 展示操作摘要的节点
const showTransfer = () => ({
  actionSummary: "正在转账 ¥100（模拟），不会真正扣款",
});

// 2️⃣ 等待用户确认的节点 —— 调用 interrupt() 暂停图
const waitConfirm = (state) => {
  const text = interrupt({
    hint: "请确认操作「转账」，输入 y 继续，输入 n 取消",
    actionSummary: state.actionSummary,
  });
  return { userInput: String(text) };
};

const graph = new StateGraph(StateAnnotation)
  .addNode("showTransfer", showTransfer)
  .addNode("waitConfirm", waitConfirm)
  .addEdge(START, "showTransfer")
  .addEdge("showTransfer", "waitConfirm")
  .addEdge("waitConfirm", END)
  .compile({ checkpointer: new MemorySaver() });  // interrupt 必须配合 checkpointer

// 3️⃣ 第一次调用：图会在 interrupt 处暂停
const config = { configurable: { thread_id: "interrupt-demo" } };
const paused = await graph.invoke({}, config);
console.log("已暂停：", paused.__interrupt__?.[0]?.value);

// 4️⃣ 获取用户输入（命令行交互）
const rl = createInterface({ input: process.stdin, output: process.stdout });
const line = (await rl.question("> ")).trim();

// 5️⃣ 用 Command 恢复执行，传入用户输入
const done = await graph.invoke(new Command({ resume: line }), config);
console.log("完成：", done);
```

### 图的流程可视化

```
START → showTransfer → waitConfirm（interrupt暂停）⏸
                                              ↓ 用户输入
                                    Command({ resume }) → END
```

### 关键知识点扩展

#### interrupt 为什么需要 Checkpointer？

因为图暂停后需要**保存当前状态**，等用户确认后才能恢复。没有 Checkpointer，暂停的状态就丢失了。

#### interrupt 的完整生命周期

```
1. invoke() → 执行到 interrupt() → 暂停，返回 __interrupt__ 信息
2. 用户在外部做决策（CLI输入、UI按钮、API调用...）
3. invoke(new Command({ resume: 用户输入 })) → 从断点恢复，继续执行
```

#### 实际应用场景

- 转账/支付确认
- 合同审批
- 代码执行前的安全审查
- AI 生成内容的人工校验

---

## 第7课：工具调用（ToolNode）—— 给图"装上手脚"

**对应文件**：`prebuilt-tool-node.mjs`、`inventory-mock.mjs`

### 核心概念

LLM 本身只能"说话"，不能"做事"。**工具（Tool）** 让 LLM 能调用外部 API、查询数据库等。LangGraph 的 `ToolNode` 是预置的工具执行节点，自动处理工具调用流程。

### 辅助模块 —— inventory-mock.mjs

```javascript
/** 模拟数据，仅测试用 */
const rows = [
  { sku: "SKU-001", name: "机械键盘", stock: 42 },
  { sku: "SKU-002", name: "蓝牙鼠标", stock: 7 },
  { sku: "SKU-003", name: "USB-C 集线器", stock: 120 },
];

export function getProductBySku(sku) {
  const key = String(sku).trim().toUpperCase();
  const row = rows.find((r) => r.sku.toUpperCase() === key);
  if (!row) return JSON.stringify({ found: false, sku: String(sku).trim() });
  return JSON.stringify({ found: true, ...row });
}
```

### 代码解读

```javascript
import { tool } from "@langchain/core/tools";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { MessagesAnnotation } from "@langchain/langgraph";

// 1️⃣ 定义工具
const getProductStock = tool(
  async ({ sku }) => getProductBySku(sku),
  {
    name: "get_product_stock",
    description: "根据 SKU 查询库存数量，SKU 如 SKU-001",
    schema: z.object({
      sku: z.string().describe("产品 SKU"),
    }),
  }
);

const tools = [getProductStock];

// 2️⃣ 创建绑定了工具的 LLM
const llm = new ChatOpenAI({ ... }).bindTools(tools);

// 3️⃣ Agent 节点：调用 LLM
async function agent(state) {
  const response = await llm.invoke(state.messages);
  return { messages: response };
}

// 4️⃣ ToolNode：自动执行工具
const toolNode = new ToolNode(tools);

// 5️⃣ 构建图
const graph = new StateGraph(MessagesAnnotation)
  .addNode("agent", agent)
  .addNode("tools", toolNode)
  .addEdge(START, "agent")
  // toolsCondition：如果 LLM 返回了 tool_call → 走 tools 节点；否则 → END
  .addConditionalEdges("agent", toolsCondition, ["tools", END])
  .addEdge("tools", "agent")  // 工具执行完 → 回到 agent 继续推理
  .compile();
```

### 图的流程可视化

```
         ┌── tool_call ──→ tools ──┐
START → agent ←───────────────────┘
         │
         └── 无 tool_call → END
```

### 关键知识点扩展

#### toolsCondition 是什么？

`toolsCondition` 是 LangGraph 预置的条件判断函数，它会检查 LLM 的输出：

- 如果包含 `tool_calls` → 返回 `"tools"`（去执行工具）
- 如果不包含 → 返回 `END`（直接结束）

相当于帮你写了这段逻辑：

```javascript
(state) => {
  const lastMessage = state.messages.at(-1);
  return lastMessage.tool_calls?.length > 0 ? "tools" : END;
};
```

#### ToolNode 的工作原理

`ToolNode` 接收 LLM 返回的 `tool_calls`，自动：

1. 根据 `name` 找到对应的工具函数
2. 传入 `args` 执行
3. 将结果包装成 `ToolMessage` 追加到 messages

#### 这个循环模式叫 ReAct

```
Agent(思考) → Action(调用工具) → Observation(观察结果) → Agent(再思考) → ...
```

这就是著名的 **ReAct 模式**（Reasoning + Acting），是当前 Agent 的主流范式。

---

## 第8课：预置 Agent（createAgent）—— 快速搭建

**对应文件**：`prebuilt-agent.mjs`

### 核心概念

`langchain` 包提供的 `createAgent` 是一个**高级封装**，一行代码就能创建带工具调用的完整 Agent，不需要手动构建图。

### 代码解读

```javascript
import { createAgent, tool } from "langchain";

// 定义工具（同第7课）
const getProductStock = tool(async ({ sku }) => getProductBySku(sku), {
  name: "get_product_stock",
  description: "根据 SKU 查询库存数量",
  schema: z.object({ sku: z.string().describe("产品 SKU") }),
});

// 一行创建 Agent！
const agent = createAgent({
  model,
  tools: [getProductStock],
  systemPrompt:
    "你是一个仓库助手。请使用 get_product_stock（模拟数据）来回答库存问题。",
  checkpointer: new MemorySaver(),
});

// 使用
const result = await agent.invoke(
  { messages: [new HumanMessage("SKU-002 还有多少库存？")] },
  { configurable: { thread_id: "demo-thread" } },
);
```

### 关键知识点扩展

#### createAgent vs 手动构建图

| 维度     | createAgent           | 手动构建 StateGraph |
| -------- | --------------------- | ------------------- |
| 代码量   | 极少（~10行）         | 较多（~30行）       |
| 灵活性   | 低（固定 ReAct 模式） | 高（自由设计流程）  |
| 适用场景 | 简单问答、工具调用    | 复杂工作流、多步骤  |
| 可定制性 | 只能改 prompt 和工具  | 完全自定义          |

**经验法则**：先用 `createAgent` 快速验证想法，遇到瓶颈时再转为手动构建。

---

## 第9课：多 Agent 协作（Supervisor）—— 团队协作

**对应文件**：`multi-agent-supervisor.mjs`、`simple-mock.mjs`

### 核心概念

复杂任务往往需要**多个专家**协作。Supervisor 模式中，一个"主管 Agent"负责理解用户意图，把任务**分派**给最合适的"专家 Agent"。

### 辅助模块 —— simple-mock.mjs

```javascript
// 模拟天气数据
const weatherTable = {
  北京: { summary: "晴朗少云", tempHighC: 22, tempLowC: 15, aqi: "良" },
  上海: { summary: "阴", tempHighC: 26, tempLowC: 12, aqi: "局部沙尘暴" },
  广州: { summary: "雨", tempHighC: 20, tempLowC: 16, aqi: "良" },
};

// 查天气（模拟）
export function lookupWeather(city) { ... }

// 查城市旅游攻略（模拟）
export function lookupCityTrivia(city) { ... }
```

### 代码解读

```javascript
import { createSupervisor } from "@langchain/langgraph-supervisor";

// 1️⃣ 定义天气 Agent
const weatherAgent = createAgent({
  name: "weather_agent",
  description: "查询天气",
  model,
  tools: [lookupWeatherTool],
  systemPrompt: "你负责查询天气。请使用 lookup_weather 工具来获取信息。",
});

// 2️⃣ 定义旅游攻略 Agent
const triviaAgent = createAgent({
  name: "trivia_agent",
  description: "查询城市旅游攻略、特色、风土人情",
  model,
  tools: [lookupCityTriviaTool],
  systemPrompt:
    "你负责查询城市的旅游攻略。使用 lookup_city_trivia，给出详细、有趣的介绍。",
});

// 3️⃣ 创建 Supervisor —— 协调多个 Agent
const workflow = createSupervisor({
  agents: [weatherAgent.graph, triviaAgent.graph],
  llm: model,
  prompt: `你是一个全能助手，根据用户需求委派任务。

  天气、旅游攻略、城市概况 ⇒ 使用 weather_agent
  旅游攻略、特产、美食、文化体验 ⇒ 使用 trivia_agent`,
});

const app = workflow.compile();

// 4️⃣ 流式调用
const stream = await app.stream(input, { streamMode: ["updates", "values"] });
for await (const event of stream) {
  const [mode, payload] = event;
  if (mode === "updates") {
    nodePath.push(...Object.keys(payload));
  }
}
```

### 图的流程可视化

```
                    ┌── weather_agent ──┐
START → supervisor ─┤                   ├→ END
                    └── trivia_agent ───┘
```

### 关键知识点扩展

#### Supervisor 模式的核心思想

```
用户请求 → Supervisor（理解意图）
                ├── "问天气" → 分派给 weather_agent
                └── "问攻略" → 分派给 trivia_agent
```

Supervisor 自己不干活，只负责**分配任务**。这就像公司里的项目经理，不需要自己写代码，但要知道谁适合做什么。

#### 三种多 Agent 协作模式

| 模式             | 结构               | 适用场景               |
| ---------------- | ------------------ | ---------------------- |
| **Supervisor**   | 1个主管 + N个工人  | 任务类型明确，需要路由 |
| **Pipeline**     | A → B → C 流水线   | 任务有严格的先后顺序   |
| **Peer-to-Peer** | Agent 之间直接通信 | 对等协作，无中心节点   |

#### 流式输出（stream）

```javascript
const stream = await app.stream(input, { streamMode: ["updates", "values"] });
for await (const event of stream) {
  const [mode, payload] = event;
  // mode === "updates" → 节点更新事件
  // mode === "values" → 完整状态快照
}
```

流式输出让你可以**实时追踪** Agent 的执行路径，知道它调了哪个子 Agent。

---

## 知识点速查表

### 核心 API 一览

| API                      | 用途              | 示例                                                   |
| ------------------------ | ----------------- | ------------------------------------------------------ |
| `Annotation.Root()`      | 定义状态结构      | `Annotation.Root({ text: Annotation({...}) })`         |
| `StateGraph`             | 创建状态图        | `new StateGraph(StateAnnotation)`                      |
| `.addNode()`             | 添加节点          | `.addNode("name", handlerFn)`                          |
| `.addEdge()`             | 添加固定边        | `.addEdge("A", "B")`                                   |
| `.addConditionalEdges()` | 添加条件边        | `.addConditionalEdges("A", routerFn, map)`             |
| `.compile()`             | 编译图            | `.compile({ checkpointer })`                           |
| `.invoke()`              | 执行图            | `await graph.invoke(input, config)`                    |
| `.stream()`              | 流式执行          | `await graph.stream(input, config)`                    |
| `interrupt()`            | 暂停等待人类输入  | `interrupt({ hint: "..." })`                           |
| `Command`                | 恢复暂停的图      | `new Command({ resume: value })`                       |
| `MemorySaver`            | 内存持久化        | `new MemorySaver()`                                    |
| `ToolNode`               | 预置工具执行节点  | `new ToolNode(tools)`                                  |
| `toolsCondition`         | 工具调用条件判断  | `.addConditionalEdges("agent", toolsCondition, [...])` |
| `createAgent`            | 快速创建 Agent    | `createAgent({ model, tools, ... })`                   |
| `createSupervisor`       | 创建多 Agent 协作 | `createSupervisor({ agents, llm, ... })`               |

### 状态注解（Annotation）常见写法

```javascript
const State = Annotation.Root({
  // 简单覆盖
  text: Annotation({ reducer: (_prev, next) => next, default: () => "" }),
  // 数值累加
  count: Annotation({ reducer: (prev, next) => prev + next, default: () => 0 }),
  // 布尔标记
  done: Annotation({ reducer: (_prev, next) => next, default: () => false }),
  // 消息列表（LangChain 内置）
  messages: MessagesAnnotation,
});
```

---

## 实战练习建议

### 练习1（基础）

修改 `basic-graph.mjs`，添加一个 `step3` 节点，观察状态如何传递。

### 练习2（条件路由）

修改 `conditional-routing.mjs`，增加一个 "translate" 路由分支，当 query 包含中文时走翻译节点。

### 练习3（循环重试）

修改 `loop-retry.mjs`，添加 `maxRetries` 限制，防止无限循环。

### 练习4（人机交互）

基于 `graph-interrupt.mjs`，设计一个"AI 代码审查"流程：AI 先分析代码，然后 interrupt 等待用户确认是否自动修复。

### 练习5（多 Agent）

基于 `multi-agent-supervisor.mjs`，添加第三个 Agent（如 "code_review_agent"），让 Supervisor 能根据用户需求路由到代码审查功能。

---

## 安装与运行

```bash
# 克隆项目
git clone https://github.com/QuarkGluonPlasma/ai-agent-course-code.git
cd ai-agent-course-code/langgraph-test

# 安装依赖
npm install
# 或
pnpm install

# 配置 .env 文件
# OPENAI_API_KEY=your-key
# OPENAI_BASE_URL=your-proxy   # 可选
# MODEL_NAME=gpt-4o-mini       # 可选

# 运行某个示例
node src/basic-graph.mjs
node src/conditional-routing.mjs
node src/loop-retry.mjs
```

> 注意：`prebuilt-agent.mjs`、`prebuilt-tool-node.mjs`、`multi-agent-supervisor.mjs` 需要配置 OpenAI API Key，其他示例不需要 LLM 即可运行。
