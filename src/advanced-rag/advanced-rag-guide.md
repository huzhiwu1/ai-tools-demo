# 基于 LangGraph 实现大模型自主决策的 RAG 闭环系统

> 从「流水线 RAG」到「会思考的 RAG」，4 步渐进式掌握 LangGraph + RAG 的核心设计模式

---

## 目录

- [教程总览：我们到底要学什么？](#教程总览我们到底要学什么)
- [前置知识：4 个你必须先理解的概念](#前置知识4-个你必须先理解的概念)
- [第一关：朴素 RAG —— 最简单的检索问答](#第一关朴素-rag--最简单的检索问答)
- [第二关：查询路由 RAG —— 让系统学会判断](#第二关查询路由-rag--让系统学会判断)
- [第三关：多跳 RAG —— 让系统学会拆解问题](#第三关多跳-rag--让系统学会拆解问题)
- [第四关：联网兜底 RAG —— 闭环的最后一公里](#第四关联网兜底-rag--闭环的最后一公里)
- [附录：环境准备与运行指南](#附录环境准备与运行指南)

---

## 教程总览：我们到底要学什么？

### 一句话总结

本教程教你用 LangGraph 构建一个 **能自主决策** 的 RAG 系统——它不再机械地「检索→生成」，而是会 **判断问题类型、拆解复杂问题、多轮检索、评估充分性、联网补充**，像一个真正的研究员一样工作。

### 4 个文件的演进关系

```
第一关                第二关                第三关                第四关
naive-rag.mjs   →   rag-query-router  →  rag-multihop.mjs  →  rag-webfallback.mjs
(流水线)              (有判断力)            (会拆问题)            (能兜底)

检索→生成             先判断再检索          拆子问题→多轮检索      评估→联网补充→再评估
2个节点,0个决策        4个节点,1个决策       6个节点,2个决策       6个节点,2个决策
```

每一步只增加 **一个核心能力**，你可以清楚地看到系统如何从「工具」变成「Agent」。

### 学习路径建议

| 阶段     | 建议用时 | 核心收获                           |
| -------- | -------- | ---------------------------------- |
| 前置知识 | 30 分钟  | 理解 LangGraph 状态图 + RAG 流程   |
| 第一关   | 45 分钟  | 跑通最简 RAG，理解 StateGraph 基础 |
| 第二关   | 60 分钟  | 掌握条件边 + 结构化输出做路由      |
| 第三关   | 90 分钟  | 掌握循环图 + 多轮检索 + 自主规划   |
| 第四关   | 60 分钟  | 掌握评估闭环 + 外部工具集成        |

---

## 前置知识：4 个你必须先理解的概念

### 概念 1：RAG 是什么？

**RAG = Retrieval-Augmented Generation（检索增强生成）**

不用 RAG 时，LLM 直接回答问题，容易 **编造事实（幻觉）**。

用 RAG 时：

```
用户提问 → 先从知识库检索相关文档 → 把文档塞给 LLM 作为参考 → LLM 基于参考回答
```

> 类比：开卷考试 vs 闭卷考试。RAG 就是让 AI「开卷」，有了参考书，回答就靠谱多了。

### 概念 2：LangGraph 的 StateGraph 是什么？

LangGraph 用 **状态图（StateGraph）** 来编排工作流，核心思路：

1. **定义状态（State）**：一张「共享白板」，所有节点都能读写
2. **定义节点（Node）**：每个节点是一个异步函数，读取状态、处理后返回更新
3. **定义边（Edge）**：决定节点之间的流转顺序
   - 普通边 `addEdge`：A 执行完必定去 B
   - 条件边 `addConditionalEdges`：A 执行完根据条件去 B 或 C

```javascript
// 最简状态图示例
const graph = new StateGraph(MyState)
  .addNode("A", nodeA) // 定义节点
  .addNode("B", nodeB)
  .addEdge(START, "A") // 入口 → A
  .addEdge("A", "B") // A → B
  .addEdge("B", END) // B → 结束
  .compile(); // 编译成可执行的图
```

> 类比：状态图 = 流程图。节点 = 处理步骤，边 = 箭头连线，状态 = 每一步之间传递的数据表。

### 概念 3：Annotation.Root 是什么？

`Annotation.Root({...})` 是 LangGraph 定义状态的方式。每个字段就是一个「白板上的格子」：

```javascript
const GraphState = Annotation.Root({
  question: Annotation, // 用户问题
  documents: Annotation, // 检索到的文档
  generation: Annotation, // 生成的回答
});
```

**关键规则**：节点函数返回的对象会 **合并** 到状态上，而不是替换。比如节点返回 `{ documents: [...] }`，只有 `documents` 会被更新，其他字段不变。

### 概念 4：条件边 —— 自主决策的核心

条件边是让系统「会判断」的关键：

```javascript
// 根据状态中的 strategy 字段决定走哪条路
graph.addConditionalEdges("route_question", decideNext, {
  direct_answer: "direct_answer", // strategy === "simple" 走这条路
  retrieve: "retrieve", // strategy === "complex" 走这条路
});

function decideNext(state) {
  return state.strategy === "simple" ? "direct_answer" : "retrieve";
}
```

> 这就是「自主决策」的本质：**让 LLM 判断当前情况，通过条件边选择不同的执行路径。**

---

## 第一关：朴素 RAG —— 最简单的检索问答

### 对应文件

`naive-rag.mjs`

### 流程图

```
START → retrieve → generate → END
```

就这么简单：**检索** → **生成**，一条直线，没有任何判断。

### 核心代码解读

#### 1. 定义状态（4 个字段）

```javascript
const GraphState = Annotation.Root({
  question: Annotation, // 用户问题
  k: Annotation, // 检索 top-k
  documents: Annotation, // 检索到的文档列表
  generation: Annotation, // LLM 生成的回答
});
```

#### 2. 检索节点（retrieve）

```javascript
const retrieveNode = async (state) => {
  const documents = await retrieveRelevantContent(state.question, state.k);
  return { documents }; // 返回检索结果，自动合并到状态
};
```

#### 3. 生成节点（generate）

```javascript
const generateNode = async (state) => {
  // 把检索到的文档拼成上下文
  const context = state.documents
    .map((item, i) => `[片段 ${i + 1}]\n章节: 第 ${item.chapter_num} 章\n内容: ${item.content}`)
    .join("\n\n━━━━━\n\n");

  // 构造 Prompt + 流式输出
  let generation = "";
  const stream = await model.stream(prompt);
  for await (const chunk of stream) { ... }
  return { generation };
};
```

#### 4. 构建图

```javascript
const graph = new StateGraph(GraphState)
  .addNode("retrieve", retrieveNode)
  .addNode("generate", generateNode)
  .addEdge(START, "retrieve")
  .addEdge("retrieve", "generate")
  .addEdge("generate", END)
  .compile();
```

### 朴素 RAG 的问题

| 问题                     | 例子                                                 |
| ------------------------ | ---------------------------------------------------- |
| **不管什么问题都检索**   | 问"1+1等于几"也要去 Milvus 搜一遍，浪费资源          |
| **检索结果可能不相关**   | 问"阿朱结局"却搜到"乔峰武功"，LLM 只能硬编           |
| **复杂问题一次检索不够** | 问"雁门关主谋的儿子结局"需要两步推理，一次检索搞不定 |

---

## 第二关：查询路由 RAG —— 让系统学会判断

### 对应文件

`rag-query-router.mjs`

### 流程图

```
                    ┌─ simple ─→ direct_answer ─→ END
START → route_question ─┤
                    └─ complex ─→ retrieve → rag_generate ─→ END
```

### 新增知识：结构化输出做路由

用 `withStructuredOutput` 让 LLM 返回结构化数据：

```javascript
const RouteSchema = z.object({
  strategy: z.enum(["simple", "complex"]),
  reason: z.string(),
});

const router = llm.withStructuredOutput(RouteSchema);
const route = await router.invoke(`你是问答路由器...`);
// route = { strategy: "simple", reason: "..." } 类型安全！
```

**为什么不用正则解析自由文本？** `withStructuredOutput` 底层注入 JSON Schema 约束，zod 强制校验，比正则可靠得多。

### 核心代码

#### 路由节点 + 条件边

```javascript
const routeQuestionNode = async (state) => {
  const router = llm.withStructuredOutput(RouteSchema);
  const route = await router.invoke(`你是问答路由器...`);
  return { strategy: route.strategy, routeReason: route.reason };
};

function decideNext(state) {
  return state.strategy === "simple" ? "direct_answer" : "retrieve";
}

graph.addConditionalEdges("route_question", decideNext, {
  direct_answer: "direct_answer",
  retrieve: "retrieve",
});
```

---

## 第三关：多跳 RAG —— 让系统学会拆解问题

### 对应文件

`rag-multihop.mjs`

### 流程图

```
                    ┌─ simple ─→ direct_answer ─→ END
START → route_question ─┤
                    └─ complex ─→ decompose_question → retrieve ⇄ plan_next_step
                                                        ↓ (generate)
                                                      generate ─→ END
```

### 什么是「多跳」问题？

| 问题类型 | 例子                                           | 需要几跳                                    |
| -------- | ---------------------------------------------- | ------------------------------------------- |
| 单跳     | "阿朱的结局是什么？"                           | 1 次检索即可                                |
| 两跳     | "雁门关主谋的儿子结局如何？"                   | 先查"雁门关主谋是谁" → 再查"此人之子的结局" |
| 三跳+    | "四大恶人老二的儿子，其生父的公开身份是什么？" | 层层递进                                    |

### 新增知识 1：问题拆解（Decompose）

```javascript
const DecomposeSchema = z.object({
  sub_questions: z.array(z.string()).min(1).max(8),
  reason: z.string(),
});
```

**禁止代词**：拆出"他是谁"向量检索无法理解，必须写成"叶二娘的儿子是谁"。

### 新增知识 2：多轮检索 + 去重合并

```javascript
const retrieveNode = async (state) => {
  const q = state.subQuestions[state.nextSubIdx]; // 取当前子问题
  const newDocs = await retrieveRelevantContent(q, state.k);
  const merged = mergeUnique(state.documents, newDocs); // 去重合并
  return {
    documents: merged,
    retrievalCount: state.retrievalCount + 1,
    nextSubIdx: state.nextSubIdx + 1,
  };
};
```

### 新增知识 3：自主规划 + 安全兜底

```javascript
// LLM 建议 + 代码硬性兜底
let finalNext = nextAction;
if (state.retrievalCount >= state.maxRetrievals) finalNext = "generate";
if (remaining <= 0) finalNext = "generate";
```

### 循环图：条件边形成环

```javascript
graph
  .addEdge("decompose_question", "retrieve")
  .addEdge("retrieve", "plan_next_step")
  .addConditionalEdges("plan_next_step", afterPlan, {
    retrieve: "retrieve", // 回到 retrieve，形成循环！
    generate: "generate",
  });
```

---

## 第四关：联网兜底 RAG —— 闭环的最后一公里

### 对应文件

`rag-webfallback.mjs`

### 流程图

```
                    ┌─ simple ─→ direct_answer ─→ END
START → route_question ─┤
                    └─ complex ─→ local_retrieve → evaluate_local ⇄ web_search
                                                          ↓ (enough)
                                                        generate ─→ END
```

### 什么是「闭环」？

```
本地检索 → 评估(不够) → 联网搜索 → 再评估(够了) → 生成
         ↘ 评估(够了) → 生成
```

### 新增知识 1：充分性评估

```javascript
const EvaluateSchema = z.object({
  enough: z.boolean(), // 信息是否充分
  missing: z.array(z.string()).max(6), // 缺失哪些信息点
  reason: z.string(), // 评估理由
  web_query: z.string().optional(), // 建议的联网搜索查询
});
```

### 新增知识 2：二次评估闭环

```javascript
function afterEvaluateLocal(state) {
  if (state.webContext?.trim()) return "generate"; // 已联网过，强制生成
  const parsed = JSON.parse(state.evaluation || "{}");
  return parsed.enough === true ? "generate" : "web_search";
}

graph.addEdge("web_search", "evaluate_local"); // 联网后回到评估
```

### 本关 vs 第三关的设计取舍

| 维度           | 第三关（多跳）              | 第四关（联网兜底）    |
| -------------- | --------------------------- | --------------------- |
| 解决的问题     | 复杂问题需要多步推理        | 本地知识库信息不足    |
| 补充信息的方式 | 多轮本地检索                | 联网搜索              |
| 循环方式       | retrieve ⇄ plan_next_step   | evaluate ⇄ web_search |
| 终止条件       | 子问题检索完 / 达到轮数上限 | 信息充分 / 已联网过   |

---

## 附录：环境准备与运行指南

### 1. 依赖安装

```bash
pnpm add @langchain/openai @langchain/langgraph @langchain/community zod dotenv
```

### 2. 环境变量配置

在项目根目录 `.env` 文件中添加：

```env
# 大模型 API
OPENAI_API_KEY=your-api-key
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1

# 联网搜索 API（仅第四关需要）
BOCHA_API_KEY=your-bocha-api-key
```

### 3. Milvus 向量数据库

```bash
docker compose -f milvus-standalone-docker-compose.yml up -d
```

确保 `localhost:19530` 可连接，`ebook_collection` 集合存在。

### 4. 运行方式

```bash
node src/advanced-rag/naive-rag.mjs          # 第一关
node src/advanced-rag/rag-query-router.mjs    # 第二关
node src/advanced-rag/rag-multihop.mjs        # 第三关
node src/advanced-rag/rag-webfallback.mjs     # 第四关
```

---

## 知识点速查表

| 关卡   | 核心技术              | LangGraph API                   | zod Schema                          |
| ------ | --------------------- | ------------------------------- | ----------------------------------- |
| 第一关 | 基础 RAG 流水线       | `addNode`, `addEdge`, `compile` | 无                                  |
| 第二关 | 条件路由              | `addConditionalEdges`           | `RouteSchema`                       |
| 第三关 | 多跳检索 + 自主规划   | 循环条件边                      | `DecomposeSchema`, `NextStepSchema` |
| 第四关 | 充分性评估 + 联网兜底 | 闭环条件边                      | `EvaluateSchema`                    |

## 核心设计原则总结

1. **渐进增强**：每一步只加一个能力，状态字段同步扩展
2. **LLM 做决策，代码做兜底**：让 LLM 判断走哪条路，但硬性规则兜底防止死循环
3. **结构化输出 > 自由文本**：用 `withStructuredOutput` + zod 保证 LLM 输出可靠
4. **状态是记忆**：状态字段越多，系统能做的决策越精细
5. **闭环思维**：检索 → 评估 → 补充 → 再评估，直到充分为止
