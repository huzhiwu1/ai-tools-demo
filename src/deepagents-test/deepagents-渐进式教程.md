# DeepAgents 渐进式学习教程

> 从零开始，7 个任务掌握 DeepAgents 框架的核心能力

---

## 什么是 DeepAgents？

DeepAgents 是基于 LangChain 的高层 Agent 框架，它的核心理念是：

**用 Middleware（中间件）组装 Agent，而不是手写复杂的 Agent 逻辑。**

你可以把 DeepAgents 想象成一条「流水线」：

```
用户输入 → [Middleware 1] → [Middleware 2] → [Middleware 3] → LLM → 输出
                ↑               ↑               ↑
             日志/统计       注入上下文       权限控制
```

每个 Middleware 就像流水线上的一个「工位」，负责一块独立的功能。你可以自由组合、添加、移除 Middleware，而不需要修改 Agent 本身的代码。

---

## 核心概念速览

| 概念                            | 作用                | 类比                      |
| ------------------------------- | ------------------- | ------------------------- |
| `createAgent`                   | 创建 Agent 实例     | 组装一台电脑              |
| `createMiddleware`              | 创建自定义中间件    | 给电脑装一个插件          |
| `createFilesystemMiddleware`    | 文件系统操作中间件  | 给 Agent 一个「硬盘」     |
| `createMemoryMiddleware`        | 持久记忆中间件      | 给 Agent 一个「笔记本」   |
| `createSummarizationMiddleware` | 对话摘要中间件      | 给 Agent 一个「压缩器」   |
| `createSubAgentMiddleware`      | 子 Agent 委派中间件 | 给 Agent 配「小助手」     |
| `createSkillsMiddleware`        | 技能扩展中间件      | 给 Agent 装一个「技能包」 |

---

## 学习路线

```
Task 1: 基础 Agent + Middleware 入门
   ↓
Task 2: Middleware 进阶 — wrapToolCall 与工具注入
   ↓
Task 3: 文件系统 Middleware — 权限控制与虚拟文件系统
   ↓
Task 4: 记忆 Middleware — 让 Agent 拥有持久记忆
   ↓
Task 5: 摘要 Middleware — 自动压缩长对话
   ↓
Task 6: 子 Agent Middleware — 多 Agent 协作
   ↓
Task 7: Skills Middleware — 技能扩展（进阶）
```

---

## Task 1: 基础 Agent + Middleware 入门

**目标**：理解 `createAgent` 和 `createMiddleware` 的基本用法

**你要做的事**：

1. 阅读 `src/exercise-01.mjs` 中的代码和注释
2. 在标记 `// TODO` 的位置补全代码
3. 运行 `pnpm ex1` 验证结果

**核心知识点**：

### 1.1 createAgent — 创建 Agent 的入口

```js
const agent = createAgent({
  model, // LLM 模型实例（如 ChatOpenAI）
  tools: [], // 工具列表（可为空）
  systemPrompt, // 系统提示词
  middleware: [], // 中间件列表（核心！）
});
```

### 1.2 createMiddleware — 中间件的 4 个钩子

Middleware 提供了 4 个生命周期钩子，按执行顺序：

```
beforeAgent → beforeModel → [LLM 调用] → afterModel → afterAgent
```

| 钩子          | 时机             | 典型用途                   |
| ------------- | ---------------- | -------------------------- |
| `beforeAgent` | Agent 循环开始前 | 初始化状态、打印开始日志   |
| `beforeModel` | 每次调用 LLM 前  | 注入额外上下文、拦截敏感词 |
| `afterModel`  | 每次调用 LLM 后  | 记录模型输出、统计调用次数 |
| `afterAgent`  | Agent 循环结束后 | 打印汇总、清理资源         |

### 1.3 stateSchema — 中间件的状态

```js
const myMiddleware = createMiddleware({
  name: "MyMiddleware",
  stateSchema: z.object({
    callCount: z.number().default(0), // 自定义状态字段
  }),
  beforeModel: (state) => {
    // 可以读取和修改 state
    console.log("当前调用次数:", state.callCount);
  },
  afterModel: (state) => {
    // 返回对象来更新 state
    return { callCount: state.callCount + 1 };
  },
});
```

