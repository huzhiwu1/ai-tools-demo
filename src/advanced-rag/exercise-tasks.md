# Advanced RAG 渐进式学习任务书

> 每个任务都产出可运行代码，后一个任务的动机来自前一个任务暴露的问题。完成一个提交审查，通过后进入下一个。

---

## 任务总览

每个任务在前一个的基础上增量开发，最终得到完整的 RAG 闭环系统：

```
Task 1          Task 2              Task 3                  Task 4
朴素RAG    →   加质量评估      →   加查询路由         →   加多跳检索        →   加联网兜底
(检索→生成)    (检索→生成→评估)    (简单问题不走检索)      (复杂问题拆解多轮)    (本地不够就联网)
发现问题：    发现问题：          发现问题：              发现问题：
回答可能瞎编  简单问题也检索浪费  复杂问题一次检索不够    本地知识库信息不全
```

| 任务   | 产出文件          | 新增能力            | 难度       |
| ------ | ----------------- | ------------------- | ---------- |
| Task 1 | `exercise-01.mjs` | 质量评估节点        | ⭐⭐       |
| Task 2 | `exercise-02.mjs` | 查询路由            | ⭐⭐⭐     |
| Task 3 | `exercise-03.mjs` | 问题拆解 + 多轮检索 | ⭐⭐⭐⭐   |
| Task 4 | `exercise-04.mjs` | 评估 + 联网兜底闭环 | ⭐⭐⭐⭐⭐ |

---

## Task 1：给朴素 RAG 加上「回答质量评估」

### 为什么做这个

`naive-rag.mjs` 检索完就直接生成回答，但回答可能：

- 检索到不相关的文档，LLM 却强行编了一个回答
- 完全没检索到任何内容，LLM 还在瞎答

你需要加一个 `grade` 节点，让 LLM 自己检查：**我的回答有没有依据？**

### 需要做的事

1. 复制 `naive-rag.mjs` 为 `exercise-01.mjs`
2. 状态新增 `gradeResult` 字段（存储评估结果）
3. 新增 `grade` 节点：
   - 用 `zod` 定义 `GradeSchema`：`{ passed: boolean, reason: string }`
   - 用 `withStructuredOutput` 让 LLM 评估回答质量
   - Prompt 中同时给出「检索到的文档」和「生成的回答」，让 LLM 判断回答是否有据可依
4. 修改图的边：`generate → grade → END`（原来是 `generate → END`）
5. 在 main 函数最后打印评估结果

### 预期流程图

```
START → retrieve → generate → grade → END
                               ↑
                     检查回答是否基于检索文档
```

### 预期输出示例

```
【AI 回答（流式）】
阿朱在小镜门被乔峰误杀...

【回答质量评估】
通过: true
理由: 回答基于检索到的第3、5片段内容，准确引用了小说原文
```

### 关键代码参考

```javascript
// 1. 定义 Schema
import { z } from "zod";

const GradeSchema = z.object({
  passed: z.boolean().describe("回答是否基于检索文档且有据可依"),
  reason: z.string().describe("评估理由，说明通过或不通过的原因"),
});

// 2. grade 节点
const gradeNode = async (state) => {
  const grader = model.withStructuredOutput(GradeSchema);
  const result = await grader.invoke(`...评估 Prompt...`);
  console.log(`\n【回答质量评估】`);
  console.log(`通过: ${result.passed}`);
  console.log(`理由: ${result.reason}`);
  return { gradeResult: JSON.stringify(result) };
};

// 3. 修改图的边
const graph = new StateGraph(GraphState)
  .addNode("retrieve", retrieveNode)
  .addNode("generate", generateNode)
  .addNode("grade", gradeNode) // 新增节点
  .addEdge(START, "retrieve")
  .addEdge("retrieve", "generate")
  .addEdge("generate", "grade") // 改：generate → grade
  .addEdge("grade", END) // 改：grade → END
  .compile();
```

### 提交方式

创建 `exercise-01.mjs` 文件到 `src/advanced-rag/` 目录，完成后告诉我

### 审查标准

- `GradeSchema` 的字段有 `.describe()`
- `grade` 节点的 Prompt 同时包含检索文档和生成回答
- 图的边连接正确：`generate → grade → END`
- 运行时能看到评估结果输出

---

## Task 2：加上「查询路由」—— 简单问题不走检索

### 为什么做这个

Task 1 加了评估后，你会发现一个问题：**问「1+1等于几」也会走 Milvus 检索，浪费资源且评估多半也能通过**。

