# LangGraph.js 完全教程：完整源码 + 逐行注释 + 知识扩展

> 基于 [ai-agent-course-code/langgraph-test/src](https://github.com/QuarkGluonPlasma/ai-agent-course-code/tree/main/langgraph-test/src)
> 每课包含：✅ 可直接运行的完整源码 ✅ 逐行中文注释 ✅ 关键知识点深度扩展

---

## 学习路线

```
第1课 基础图(线性) → 第2课 条件路由 → 第3课 循环重试 → 第4课 错误处理
  → 第5课 状态持久化 → 第6课 人机交互 → 第7课 工具调用
  → 第8课 预置Agent → 第9课 多Agent协作
```

> 前6课无需 API Key，第7-9课需要配置 OpenAI API Key

---

## 第1课：基础图 —— 线性流程

**源文件**：`basic-graph.mjs` | **运行**：`node src/basic-graph.mjs` | **无需API Key**

### 完整源码（逐行注释版）

```javascript
// ============================================
// 第1课：基础图 —— 最简单的线性流程
// ============================================

import "dotenv/config"; // 加载 .env 环境变量（本课未用到，但为后续课程统一引入）
import {
  Annotation, // 定义状态的类型注解
  END, // 虚拟节点：图的终点
  START, // 虚拟节点：图的起点
  StateGraph, // 状态图构建器
} from "@langchain/langgraph";

// ──────────────────────────────────────────────
// 1️⃣ 定义状态 —— 图的"共享数据结构"
// ──────────────────────────────────────────────
// Annotation.Root() 创建一个状态定义，所有节点共享这个状态
// 每个字段需要指定 reducer（如何合并新旧值）和 default（初始值）
const StateAnnotation = Annotation.Root({
  text: Annotation({
    reducer: (_prev, next) => next, // 覆盖模式：新值直接替换旧值
    default: () => "", // 默认值：空字符串
  }),
});
// 💡 知识扩展：reducer 的两种模式
//   覆盖：(_prev, next) => next     → 新值替换旧值（最常用）
//   累加：(prev, next) => prev + next → 新值追加到旧值（如计数器）

// ──────────────────────────────────────────────
// 2️⃣ 定义节点 —— 每个节点是一个函数
// ──────────────────────────────────────────────
// 节点函数接收当前 state，返回 state 的部分更新
// 返回值会和当前 state 通过 reducer 合并
const step1 = (state) => ({ text: `${state.text} -> step1` });
//  ↑ 接收 { text: "hello" }  →  返回 { text: "hello -> step1" }

const step2 = (state) => ({ text: `${state.text} -> step2` });
//  ↑ 接收 { text: "hello -> step1" }  →  返回 { text: "hello -> step1 -> step2" }

// ──────────────────────────────────────────────
// 3️⃣ 构建图 —— 声明节点和边的连接关系
// ──────────────────────────────────────────────
const graph = new StateGraph(StateAnnotation)
  .addNode("step1", step1) // 注册节点：名字 "step1"，处理函数 step1
  .addNode("step2", step2) // 注册节点：名字 "step2"，处理函数 step2
  .addEdge(START, "step1") // 边：START → step1（入口边）
  .addEdge("step1", "step2") // 边：step1 → step2（固定边，无条件）
  .addEdge("step2", END) // 边：step2 → END（出口边）
  .compile(); // 编译：将声明式定义转为可执行图

// 💡 知识扩展：START 和 END
//   START = 虚拟入口节点，每个图必须有 START 出发的边
//   END   = 虚拟出口节点，执行到 END 时图结束
//   没有到达 END 的路径 → 图永远不会结束（可能无限循环）

// ──────────────────────────────────────────────
// 4️⃣ 可视化 —— 导出 Mermaid 流程图
// ──────────────────────────────────────────────
// 复制输出内容到 https://mermaid.live 即可看到流程图
const drawable = await graph.getGraphAsync();
const mermaid = drawable.drawMermaid({ withStyles: true });
console.log(mermaid);
// 输出类似：
// graph TD
//   __start__ --> step1
//   step1 --> step2
//   step2 --> __end__

// ──────────────────────────────────────────────
// 5️⃣ 运行图 —— invoke 执行
// ──────────────────────────────────────────────
const result = await graph.invoke({ text: "hello" });
console.log("result:", result);
// 输出：{ text: "hello -> step1 -> step2" }
//       ↑ 初始值 "hello" 经过 step1 和 step2 逐步追加
```

### 流程图

```
START → step1 → step2 → END
```

### 执行过程追踪

```
初始状态:  { text: "hello" }
  ↓ step1 执行
中间状态:  { text: "hello -> step1" }
  ↓ step2 执行
最终状态:  { text: "hello -> step1 -> step2" }
```

---

## 第2课：条件路由 —— 让图"做决策"

**源文件**：`conditional-routing.mjs` | **运行**：`node src/conditional-routing.mjs` | **无需API Key**

### 完整源码（逐行注释版）

```javascript
// ============================================
// 第2课：条件路由 —— 根据输入内容走不同分支
// ============================================

import "dotenv/config";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

// ──────────────────────────────────────────────
// 1️⃣ 定义状态
// ──────────────────────────────────────────────
const StateAnnotation = Annotation.Root({
  query: Annotation({
    // 用户输入的查询
    reducer: (_prev, next) => next,
    default: () => "",
  }),
  route: Annotation({
    // 路由决策结果：决定走哪条分支
    reducer: (_prev, next) => next,
    default: () => "chat", // 默认走 chat 分支
  }),
  answer: Annotation({
    // 最终答案
    reducer: (_prev, next) => next,
    default: () => "",
  }),
});

// ──────────────────────────────────────────────
// 2️⃣ 路由节点 —— 根据输入判断走哪条路
// ──────────────────────────────────────────────
const router = (state) => {
  // 检测查询中是否包含数学运算符 + - * /
  const isMath = /[+\-*/]/.test(state.query);
  // 将路由结果写入 state.route
  return { route: isMath ? "math" : "chat" };
};
// 💡 路由节点只做"决策"，不做"执行"
//   它的职责就是：往 state.route 里写入一个值
//   addConditionalEdges 会根据这个值决定下一步走哪个节点

// ──────────────────────────────────────────────
// 3️⃣ 业务节点 —— 两个分支各自的处理逻辑
// ──────────────────────────────────────────────
const mathNode = (state) => {
  try {
    return { answer: String(eval(state.query)) };
    // ⚠️ eval 仅供演示！生产环境绝对禁止使用 eval
    //   应使用 math.js 等安全库
  } catch {
    return { answer: "计算出错，请检查表达式" };
  }
};

const chatNode = (state) => ({ answer: `你的问题是：${state.query}` });

// ──────────────────────────────────────────────
// 4️⃣ 构建带条件路由的图
// ──────────────────────────────────────────────
const graph = new StateGraph(StateAnnotation)
  .addNode("router", router) // 路由节点
  .addNode("math", mathNode) // 数学分支
  .addNode("chat", chatNode) // 聊天分支
  .addEdge(START, "router") // 入口 → 路由
  .addConditionalEdges(
    // 🔑 核心：条件边
    "router", // 参数1：从哪个节点出发
    (state) => state.route, // 参数2：路由函数，从 state 取决策值
    {
      // 参数3：映射表，决策值 → 目标节点
      math: "math", //   "math"  → 走 mathNode
      chat: "chat", //   "chat"  → 走 chatNode
    },
  )
  .addEdge("math", END) // math 分支 → 结束
  .addEdge("chat", END) // chat 分支 → 结束
  .compile();

// ──────────────────────────────────────────────
// 5️⃣ 可视化
// ──────────────────────────────────────────────
const drawable = await graph.getGraphAsync();
const mermaid = drawable.drawMermaid({ withStyles: true });
console.log(mermaid);

// ──────────────────────────────────────────────
// 6️⃣ 测试两种路由
// ──────────────────────────────────────────────
console.log("聊天查询：", await graph.invoke({ query: "你好" }));
// 路由：query="你好" → 无运算符 → route="chat" → chatNode
// 输出：{ query: "你好", route: "chat", answer: "你的问题是：你好" }

console.log("数学查询：", await graph.invoke({ query: "10 * 8" }));
// 路由：query="10 * 8" → 有运算符 * → route="math" → mathNode
// 输出：{ query: "10 * 8", route: "math", answer: "80" }
```

### 流程图

```
         ┌─ math(route="math") ──→ END
START → router ─┤
         └─ chat(route="chat") ──→ END
```

### addConditionalEdges 三要素

```
addConditionalEdges(
  "router",                    ← 从哪个节点出发
  (state) => state.route,      ← 路由函数：取决策值
  { math: "math", chat: "chat" } ← 映射表：决策值 → 目标节点
)
```

> 路由函数返回值**必须**能在映射表中找到，否则报错！

---

## 第3课：循环与重试 —— 让图"反复尝试"

**源文件**：`loop-retry.mjs` | **运行**：`node src/loop-retry.mjs` | **无需API Key**

### 完整源码（逐行注释版）

```javascript
// ============================================
// 第3课：循环与重试 —— 条件边指回自身形成循环
// ============================================

import {
  Annotation,
  END,
  MemorySaver,
  START,
  StateGraph,
} from "@langchain/langgraph";

const StateAnnotation = Annotation.Root({
  tries: Annotation({
    // 重试次数
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  ok: Annotation({
    // 是否成功
    reducer: (_prev, next) => next,
    default: () => false,
  }),
  message: Annotation({
    // 状态消息
    reducer: (_prev, next) => next,
    default: () => "",
  }),
});

// ──────────────────────────────────────────────
// 核心：attempt 节点 —— 每次执行 tries+1
// ──────────────────────────────────────────────
const attempt = (state) => {
  const tries = state.tries + 1; // 累加尝试次数
  const ok = tries >= 3; // 第3次才算成功（模拟不稳定操作）
  return {
    tries,
    ok,
    message: ok ? `第 ${tries} 次成功了！` : `第 ${tries} 次失败了，请再试一次`,
  };
};
// 💡 注意：这里用了覆盖模式的 reducer
//   tries 的 reducer 是 (_prev, next) => next
//   所以 state.tries + 1 是基于当前 state 计算的新值
//   然后通过 return { tries } 覆盖旧值

// ──────────────────────────────────────────────
// 构建循环图
// ──────────────────────────────────────────────
const graph = new StateGraph(StateAnnotation)
  .addNode("attempt", attempt)
  .addEdge(START, "attempt")
  // 🔑 核心：条件边让 attempt 指回自身！
  .addConditionalEdges(
    "attempt",
    (state) => (state.ok ? "done" : "retry"), // ok=true → "done"，否则 → "retry"
    {
      retry: "attempt", // "retry" → 回到 attempt 节点（形成循环！）
      done: END, // "done" → 结束
    },
  )
  .compile();

// ──────────────────────────────────────────────
// 可视化
// ──────────────────────────────────────────────
const drawable = await graph.getGraphAsync();
const mermaid = drawable.drawMermaid({ withStyles: true });
console.log(mermaid);

// ──────────────────────────────────────────────
// 运行
// ──────────────────────────────────────────────
const result = await graph.invoke({ tries: 0 });
console.log("result:", result);
// 执行过程：
//   第1次：tries=1, ok=false → retry → 回到 attempt
//   第2次：tries=2, ok=false → retry → 回到 attempt
//   第3次：tries=3, ok=true  → done  → END
// 最终：{ tries: 3, ok: true, message: "第 3 次成功了！" }
```

### 流程图

```
         ┌── retry(ok=false) ←──┐
START → attempt ──────────────────┘
         │
         └── done(ok=true) → END
```

### ⚠️ 必须防无限循环

```javascript
// ✅ 安全做法：加上 maxRetries 上限
const MAX_RETRIES = 10;
const attempt = (state) => {
  const tries = state.tries + 1;
  const ok = tries >= 3;
  const maxReached = tries >= MAX_RETRIES;
  return {
    tries,
    ok: ok || maxReached, // 达到上限也强制结束
    message: ok ? `成功` : maxReached ? `已达最大重试次数` : `失败，重试中`,
  };
};
```

---

## 第4课：错误处理 —— 让图"优雅失败"

**源文件**：`trigger-error.mjs` | **运行**：`node src/trigger-error.mjs` | **无需API Key**

### 完整源码（逐行注释版）

```javascript
// ============================================
// 第4课：错误处理 —— 节点抛异常时的捕获策略
// ============================================
// 本课演示：节点内部使用 throw 抛出错误
//   在 Node.js 中，未 catch 的 Promise rejection 会导致进程退出
//   所以必须用 try/catch 包裹 await graph.invoke(...)
//   或者直接在节点函数内部 try/catch

import "dotenv/config";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

const StateAnnotation = Annotation.Root({
  text: Annotation({
    reducer: (_prev, next) => next,
    default: () => "",
  }),
});

// ──────────────────────────────────────────────
// 正常节点
// ──────────────────────────────────────────────
const stepOk = (state) => ({ text: `${state.text}[ok]` });

// ──────────────────────────────────────────────
// 异常节点 —— 故意抛出错误
// ──────────────────────────────────────────────
const stepThrow = () => {
  throw new Error("DemoError: 模拟业务异常（trigger-error.mjs）");
};

// ──────────────────────────────────────────────
// 构建图
// ──────────────────────────────────────────────
const graph = new StateGraph(StateAnnotation)
  .addNode("step_ok", stepOk)
  .addNode("step_throw", stepThrow)
  .addEdge(START, "step_ok")
  .addEdge("step_ok", "step_throw")
  .addEdge("step_throw", END)
  .compile();

// ──────────────────────────────────────────────
// 运行 + 错误捕获
// ──────────────────────────────────────────────
try {
  await graph.invoke({ text: "start" });
  console.log("不会到达这里"); // step_throw 会抛异常
} catch (err) {
  console.error("捕获异常：", err?.message ?? err);
  process.exitCode = 1; // 设置退出码，表示异常退出
}
```

### 流程图

```
START → step_ok → step_throw → END
                       ↑
                  这里会抛异常！
```

### 三种错误处理策略对比

| 策略           | 代码示例                                     | 适用场景               |
| -------------- | -------------------------------------------- | ---------------------- |
| 外层 try/catch | `try { await graph.invoke() } catch { ... }` | 简单场景               |
| 节点内捕获     | 在节点函数内部 try/catch，把错误写入 state   | 需根据错误类型分别处理 |
| 降级节点       | 条件路由 + 降级节点                          | 需优雅降级             |

```javascript
// 策略2：节点内捕获示例
const safeStep = (state) => {
  try {
    const result = mightFail(state);
    return { text: result, error: null };
  } catch (err) {
    return { text: "", error: err.message }; // 错误写入 state
  }
};
```

---

## 第5课：状态持久化（Checkpointer）—— 让图"记住过去"

**源文件**：`checkpointer-memory.mjs` + `checkpointer-sqlite.mjs` | **无需API Key**

### 完整源码1：内存版（逐行注释版）

```javascript
// ============================================
// 第5课：状态持久化 —— 内存版
// ============================================
// 核心问题：默认每次 invoke 都是独立的，状态不保留
// 解决方案：用 Checkpointer 持久化状态，同一 thread_id 的调用共享状态

import {
  Annotation,
  END,
  MemorySaver, // 内存版 Checkpointer
  START,
  StateGraph,
} from "@langchain/langgraph";

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

// ──────────────────────────────────────────────
// 业务节点：记录访问次数
// ──────────────────────────────────────────────
// 每次调用 visitCount + 1，配合 Checkpointer 实现"计数器"效果
function recordVisit(state) {
  const visitCount = state.visitCount + 1;
  const message =
    visitCount === 1
      ? "你是今年第 1 位访客！"
      : `你是今年第 ${visitCount} 位访客`;
  return { visitCount, message };
}

// ──────────────────────────────────────────────
// 构建图
// ──────────────────────────────────────────────
const graph = new StateGraph(StateAnnotation)
  .addNode("recordVisit", recordVisit)
  .addEdge(START, "recordVisit")
  .addEdge("recordVisit", END);

// ──────────────────────────────────────────────
// 🔑 核心：编译时传入 checkpointer
// ──────────────────────────────────────────────
const checkpointer = new MemorySaver(); // 内存版，进程退出即丢失
const app = graph.compile({ checkpointer });
// 💡 没有 checkpointer：每次 invoke 从初始状态开始
//    有 checkpointer：同一 thread_id 的 invoke 在上次状态基础上继续

// ──────────────────────────────────────────────
// 测试：用 thread_id 区分不同会话
// ──────────────────────────────────────────────
const user1 = { configurable: { thread_id: "用户-张三" } };
const user2 = { configurable: { thread_id: "用户-李四" } };

const res1 = await app.invoke({}, user1); // 张三第1次：visitCount = 1
const res2 = await app.invoke({}, user1); // 张三第2次：visitCount = 2
const res3 = await app.invoke({}, user1); // 张三第3次：visitCount = 3
const res4 = await app.invoke({}, user2); // 李四第1次：visitCount = 1（独立计数！）

console.log(res1); // { visitCount: 1, message: "你是今年第 1 位访客！" }
console.log(res2); // { visitCount: 2, message: "你是今年第 2 位访客" }
console.log(res3); // { visitCount: 3, message: "你是今年第 3 位访客" }
console.log(res4); // { visitCount: 1, message: "你是今年第 1 位访客！" }
```

### 完整源码2：SQLite 持久化版

```javascript
// ============================================
// 第5课：状态持久化 —— SQLite 版
// ============================================
// 与内存版的唯一区别：checkpointer 换成 SqliteSaver
// 状态保存到文件，进程退出后也不丢失

import { existsSync, unlinkSync } from "node:fs";

import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

const dbPath = "./src/checkpointer-demo.sqlite";

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

// ──────────────────────────────────────────────
// 🔑 区别在这里：用 SQLite 替代内存
// ──────────────────────────────────────────────
if (existsSync(dbPath)) {
  unlinkSync(dbPath); // 删除旧数据库（仅 demo 用，生产环境不要删！）
}

const checkpointer = SqliteSaver.fromConnString(dbPath); // 从连接字符串创建
const app = graph.compile({ checkpointer });

// 使用方式完全一致
const user1 = { configurable: { thread_id: "用户-张三" } };
const user2 = { configurable: { thread_id: "用户-李四" } };

const res1 = await app.invoke({}, user1);
const res2 = await app.invoke({}, user1);
const res3 = await app.invoke({}, user1);
const res4 = await app.invoke({}, user2);

console.log(res1);
console.log(res2);
console.log(res3);
console.log(res4);
```

### MemorySaver vs SqliteSaver 对比

| 特性   | MemorySaver    | SqliteSaver    |
| ------ | -------------- | -------------- |
| 存储   | 内存           | SQLite 文件    |
| 持久性 | 进程退出即丢失 | 永久保存       |
| 性能   | 极快           | 稍慢（磁盘IO） |
| 场景   | 开发测试       | 生产环境       |

---

## 第6课：人机交互（Interrupt）—— 让图"等人类确认"

**源文件**：`graph-interrupt.mjs` | **运行**：`node src/graph-interrupt.mjs` | **无需API Key**

### 完整源码（逐行注释版）

```javascript
// ============================================
// 第6课：人机交互 —— interrupt() 暂停等待人类确认
// ============================================
// 核心机制：
//   1. 节点内调用 interrupt() → 图暂停执行
//   2. 用户在外部做决策
//   3. 用 Command({ resume }) 恢复执行

import { createInterface } from "node:readline/promises";
import {
  Annotation,
  Command, // 恢复暂停的图的命令
  END,
  MemorySaver,
  START,
  StateGraph,
  interrupt, // 暂停图的关键函数
} from "@langchain/langgraph";

const StateAnnotation = Annotation.Root({
  actionSummary: Annotation({
    // 操作摘要
    reducer: (_prev, next) => next,
    default: () => "",
  }),
  userInput: Annotation({
    // 用户输入
    reducer: (_prev, next) => next,
    default: () => "",
  }),
});

// ──────────────────────────────────────────────
// 节点1：展示操作摘要
// ──────────────────────────────────────────────
const showTransfer = () => ({
  actionSummary: "正在转账 ¥100（模拟），不会真正扣款",
});

// ──────────────────────────────────────────────
// 节点2：等待用户确认 —— 🔑 调用 interrupt()
// ──────────────────────────────────────────────
const waitConfirm = (state) => {
  // interrupt() 会暂停图的执行
  // 参数是一个对象，会出现在返回值的 __interrupt__ 中，用于给用户提示
  const text = interrupt({
    hint: "请确认操作「转账」，输入 y 继续，输入 n 取消",
    actionSummary: state.actionSummary,
  });
  // 当图恢复时，interrupt() 的返回值就是 Command 中 resume 传入的值
  return { userInput: String(text) };
};

// ──────────────────────────────────────────────
// 构建图
// ──────────────────────────────────────────────
const graph = new StateGraph(StateAnnotation)
  .addNode("showTransfer", showTransfer)
  .addNode("waitConfirm", waitConfirm)
  .addEdge(START, "showTransfer")
  .addEdge("showTransfer", "waitConfirm")
  .addEdge("waitConfirm", END)
  .compile({ checkpointer: new MemorySaver() });
// ⚠️ interrupt 必须配合 checkpointer！
//   因为暂停时需要保存状态，恢复时需要读取状态

// ──────────────────────────────────────────────
// 可视化
// ──────────────────────────────────────────────
const drawable = await graph.getGraphAsync();
const mermaid = drawable.drawMermaid({ withStyles: true });
console.log(mermaid);

// ──────────────────────────────────────────────
// 第一次调用：图会在 interrupt 处暂停
// ──────────────────────────────────────────────
const config = { configurable: { thread_id: "interrupt-demo" } };

const paused = await graph.invoke({}, config);
// paused 的 __interrupt__ 属性包含 interrupt 传入的信息
console.log("\n已暂停：", paused.__interrupt__?.[0]?.value);
// 输出：{ hint: "请确认操作「转账」，输入 y 继续，输入 n 取消",
//         actionSummary: "正在转账 ¥100（模拟），不会真正扣款" }

// ──────────────────────────────────────────────
// 获取用户输入（命令行交互）
// ──────────────────────────────────────────────
const rl = createInterface({ input: process.stdin, output: process.stdout });
const line = (await rl.question("> ")).trim();
await rl.close();

if (!line) {
  console.error("未输入，退出。");
  process.exit(1);
}

// ──────────────────────────────────────────────
// 🔑 核心：用 Command 恢复执行，传入用户输入
// ──────────────────────────────────────────────
const done = await graph.invoke(new Command({ resume: line }), config);
//                          ↑ Command 对象        ↑ resume: 传给 interrupt() 的值
console.log("完成：", done);
// 输出：{ actionSummary: "正在转账 ¥100（模拟），不会真正扣款",
//         userInput: "y" }  ← 用户输入的值
```

### 流程图

```
START → showTransfer → waitConfirm ⏸ 暂停等待用户输入
                                       ↓ Command({ resume })
                                     → END
```

### interrupt 生命周期

```
1. invoke() → 执行到 interrupt() → 暂停，返回 __interrupt__ 信息
2. 用户在外部做决策（CLI输入、UI按钮、API调用...）
3. invoke(new Command({ resume: 用户输入 })) → 从断点恢复
```

---

## 第7课：工具调用（ToolNode）—— 给图"装上手脚"

**源文件**：`prebuilt-tool-node.mjs` + `inventory-mock.mjs` | **需要API Key**

### 辅助模块：inventory-mock.mjs

```javascript
/** 模拟数据，仅测试用（SKU 如 SKU-001） */
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

### 完整源码（逐行注释版）

```javascript
// ============================================
// 第7课：工具调用 —— ToolNode + toolsCondition
// ============================================
// 本课用手动构建 StateGraph 的方式实现 ReAct Agent
// ReAct = Reasoning(推理) + Acting(行动) 循环

import "dotenv/config";

import { HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools"; // 工具定义函数
import {
  END,
  MessagesAnnotation, // LangChain 内置的消息列表状态注解
  START,
  StateGraph,
} from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt"; // 预置组件
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

import { getProductBySku } from "./inventory-mock.mjs";

// ──────────────────────────────────────────────
// 1️⃣ 定义工具 —— tool() 函数
// ──────────────────────────────────────────────
const getProductStock = tool(
  async ({ sku }) => getProductBySku(sku), // 工具的实际执行函数
  {
    name: "get_product_stock", // 工具名称（LLM 通过名称调用）
    // 工具描述（LLM 通过描述决定何时调用）
    description: "根据 SKU 查询库存数量，SKU 如 SKU-001",
    schema: z.object({
      // 参数校验模式
      sku: z.string().describe("产品 SKU"), // describe() 帮助 LLM 理解参数含义
    }),
  },
);
// 💡 工具三要素：name + description + schema
//   name:       LLM 用它找到对应的执行函数
//   description: LLM 用它判断"什么时候该调用这个工具"
//   schema:     LLM 用它知道"需要传什么参数"

const tools = [getProductStock];

// ──────────────────────────────────────────────
// 2️⃣ 创建绑定了工具的 LLM
// ──────────────────────────────────────────────
const llm = new ChatOpenAI({
  modelName: process.env.MODEL_NAME,
  apiKey: process.env.OPENAI_API_KEY,
  configuration: {
    baseURL: process.env.OPENAI_BASE_URL,
  },
}).bindTools(tools);
// bindTools() 让 LLM 知道有哪些可用工具
// LLM 会在需要时返回 tool_calls 而不是纯文本

// ──────────────────────────────────────────────
// 3️⃣ Agent 节点 —— 调用 LLM 推理
// ──────────────────────────────────────────────
async function agent(state) {
  const response = await llm.invoke(state.messages);
  return { messages: response };
  // 返回的 messages 会追加到状态中
  // 如果 LLM 决定调用工具，response 中会包含 tool_calls
}

// ──────────────────────────────────────────────
// 4️⃣ ToolNode —— 自动执行工具
// ──────────────────────────────────────────────
const toolNode = new ToolNode(tools);
// ToolNode 做了什么？
//   1. 从最后一条 AIMessage 中提取 tool_calls
//   2. 根据 name 找到对应的工具函数
//   3. 传入 args 执行
//   4. 将结果包装成 ToolMessage 追加到 messages

// ──────────────────────────────────────────────
// 5️⃣ 构建图 —— ReAct 循环
// ──────────────────────────────────────────────
const graph = new StateGraph(MessagesAnnotation)
  .addNode("agent", agent) // Agent 节点
  .addNode("tools", toolNode) // 工具执行节点
  .addEdge(START, "agent")
  // toolsCondition：预置的条件判断
  //   LLM 返回了 tool_calls → 走 "tools" 节点
  //   LLM 没返回 tool_calls → 走 END
  .addConditionalEdges("agent", toolsCondition, ["tools", END])
  .addEdge("tools", "agent") // 工具执行完 → 回到 agent 继续推理
  .compile();

// ──────────────────────────────────────────────
// 6️⃣ 运行
// ──────────────────────────────────────────────
const result = await graph.invoke({
  messages: [new HumanMessage("查询 SKU-001 的库存数量，告诉我还剩多少件？")],
});

// 可视化
const drawable = await graph.getGraphAsync();
const mermaid = drawable.drawMermaid({ withStyles: true });
console.log(mermaid);

// 输出最终回答
const last = result.messages.at(-1);
console.log(last?.content ?? result.messages);
```

### 流程图

```
         ┌── tool_call ──→ tools ──┐
START → agent ←─────────────────────┘  （ReAct 循环）
         │
         └── 无 tool_call → END
```

### ReAct 循环执行过程

```
Agent: "我需要调用 get_product_stock 查询 SKU-001"
  → tool_call: { name: "get_product_stock", args: { sku: "SKU-001" } }
  → ToolNode 执行 → 结果: { found: true, sku: "SKU-001", name: "机械键盘", stock: 42 }
Agent: "根据查询结果，SKU-001 机械键盘库存42件"
  → 无 tool_call → END
```

---

## 第8课：预置 Agent（createAgent）—— 快速搭建

**源文件**：`prebuilt-agent.mjs` | **需要API Key**

### 完整源码（逐行注释版）

```javascript
// ============================================
// 第8课：预置 Agent —— createAgent 一行创建
// ============================================
// createAgent 是 langchain 包提供的高级封装
// 不需要手动构建 StateGraph，一行代码搞定

import "dotenv/config";

import { HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent, tool } from "langchain"; // 🔑 从 langchain 包导入
import { z } from "zod";

import { getProductBySku } from "./inventory-mock.mjs";

// ──────────────────────────────────────────────
// 定义工具（与第7课相同）
// ──────────────────────────────────────────────
const getProductStock = tool(async ({ sku }) => getProductBySku(sku), {
  name: "get_product_stock",
  description: "根据 SKU 查询库存数量，SKU 如 SKU-001",
  schema: z.object({
    sku: z.string().describe("产品 SKU"),
  }),
});

const model = new ChatOpenAI({
  modelName: process.env.MODEL_NAME,
  apiKey: process.env.OPENAI_API_KEY,
  configuration: {
    baseURL: process.env.OPENAI_BASE_URL,
  },
});

// ──────────────────────────────────────────────
// 🔑 核心：createAgent 一行创建 Agent
// ──────────────────────────────────────────────
const agent = createAgent({
  model, // LLM 模型
  tools: [getProductStock], // 工具列表
  // 系统提示词
  systemPrompt:
    "你是一个仓库助手。请使用 get_product_stock（模拟数据）来回答库存问题，其他问题拒绝回答。",
  checkpointer: new MemorySaver(), // 状态持久化
});
// 💡 createAgent 内部自动构建了第7课的 ReAct 图
//   等价于手动构建：StateGraph → addNode("agent") → addNode("tools") → ...

// ──────────────────────────────────────────────
// 使用
// ──────────────────────────────────────────────
const result = await agent.invoke(
  { messages: [new HumanMessage("SKU-002 还有多少库存？")] },
  { configurable: { thread_id: "demo-thread" } }, // thread_id 用于状态隔离
);

// 可视化
const drawable = await agent.graph.getGraphAsync();
const mermaid = drawable.drawMermaid({ withStyles: true });
console.log(mermaid);

// 输出
const last = result.messages.at(-1);
console.log(last?.content ?? result);
```

### createAgent vs 手动构建图

| 维度   | createAgent           | 手动构建 StateGraph |
| ------ | --------------------- | ------------------- |
| 代码量 | ~10行                 | ~30行               |
| 灵活性 | 低（固定 ReAct 模式） | 高（自由设计流程）  |
| 适用   | 简单问答/工具调用     | 复杂工作流/多步骤   |

> 经验法则：先用 createAgent 快速验证，遇到瓶颈再转手动构建

---

## 第9课：多 Agent 协作（Supervisor）—— 团队协作

**源文件**：`multi-agent-supervisor.mjs` + `simple-mock.mjs` | **需要API Key**

### 辅助模块：simple-mock.mjs

```javascript
/** 工具函数：模拟 supervisor 的两个数据源 */

function normCity(city) {
  return String(city).trim();
}

const weatherTable = {
  北京: { summary: "晴朗少云", tempHighC: 22, tempLowC: 15, aqi: "良" },
  上海: { summary: "阴", tempHighC: 26, tempLowC: 12, aqi: "局部沙尘暴" },
  广州: { summary: "雨", tempHighC: 20, tempLowC: 16, aqi: "良" },
};

const triviaTable = {
  北京: "故宫长城天安门广场人山人海，但冬天有暖气，夏天有空调，春秋最宜出行。",
  上海: "外滩的夜景让人忘记浦东的房价，但别忘了尝尝小笼包和生煎，那才是真正的上海。",
  广州: "早茶文化让你从早上吃到中午，如果你还没吃过肠粉虾饺凤爪，那你还不算来过广州。",
};

/** 查询城市天气（模拟数据，仅支持北上广） */
export function lookupWeather(city) {
  const c = normCity(city);
  const w = weatherTable[c];
  if (!w) {
    return JSON.stringify({
      city: c,
      summary: "暂无该城市天气数据，仅支持北京/上海/广州",
      tempHighC: 20,
      tempLowC: 12,
      aqi: "†",
    });
  }
  return JSON.stringify({ city: c, ...w });
}

/** 查询城市旅游攻略（模拟数据，可能没有该城市） */
export function lookupCityTrivia(city) {
  const c = normCity(city);
  const line = triviaTable[c];
  return JSON.stringify({
    city: c,
    trivia: line ?? `抱歉，没有${c}的攻略，但你可以去北京/上海/广州体验一番！`,
  });
}
```

### 完整源码（逐行注释版）

```javascript
// ============================================
// 第9课：多 Agent 协作 —— Supervisor 模式
// ============================================
// Supervisor = 主管 Agent，负责理解用户意图并分派给专家 Agent
// 每个 专家 Agent 有自己的工具和 systemPrompt

import "dotenv/config";

import { HumanMessage } from "@langchain/core/messages";
import { createSupervisor } from "@langchain/langgraph-supervisor"; // 🔑 Supervisor 工厂
import { ChatOpenAI } from "@langchain/openai";
import { createAgent, tool } from "langchain";
import { z } from "zod";

import { lookupCityTrivia, lookupWeather } from "./simple-mock.mjs";

// ──────────────────────────────────────────────
// 0️⃣ 创建 LLM
// ──────────────────────────────────────────────
const model = new ChatOpenAI({
  modelName: process.env.MODEL_NAME,
  apiKey: process.env.OPENAI_API_KEY,
  configuration: {
    baseURL: process.env.OPENAI_BASE_URL,
  },
});

// ──────────────────────────────────────────────
// 1️⃣ 定义天气 Agent（专家A）
// ──────────────────────────────────────────────
const lookupWeatherTool = tool(async ({ city }) => lookupWeather(city), {
  name: "lookup_weather",
  description: "查询城市天气、气温、空气质量等信息（仅支持北京/上海/广州）",
  schema: z.object({
    city: z.string().describe("城市名称，如 北京"),
  }),
});

/** 专家A：查询天气 */
const weatherAgent = createAgent({
  name: "weather_agent", // Agent 名称（Supervisor 用它来路由）
  description: "查询天气", // Agent 描述（Supervisor 用它来判断何时委派）
  model,
  tools: [lookupWeatherTool],
  systemPrompt: "你负责查询天气。请使用 lookup_weather 工具来获取信息。",
});
// 💡 name 和 description 非常关键！
//   Supervisor 的 LLM 会根据这些信息决定把任务分派给哪个 Agent

// ──────────────────────────────────────────────
// 2️⃣ 定义旅游攻略 Agent（专家B）
// ──────────────────────────────────────────────
const lookupCityTriviaTool = tool(async ({ city }) => lookupCityTrivia(city), {
  name: "lookup_city_trivia",
  description: "查询城市的旅游攻略、特色、风土人情等信息",
  schema: z.object({
    city: z.string().describe("城市名称，如 北京"),
  }),
});

/** 专家B：查询城市旅游攻略 */
const triviaAgent = createAgent({
  name: "trivia_agent",
  description: "查询城市旅游攻略、特色、风土人情",
  model,
  tools: [lookupCityTriviaTool],
  systemPrompt:
    "你负责查询城市的旅游攻略。使用 lookup_city_trivia，给出详细、有趣的介绍，不要编造信息。",
});

// ──────────────────────────────────────────────
// 3️⃣ 创建 Supervisor —— 协调多个 Agent
// ──────────────────────────────────────────────
// Supervisor 自己不执行任务，只负责分配
// 就像项目经理：不需要自己写代码，但要知道谁适合做什么
const workflow = createSupervisor({
  agents: [weatherAgent.graph, triviaAgent.graph], // 注册所有专家 Agent
  llm: model, // Supervisor 使用的 LLM
  prompt: `你是一个全能助手，根据用户需求委派任务，不要自己做，请委派给专业 agent。

  天气、旅游攻略、城市概况 ⇒ 使用 weather_agent
  旅游攻略、特产、美食、文化体验 ⇒ 使用 trivia_agent
`,
});

const app = workflow.compile();

// ──────────────────────────────────────────────
// 4️⃣ 可视化
// ──────────────────────────────────────────────
const drawable = await app.getGraphAsync();
console.log(drawable.drawMermaid({ withStyles: true }));

// ──────────────────────────────────────────────
// 5️⃣ 流式调用 —— 实时追踪执行路径
// ──────────────────────────────────────────────
const input = {
  messages: [new HumanMessage("查询一下北京的天气，还有北京的旅游攻略！")],
};

const nodePath = [];
let finalState = null;
const stream = await app.stream(input, { streamMode: ["updates", "values"] });
for await (const event of stream) {
  const [mode, payload] = event;
  if (mode === "updates" && payload && typeof payload === "object") {
    nodePath.push(...Object.keys(payload)); // 记录经过的节点
  } else if (mode === "values") {
    finalState = payload; // 保存最终状态
  }
}

console.log("路径：", nodePath.join(" → "));
// 可能输出：supervisor → weather_agent → supervisor → trivia_agent → supervisor

const last = finalState?.messages?.at(-1);
console.log(last?.content ?? finalState?.messages);
```

### 流程图

```
                    ┌── weather_agent ──┐
START → supervisor ─┤                   ├→ END
                    └── trivia_agent ───┘
```

### 三种多 Agent 协作模式

| 模式         | 结构             | 适用场景             |
| ------------ | ---------------- | -------------------- |
| Supervisor   | 1主管 + N工人    | 任务类型明确，需路由 |
| Pipeline     | A → B → C        | 严格先后顺序         |
| Peer-to-Peer | Agent 间直接通信 | 对等协作             |

---

## 速查表

### 核心 API

| API                      | 用途           | 示例                                                   |
| ------------------------ | -------------- | ------------------------------------------------------ |
| `Annotation.Root()`      | 定义状态       | `Annotation.Root({ text: Annotation({...}) })`         |
| `StateGraph`             | 创建状态图     | `new StateGraph(StateAnnotation)`                      |
| `.addNode()`             | 添加节点       | `.addNode("name", handlerFn)`                          |
| `.addEdge()`             | 添加固定边     | `.addEdge("A", "B")`                                   |
| `.addConditionalEdges()` | 添加条件边     | `.addConditionalEdges("A", routerFn, map)`             |
| `.compile()`             | 编译图         | `.compile({ checkpointer })`                           |
| `.invoke()`              | 执行图         | `await graph.invoke(input, config)`                    |
| `.stream()`              | 流式执行       | `await graph.stream(input, config)`                    |
| `interrupt()`            | 暂停等待       | `interrupt({ hint: "..." })`                           |
| `Command`                | 恢复暂停       | `new Command({ resume: value })`                       |
| `MemorySaver`            | 内存持久化     | `new MemorySaver()`                                    |
| `ToolNode`               | 工具执行节点   | `new ToolNode(tools)`                                  |
| `toolsCondition`         | 工具调用判断   | `.addConditionalEdges("agent", toolsCondition, [...])` |
| `createAgent`            | 快速创建 Agent | `createAgent({ model, tools, ... })`                   |
| `createSupervisor`       | 多Agent协作    | `createSupervisor({ agents, llm, ... })`               |

### Annotation 常见写法

```javascript
const State = Annotation.Root({
  text: Annotation({ reducer: (_prev, next) => next, default: () => "" }), // 覆盖
  count: Annotation({ reducer: (prev, next) => prev + next, default: () => 0 }), // 累加
  done: Annotation({ reducer: (_prev, next) => next, default: () => false }), // 布尔
  messages: MessagesAnnotation, // 消息列表
});
```

---

## 安装与运行

```bash
git clone https://github.com/QuarkGluonPlasma/ai-agent-course-code.git
cd ai-agent-course-code/langgraph-test
npm install   # 或 pnpm install

# 配置 .env
# OPENAI_API_KEY=your-key
# OPENAI_BASE_URL=your-proxy
# MODEL_NAME=gpt-4o-mini

# 无需 API Key 的示例
node src/basic-graph.mjs
node src/conditional-routing.mjs
node src/loop-retry.mjs
node src/trigger-error.mjs
node src/checkpointer-memory.mjs
node src/checkpointer-sqlite.mjs
node src/graph-interrupt.mjs

# 需要 API Key 的示例
node src/prebuilt-tool-node.mjs
node src/prebuilt-agent.mjs
node src/multi-agent-supervisor.mjs
```