**知识扩展：为什么用 Middleware 而不是直接写代码？**

传统方式：把日志、权限、统计等逻辑全部写在一个大函数里 → 代码臃肿、难以维护。

Middleware 方式：每个功能是独立的 Middleware → 可以自由组合、按需启用。

就像 Express.js 的中间件一样：`app.use(cors(), logger(), auth())` — 每个 middleware 各司其职。

---

## Task 2: Middleware 进阶 — wrapToolCall 与工具注入

**目标**：掌握 `wrapModelCall`、`wrapToolCall`、`tools` 注入等高级 Middleware 能力

**你要做的事**：

1. 阅读 `src/exercise-02.mjs` 中的代码和注释
2. 在标记 `// TODO` 的位置补全代码
3. 运行 `pnpm ex2` 验证结果

**核心知识点**：

### 2.1 wrapModelCall — 包装模型调用

```js
const middleware = createMiddleware({
  name: "AddContextMiddleware",
  wrapModelCall: async (request, handler) => {
    // 在调用模型前，修改 request
    const modifiedRequest = {
      ...request,
      systemMessage: request.systemMessage + "\n请用一句话回答。",
    };
    // 调用原始 handler（即真正的模型调用）
    return handler(modifiedRequest);
  },
});
```

流程：`request → [wrapModelCall 修改] → handler(实际调用模型) → response`

### 2.2 tools — 通过 Middleware 注入工具

```js
const middleware = createMiddleware({
  name: "ToolMiddleware",
  tools: [myTool], // 即使 createAgent 时 tools 为空，middleware 也能注入工具
});
```

**关键洞察**：Middleware 的 `tools` 字段让 Agent 无需在创建时就声明所有工具，而是按需注入！

### 2.3 wrapToolCall — 包装工具调用

```js
const middleware = createMiddleware({
  name: "WrapToolMiddleware",
  wrapToolCall: async (request, handler) => {
    console.log("工具即将执行:", request.toolCall.name);
    const result = await handler(request); // 执行原始工具
    console.log("工具执行完成");
    return result;
  },
});
```

**知识扩展：Middleware 的两种模式对比**

| 能力     | beforeXxx / afterXxx | wrapXxx              |
| -------- | -------------------- | -------------------- |
| 修改输入 | 只能返回 state 更新  | 可以修改 request     |
| 修改输出 | 不行                 | 可以修改 response    |
| 拦截调用 | beforeModel 可以跳转 | 可以不调用 handler   |
| 典型用途 | 日志、统计、拦截     | 注入上下文、包装结果 |

---

## Task 3: 文件系统 Middleware — 权限控制与虚拟文件系统

**目标**：掌握 `createFilesystemMiddleware` 和权限控制机制

**你要做的事**：

1. 阅读 `src/exercise-03.mjs` 中的代码和注释
2. 在标记 `// TODO` 的位置补全代码
3. 运行 `pnpm ex3` 验证结果

**核心知识点**：

### 3.1 FilesystemBackend — 虚拟文件系统

```js
const backend = new FilesystemBackend({
  rootDir: "./workspace", // 工作区根目录
  virtualMode: true, // 虚拟模式：Agent 看到的路径以 / 开头
});
```

`virtualMode: true` 意味着 Agent 操作的路径是 `/todo.md`，实际映射到 `rootDir/todo.md`。

### 3.2 权限控制 — 先匹配先生效

```js
const permissions = [
  { operations: ["read"], paths: ["/secret.txt"], mode: "deny" }, // 禁止读 secret
  { operations: ["write"], paths: ["/todo.md"], mode: "allow" }, // 允许写 todo
  { operations: ["write"], paths: ["/**"], mode: "deny" }, // 禁止写其他所有
];
```

规则从上到下匹配，**先匹配先生效**。未命中任何规则则默认允许。

### 3.3 createFilesystemMiddleware 提供的文件操作

Agent 通过工具调用来操作文件：`ls`、`read_file`、`write_file`、`edit_file`

**知识扩展：虚拟文件系统为什么重要？**