很多问题根本不需要检索，LLM 自己就能答。你需要加一个「路由器」，先判断问题类型再决定走哪条路。

### 需要做的事

1. 复制 `exercise-01.mjs` 为 `exercise-02.mjs`
2. 状态新增 `strategy` 和 `routeReason` 字段
3. 新增 `route_question` 节点：
   - 用 `withStructuredOutput` + zod 让 LLM 判断 simple / complex
   - `RouteSchema`：`{ strategy: z.enum(["simple", "complex"]), reason: z.string() }`
4. 新增 `direct_answer` 节点（简单问题直接让 LLM 回答，不走检索）
5. 新增条件边：根据 `strategy` 分流
6. 保留 Task 1 的 `grade` 节点（两条路最终都要过评估）

### 预期流程图

```
                    ┌─ simple ─→ direct_answer ─→ grade ─→ END
START → route_question ─┤
                    └─ complex ─→ retrieve → generate → grade → END
```

### 关键代码参考

```javascript
// 路由节点
const routeQuestionNode = async (state) => {
  const router = llm.withStructuredOutput(RouteSchema);
  const route = await router.invoke(`你是问答路由器...`);
  return { strategy: route.strategy, routeReason: route.reason };
};

// 条件边
function decideRoute(state) {
  return state.strategy === "simple" ? "direct_answer" : "retrieve";
}

// 图
graph
  .addNode("route_question", routeQuestionNode)
  .addNode("direct_answer", directAnswerNode)
  .addEdge(START, "route_question")
  .addConditionalEdges("route_question", decideRoute, {
    direct_answer: "direct_answer",
    retrieve: "retrieve",
  })
  .addEdge("direct_answer", "grade") // 简单问题也要过评估
  .addEdge("retrieve", "generate")
  .addEdge("generate", "grade") // 复杂问题也过评估
  .addEdge("grade", END);
```

### 提交方式

创建 `exercise-02.mjs` 文件，完成后告诉我

### 审查标准

- `RouteSchema` 正确定义，字段有 `.describe()`
- 条件边正确分流 simple 和 complex
- 两条路径最终都经过 `grade` 节点
- 用「1+1等于几」测试，观察是否走了 `direct_answer`
- 用「阿朱的结局」测试，观察是否走了 `retrieve`

---

## Task 3：加上「问题拆解 + 多轮检索」

### 为什么做这个

Task 2 加了路由后，你会发现：**复杂问题一次检索可能不够**。

比如「雁门关主谋的儿子结局如何？」需要先查「雁门关主谋是谁」→ 再查「此人之子的结局」，一次检索搞不定。

你需要让系统自动拆解多跳问题，然后逐个子问题检索。

### 需要做的事

1. 复制 `exercise-02.mjs` 为 `exercise-03.mjs`
2. 状态新增：`subQuestions`、`nextSubIdx`、`retrievalCount`、`maxRetrievals`、`plannedNext`
3. 新增 `decompose_question` 节点（用 `withStructuredOutput` 拆子问题）
4. 修改 `retrieve` 节点（按 `nextSubIdx` 取当前子问题检索，检索完下标 +1）
5. 新增 `plan_next_step` 节点（让 LLM 决定继续检索还是生成）
6. 新增 `mergeUnique` 辅助函数（去重合并检索结果）
7. 修改条件边：
   - `route_question` 的 complex 分支指向 `decompose_question`（而非直接 `retrieve`）
   - `plan_next_step` 的条件边形成循环：`retrieve ⇄ plan_next_step`
8. 硬性兜底：`retrievalCount >= maxRetrievals` 时强制走 `generate`

### 预期流程图

```
                    ┌─ simple → direct_answer → grade → END
START → route_question ─┤
                    └─ complex → decompose_question → retrieve ⇄ plan_next_step
                                                                ↓ (generate)
                                                          generate → grade → END
```

### 关键代码参考

```javascript
// 拆解 Schema
const DecomposeSchema = z.object({
  sub_questions: z
    .array(z.string())
    .min(1)
    .max(8)
    .describe("有序子问题列表，每条必须是可独立检索的完整问句，禁止代词"),
  reason: z.string().describe("拆解理由"),
});

// 规划 Schema
const NextStepSchema = z.object({
  nextAction: z.enum(["retrieve", "generate"]).describe("下一步动作"),
  reason: z.string().describe("决策理由"),
});

// 循环条件边
graph
  .addEdge("decompose_question", "retrieve")
  .addEdge("retrieve", "plan_next_step")
  .addConditionalEdges("plan_next_step", afterPlan, {
    retrieve: "retrieve", // 回到 retrieve，形成循环
    generate: "generate",
  });

// 兜底逻辑
function afterPlan(state) {
  const remaining = state.subQuestions.length - state.nextSubIdx;
  if (state.retrievalCount >= state.maxRetrievals) return "generate";
  if (remaining <= 0) return "generate";
  return state.plannedNext === "retrieve" ? "retrieve" : "generate";
}
```

### 提交方式

创建 `exercise-03.mjs` 文件，完成后告诉我

### 审查标准

- `DecomposeSchema` 和 `NextStepSchema` 字段有 `.describe()`
- `decompose_question` 节点输出子问题列表和下标
- `retrieve` 节点按 `nextSubIdx` 取当前子问题
- `mergeUnique` 去重合并逻辑正确
- 条件边形成 `retrieve ⇄ plan_next_step` 循环
- 硬性兜底存在：`maxRetrievals` 上限

---

## Task 4：加上「评估 + 联网兜底」闭环

### 为什么做这个

Task 3 的多跳检索只能查本地知识库。如果用户问「《天龙八部》2013版电视剧中雁门关事件出现在哪几集」，本地小说文本根本找不到答案。

你需要加一个评估环节：检索完后先评估信息是否充分，不够就联网搜索补充，搜完再评估。

### 需要做的事

1. 复制 `exercise-03.mjs` 为 `exercise-04.mjs`
2. 状态新增：`localContext`、`webContext`、`evaluation`
3. 新增 `evaluate` 节点（用 `withStructuredOutput` 评估信息充分性）
   - `EvaluateSchema`：`{ enough: boolean, missing: string[], reason: string, web_query?: string }`
4. 新增 `web_search` 节点（调用 Bocha API 联网搜索）
5. 修改流程：`plan_next_step` 的 generate 分支指向 `evaluate`（而非直接 `generate`）
6. 新增条件边：
   - `evaluate → enough=true → generate`
   - `evaluate → enough=false → web_search → evaluate`（二次评估闭环）
7. 防止无限联网：如果 `webContext` 已有内容，二次评估后强制走 `generate`

### 预期流程图

```
                    ┌─ simple → direct_answer → grade → END
START → route_question ─┤
                    └─ complex → decompose → retrieve ⇄ plan_next_step
                                                              ↓
                                                       evaluate ⇄ web_search
                                                         ↓ (enough)
                                                      generate → grade → END
```

### 关键代码参考

```javascript
// 评估 Schema
const EvaluateSchema = z.object({
  enough: z.boolean().describe("当前上下文信息是否足以回答用户问题"),
  missing: z.array(z.string()).max(6).describe("缺失的信息点列表"),
  reason: z.string().describe("评估理由"),
  web_query: z.string().optional().describe("建议的联网搜索查询词"),
});

// 闭环条件边
function afterEvaluate(state) {
  if (state.webContext?.trim()) return "generate"; // 已联网过，强制生成
  const parsed = JSON.parse(state.evaluation || "{}");
  return parsed.enough ? "generate" : "web_search";
}

// 图
graph
  .addEdge("local_retrieve", "evaluate")
  .addConditionalEdges("evaluate", afterEvaluate, {
    generate: "generate",
    web_search: "web_search",
  })
  .addEdge("web_search", "evaluate"); // 联网后回到评估
```

### 提交方式

创建 `exercise-04.mjs` 文件，完成后告诉我

### 审查标准

- `EvaluateSchema` 字段有 `.describe()`
- `evaluate` 节点区分首次评估和二次评估（检查 `webContext`）
- `plan_next_step` 的 generate 分支指向 `evaluate` 而非直接 `generate`
- 闭环正确：`evaluate ⇄ web_search`，且不会无限联网
- 联网搜索的 API 调用有错误处理

---

## 完成标志

全部 4 个任务通过审查后，你将拥有：

1. 一个 **可运行的 RAG 闭环系统**（exercise-04.mjs），具备：
   - 查询路由（简单问题直接答，复杂问题走检索）
   - 多跳检索（复杂问题自动拆解、逐个子问题检索）
   - 充分性评估（检索后评估信息够不够）
   - 联网兜底（不够就联网搜索补充）
   - 质量把关（最终回答通过评估才输出）
2. 掌握 LangGraph 的核心 API：`addNode`、`addEdge`、`addConditionalEdges`、`compile`
3. 掌握 `withStructuredOutput` + zod 实现 LLM 自主决策
4. 掌握循环图设计和 Agent 安全兜底原则