1. **安全性**：Agent 无法访问系统真实文件，只能操作工作区内的文件
2. **可预测性**：每次运行都是干净的工作区，结果可复现
3. **权限控制**：通过 permissions 精细控制 Agent 能做什么，防止误操作

---

## Task 4: 记忆 Middleware — 让 Agent 拥有持久记忆

**目标**：掌握 `createMemoryMiddleware` 的分类记忆机制

**你要做的事**：

1. 阅读 `src/exercise-04.mjs` 中的代码和注释
2. 在标记 `// TODO` 的位置补全代码
3. 运行 `pnpm ex4` 验证结果

**核心知识点**：

### 4.1 记忆分类 — 项目记忆 vs 偏好记忆

```js
const projectMemoryPath = "/AGENTS.md"; // 项目级记忆：技术栈、架构等
const preferencesMemoryPath = "/memory/preferences.md"; // 个人偏好：语言、风格等
```

**核心原则：不同类型的记忆存到不同文件，不要混写！**

### 4.2 createMemoryMiddleware

```js
createMemoryMiddleware({
  backend, // 文件系统后端
  sources: [projectMemoryPath, preferencesMemoryPath], // 记忆文件路径
});
```

Middleware 会在每次 Agent 调用时，自动读取 `sources` 中的文件内容，注入到 `<agent_memory>` 标签中。

### 4.3 记忆的工作流程

```
用户："记住我喜欢用 pnpm"
  ↓
Agent 调用 edit_file → 写入 /memory/preferences.md
  ↓
下次调用时，MemoryMiddleware 自动读取 → 注入到 prompt 中
  ↓
Agent 就能基于记忆回答："你常用 pnpm"
```

**知识扩展：为什么记忆要分类？**

如果不分类，所有信息都写到一个文件里：

- 文件会越来越长，token 浪费在无关信息上
- 项目信息和用户偏好混在一起，LLM 难以区分优先级
- 更新时容易互相覆盖

分类后：

- 每个文件职责单一，token 利用率高
- LLM 清楚每类信息的用途
- 更新时互不干扰

---

## Task 5: 摘要 Middleware — 自动压缩长对话

**目标**：掌握 `createSummarizationMiddleware` 的对话压缩机制

**你要做的事**：

1. 阅读 `src/exercise-05.mjs` 中的代码和注释
2. 在标记 `// TODO` 的位置补全代码
3. 运行 `pnpm ex5` 验证结果

**核心知识点**：

### 5.1 为什么需要摘要？

LLM 有上下文窗口限制（如 128K tokens）。对话越长，token 消耗越多，响应越慢。

摘要中间件的作用：当消息数超过阈值时，自动把旧对话压缩成摘要，只保留最近几条消息。

### 5.2 触发与保留配置

```js
createSummarizationMiddleware({
  model, // 用于生成摘要的 LLM
  backend, // 文件系统后端
  historyPathPrefix: "/conversation_history", // 摘要存储路径
  summaryPrompt, // 摘要提示词
  trigger: { type: "messages", value: 8 }, // 超过 8 条消息时触发
  keep: { type: "messages", value: 4 }, // 保留最近 4 条消息
});
```

### 5.3 摘要的执行流程

```
消息 1, 2, 3, 4, 5, 6, 7, 8  ← 超过 trigger(8)
  ↓
调用 LLM 生成摘要 → 保存到 /conversation_history/xxx.json
  ↓
保留最近 4 条消息 + 摘要作为上下文
  ↓
[摘要] + 消息 5, 6, 7, 8  ← 继续对话
```

**知识扩展：生产环境的 trigger 和 keep 怎么设？**

- Demo/测试：设较小的值（如 trigger=8, keep=4），便于快速触发看到效果
- 生产环境：可以省略 trigger/keep，让框架根据模型的 profile 自动推断最优值
- 原则：trigger 和 keep 的差值决定每次摘要的「压缩比」，差值越大压缩越多

---

## Task 6: 子 Agent Middleware — 多 Agent 协作

**目标**：掌握 `createSubAgentMiddleware` 的多 Agent 委派机制

**你要做的事**：

1. 阅读 `src/exercise-06.mjs` 中的代码和注释
2. 在标记 `// TODO` 的位置补全代码
3. 运行 `pnpm ex6` 验证结果

**核心知识点**：

### 6.1 为什么需要子 Agent？

单个 Agent 擅长一类任务，但遇到多步骤、多角色的复杂任务时，一个 Agent 很难兼顾所有方面。

子 Agent 模式：**主 Agent 做调度，子 Agent 做执行**。

### 6.2 定义子 Agent

```js
const subagents = [
  {
    name: "math-solver", // 子 Agent 名称
    description: "解数学题...", // 主 Agent 通过 description 选择委派给谁
    systemPrompt: "...", // 子 Agent 的系统提示词
    tools: [calc, divideEvenly], // 子 Agent 可用的工具
  },
  {
    name: "kid-tutor",
    description: "讲解解题过程...",
    systemPrompt: "...",
    tools: [], // 无工具，纯 LLM 推理
  },
];
```

### 6.3 主 Agent 的职责

```js
const agent = createAgent({
  model,
  tools: [], // 主 Agent 自己没有工具
  systemPrompt: "按顺序委派：① math-solver ② kid-tutor ③ practice-maker",
  middleware: [
    createSubAgentMiddleware({
      defaultModel: model,
      subagents, // 注册子 Agent
      generalPurposeAgent: false, // 不允许主 Agent 自己回答
    }),
  ],
});
```

主 Agent **自己不解题、不讲题、不出题**，只负责调度。这就像项目经理不写代码，但知道把任务分配给谁。

### 6.4 执行流程

```
用户："小明有 24 块糖..."
  ↓
主 Agent 分析 → 委派给 math-solver（计算）
  ↓
math-solver 完成 → 主 Agent 委派给 kid-tutor（讲解）
  ↓
kid-tutor 完成 → 主 Agent 委派给 practice-maker（出题）
  ↓
主 Agent 汇总所有结果 → 返回给用户
```

**知识扩展：generalPurposeAgent 的作用**

- `generalPurposeAgent: false`：主 Agent 只能通过 task 工具委派子 Agent，不能自己回答
- `generalPurposeAgent: true`：主 Agent 既可以委派，也可以自己回答

生产环境推荐 `false`，确保职责分离，防止主 Agent 越俎代庖。

---

## Task 7: Skills Middleware — 技能扩展（进阶）

**目标**：了解 `createSkillsMiddleware` 的技能扩展机制

**你要做的事**：

1. 阅读 `src/exercise-07.mjs` 中的代码和注释
2. 运行 `pnpm ex7` 验证结果（需先安装技能包）

**核心知识点**：

### 7.1 什么是 Skills？

Skills 是预定义的「技能包」，每个技能包含一个 `SKILL.md` 文件，描述了 Agent 应该如何完成特定任务。

类比：Skills 就像给 Agent 安装了一个「插件」或「应用」。

### 7.2 安装技能

```bash
npx skills add github/awesome-copilot --skill excalidraw-diagram-generator -y
```

### 7.3 createSkillsMiddleware

```js
createSkillsMiddleware({
  backend, // 文件系统后端
  sources: ["/.agents/skills/"], // 技能文件路径
});
```

### 7.4 技能的工作机制

1. Middleware 读取指定路径下的 `SKILL.md` 文件
2. 将技能描述注入到 Agent 的上下文中
3. Agent 根据用户需求，选择合适的技能并按 SKILL.md 中的指引执行

**知识扩展：Skills vs 传统 Tools 的区别**

| 维度     | Tools                  | Skills                     |
| -------- | ---------------------- | -------------------------- |
| 定义方式 | 代码（函数）           | Markdown（自然语言）       |
| 灵活性   | 固定行为               | LLM 自由解释               |
| 安装方式 | npm 包                 | npx skills add             |
| 适用场景 | 精确操作（计算、查询） | 复杂流程（绘图、生成代码） |

---

## 完成标准

每完成一个 Task，你需要：

1. 补全 `// TODO` 标记的代码
2. 运行对应的 `pnpm exN` 命令
3. 确认输出结果符合预期
4. 把你的代码发给我审查

准备好了吗？从 `exercise-01.mjs` 开始吧！
