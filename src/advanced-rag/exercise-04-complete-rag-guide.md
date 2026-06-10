# 完整 RAG 闭环系统：从代码到设计

> 基于 `exercise-04.mjs` 的完整代码解读，覆盖架构设计、数据流转、关键决策和常见陷阱

---

## 一、系统总览：从工具到 Agent

### 最终流程图

```
                    ┌─ simple → directAnswer ─→ grade ─→ END
START → route ──────┤
                    └─ complex → decomposeQuestion → retrieve ⇄ planNext
                                                                ↓ (generate)
                                                           evaluate ⇄ webSearch
                                                              ↓ (enough)
                                                          generate ─→ grade ─→ END
```

### 演进对比

| 阶段   | 流程                                                                              | 节点数 | 决策数 | 核心能力     |
| ------ | --------------------------------------------------------------------------------- | ------ | ------ | ------------ |
| Task 1 | retrieve → generate → grade                                                       | 3      | 0      | 质量评估     |
| Task 2 | route → directAnswer / retrieve → generate → grade                                | 5      | 1      | 查询路由     |
| Task 3 | route → decompose → retrieve ⇄ planNext → generate → grade                        | 7      | 2      | 多跳检索     |
| Task 4 | route → decompose → retrieve ⇄ planNext → evaluate ⇄ webSearch → generate → grade | 9      | 3      | 联网兜底闭环 |

### 9 个节点一览

| 节点                | 职责                 | LLM 决策？         | 关键输入                     | 关键输出                   |
| ------------------- | -------------------- | ------------------ | ---------------------------- | -------------------------- |
| `route`             | 判断问题类型         | ✅ RouteSchema     | question                     | strategy, routeReason      |
| `directAnswer`      | 直接回答简单问题     | ❌                 | question                     | generation                 |
| `decomposeQuestion` | 拆解多跳子问题       | ✅ DecomposeSchema | question                     | subQuestions, nextSubIdx   |
| `retrieve`          | 按子问题检索 Milvus  | ❌                 | subQuestions[nextSubIdx]     | localContext, nextSubIdx+1 |
| `planNext`          | 决定继续检索还是评估 | ✅ PlanNextSchema  | subQuestions, retrievalCount | nextAction                 |
| `evaluate`          | 评估信息充分性       | ✅ EvaluateSchema  | localContext, webContext     | evaluation                 |
| `webSearch`         | 联网搜索补充信息     | ❌                 | evaluation.webQuery          | webContext                 |
| `generate`          | 基于上下文生成回答   | ❌                 | localContext, webContext     | generation                 |
| `grade`             | 评估回答质量         | ✅ GradeSchema     | generation, localContext     | gradeResult                |

---

## 二、状态设计：GraphState 字段全解

```javascript
const GraphState = Annotation.Root({
  question: Annotation, // 用户原始问题
  k: Annotation, // 检索 top-k 数量
  generation: Annotation, // LLM 生成的回答
  gradeResult: Annotation, // grade 节点评估结果
  strategy: Annotation, // 路由策略：simple / complex
  routeReason: Annotation, // 路由判断理由
  subQuestions: Annotation, // 拆解后的子问题列表
  retrievalCount: Annotation, // 已检索轮数
  nextSubIdx: Annotation, // 下一个要检索的子问题下标
  maxRetrievals: Annotation, // 最大检索轮数上限（防死循环）
  nextAction: Annotation, // planNext 的决策结果
  localContext: Annotation, // 本地检索结果（文档数组）
  webContext: Annotation, // 联网搜索结果（字符串）
  evaluation: Annotation, // evaluate 的评估结果（JSON 字符串）
});
```

### 字段分类

| 类别 | 字段                                                    | 说明                                      |
| ---- | ------------------------------------------------------- | ----------------------------------------- |
| 输入 | question, k                                             | 用户传入，整个流程不变                    |
| 路由 | strategy, routeReason                                   | route 节点写入，决定分流                  |
| 拆解 | subQuestions, nextSubIdx, retrievalCount, maxRetrievals | decompose 初始化，retrieve 递增           |
| 规划 | nextAction                                              | planNext 写入，决定循环走向               |
| 检索 | localContext                                            | retrieve 累积（mergeUnique 去重）         |
| 评估 | evaluation                                              | evaluate 写入，afterEvaluate 读取         |
| 联网 | webContext                                              | webSearch 写入，evaluate 和 generate 读取 |
| 生成 | generation                                              | generate 或 directAnswer 写入             |
| 质检 | gradeResult                                             | grade 写入                                |

---

## 三、关键代码逐层拆解

### 3.1 条件边：系统自主决策的「大脑」

```javascript
// 路由分流
function afterRoute(state) {
  return state.strategy === "simple" ? "directAnswer" : "decomposeQuestion";
}

// 多跳循环
function afterPlanNext(state) {
  return state.nextAction === "retrieve" ? "retrieve" : "generate";
}

// 评估闭环
function afterEvaluate(state) {
  const parsed = JSON.parse(state.evaluation || "{}");
  if (parsed.enough === true) return "generate";
  if (parsed.missing) return "webSearch";
  return "webSearch";
}
```

**三条条件边分别控制三个关键决策点**：

| 条件边        | 决策             | 选项                                      |
| ------------- | ---------------- | ----------------------------------------- |
| afterRoute    | 问题要不要检索？ | simple → 直接答 / complex → 拆解检索      |
| afterPlanNext | 还要继续检索吗？ | retrieve → 再搜一轮 / generate → 进入评估 |
| afterEvaluate | 信息够不够？     | generate → 生成 / webSearch → 联网补充    |

### 3.2 retrieve 节点：按子问题索引检索 + 去重合并

```javascript
async function retrieveNode(state) {
  const { nextSubIdx, retrievalCount, subQuestions, localContext } = state;
  const question = subQuestions[nextSubIdx]; // 取当前子问题

  const newDocuments = await retrieveRelevantContent(question, state.k);
  const mergedDocuments = mergeUnique(localContext, newDocuments); // 去重合并

  return {
    nextSubIdx: nextSubIdx + 1, // 下标前进
    retrievalCount: retrievalCount + 1, // 计数+1
    localContext: mergedDocuments, // 累积合并后的文档
  };
}
```

**数据流转**：

```
子问题1 → retrieveRelevantContent → [doc1, doc2]
                                      ↓ mergeUnique
子问题2 → retrieveRelevantContent → [doc3, doc4]
                                      ↓ mergeUnique
localContext = [doc1, doc2, doc3, doc4]  （去重 + 按 score 排序）
```

### 3.3 mergeUnique：按 id 去重，同 id 保留更高 score

```javascript
function mergeUnique(existingDocs, newDocs) {
  const map = new Map();
  for (const doc of [...existingDocs, ...newDocs]) {
    const key = String(doc.id);
    const pre = map.get(key);
    if (!pre || Number(doc.score) > Number(pre.score)) {
      map.set(key, doc); // 同 id 只保留 score 更高的
    }
  }
  return Array.from(map.values()).sort(
    (a, b) => Number(b.score) - Number(a.score), // 按 score 降序
  );
}
```

**为什么需要去重**：不同子问题可能检索到同一篇文档，不去重会导致重复上下文浪费 token。

### 3.4 evaluate 节点：信息充分性评估

```javascript
const evaluateNode = async (state) => {
  const hasWeb = Boolean(state.webContext?.trim()); // 是否已联网
  const evaluator = model.withStructuredOutput(EvaluateSchema);

  const out = await evaluator.invoke(
    `你是信息充分性评估器...
    ${hasWeb ? `联网搜索结果：\n${state.webContext}\n` : ""}
    ...
    ${hasWeb ? "" : "- web_query: 若不够，给出联网搜索查询句"}`,
  );

  return { evaluation: JSON.stringify(out) };
};
```

**区分首次评估和二次评估**：

| 场景     | hasWeb | Prompt 行为                                      |
| -------- | ------ | ------------------------------------------------ |
| 首次评估 | false  | 只看 localContext，缺失则要求 web_query          |
| 二次评估 | true   | 看 localContext + webContext，不再要求 web_query |

### 3.5 webSearch 节点：调用 Bocha API

```javascript
async function webSearchNode(state) {
  const parsed = JSON.parse(state.evaluation || "{}");
  const result = await bochaWebSearch(parsed?.webQuery); // 用评估建议的查询词
  return { webContext: result };
}
```

**闭环逻辑**：webSearch → evaluate → 如果仍不够... 但已联网过 → 强制 generate

### 3.6 generate 节点：合并本地 + 联网上下文

```javascript
const generateNode = async (state) => {
  const { question, localContext, webContext } = state;

  // 拼接本地检索片段
  let context = localContext
    .map((item, i) => `【本地检索片段${i + 1}】...`)
    .join("\n\n--------\n\n");

  // 如果有联网结果，追加
  if (webContext) {
    context += `\n\n--------\n\n【web检索片段】: ${webContext}`;
  }

  // 流式生成...
};
```

---

## 四、五张 Schema：LLM 自主决策的「契约」

| Schema          | 用在哪个节点      | 核心字段                          | LLM 的任务   |
| --------------- | ----------------- | --------------------------------- | ------------ |
| RouteSchema     | route             | strategy, reason                  | 判断问题类型 |
| DecomposeSchema | decomposeQuestion | subQuestions, reason              | 拆解子问题   |
| PlanNextSchema  | planNext          | nextAction, reason                | 规划下一步   |
| EvaluateSchema  | evaluate          | enough, missing, reason, webQuery | 评估充分性   |
| GradeSchema     | grade             | passed, reason                    | 评估回答质量 |

### Schema 设计原则

1. **每个字段必须有 `.describe()`**：LLM 通过描述理解字段含义，没有描述的字段 LLM 会瞎填
2. **用 `z.enum()` 约束选项**：如 `strategy: z.enum(["simple", "complex"])`，避免 LLM 输出意外值
3. **用 `z.array().max()` 限制数组长度**：如 `missing: z.array(z.string()).max(6)`，防止 LLM 输出过长列表
4. **可选字段用 `.optional()`**：如 `webQuery: z.string().optional()`，足够时 LLM 不需要提供搜索词

---

## 五、三个循环与安全兜底

### 循环 1：retrieve ⇄ planNext

```
retrieve → planNext → (retrieve) → retrieve → planNext → ...
                      (generate) → evaluate
```

**兜底机制**：

```javascript
if (retrievalCount >= maxRetrievals) finalNext = "generate"; // 检索轮数上限
if (remaining <= 0) finalNext = "generate"; // 子问题已全部检索
```

### 循环 2：evaluate ⇄ webSearch

```
evaluate → (enough=false) → webSearch → evaluate → (enough=true) → generate
```

**兜底机制**（需注意！当前代码有缺陷，见第六节）：

```javascript
// 应该有但当前缺失：
if (state.webContext?.trim()) return "generate"; // 已联网过，强制生成
```

---

## 六、常见陷阱与修复指南

### 陷阱 1：afterEvaluate 缺少「已联网」检查 → 无限循环

**问题**：当前 `afterEvaluate` 没有检查 `webContext` 是否已有内容。如果 LLM 二次评估仍然认为不够，系统会再次联网搜索，形成无限循环。

**修复**：

```javascript
function afterEvaluate(state) {
  // 关键：已联网过，强制生成（防止无限循环）
  if (state.webContext?.trim()) return "generate";

  const parsed = JSON.parse(state.evaluation || "{}");
  return parsed.enough ? "generate" : "webSearch";
}
```

### 陷阱 2：GraphState 字段值不是 Annotation

```javascript
// ❌ 错误：数字不是 Annotation
maxRetrievals: 10;

// ✅ 正确
maxRetrievals: Annotation;
// 或带默认值
maxRetrievals: Annotation({ default: () => 8 });
```

### 陷阱 3：节点返回未清理的数据

```javascript
// ❌ 错误：返回 LLM 原始输出（可能含空字符串）
return { subQuestions: result.subQuestions };

// ✅ 正确：返回清理后的版本
const subQuestions = result.subQuestions.map((s) => s.trim()).filter(Boolean);
return { subQuestions };
```

### 陷阱 4：decompose 缺少初始值

```javascript
// ❌ 错误：只返回 subQuestions，后续节点依赖的 nextSubIdx 和 retrievalCount 为 undefined
return { subQuestions };

// ✅ 正确：同时返回初始值
return { subQuestions, nextSubIdx: 0, retrievalCount: 0, localContext: [] };
```

### 陷阱 5：空 catch 块吞掉错误

```javascript
// ❌ 错误：静默失败
catch (err) {}

// ✅ 正确
catch (err) { console.error("运行失败:", err); }
```

### 陷阱 6：EvaluateSchema.webQuery 缺少 .optional()

```javascript
// ❌ 错误：足够时 LLM 被迫编一个 webQuery
webQuery: z.string().describe("需要网络查询的问题");

// ✅ 正确：足够时 LLM 可以不填
webQuery: z.string().optional().describe("不足时建议的联网搜索查询词");
```

---

## 七、图结构对比：三个条件边的位置

```
                                    afterRoute          afterPlanNext        afterEvaluate
                                       ↓                    ↓                    ↓
                    ┌─ simple → directAnswer             retrieve             generate
START → route ──────┤                          ↗ retrieve                 ↗ generate
                    └─ complex → decompose ──→ retrieve → planNext ──→ evaluate
                         Question                                    ↓    ↑
                                                                webSearch ┘
```

**三个决策点 = 三次 LLM 判断 = 三个 `addConditionalEdges`**：

1. `afterRoute`：要不要检索？（基于问题类型）
2. `afterPlanNext`：要不要继续检索？（基于检索进度 + 已有文档）
3. `afterEvaluate`：信息够不够？（基于上下文充分性）

---

## 八、Milvus 配置字段速查

| 字段             | 值                | 含义                                   |
| ---------------- | ----------------- | -------------------------------------- |
| `collectionName` | `COLLECTION_NAME` | 集合名（即数据库的「表名」）           |
| `url`            | `localhost:19530` | Milvus Docker 默认地址                 |
| `textField`      | `"content"`       | 原文内容字段，`doc.pageContent` 从此来 |
| `primaryField`   | `"id"`            | 主键字段，用于去重和更新               |
| `vectorField`    | `"vector"`        | 向量存储字段，检索时用此字段算相似度   |
| `metric_type`    | `COSINE`          | 余弦相似度（越大越相似）               |
| `index_type`     | `HNSW`            | 层次可导航小世界图索引                 |
| `M`              | 16                | 每个节点的邻居数                       |
| `efConstruction` | 200               | 建索引时搜索宽度                       |
| `ef`             | 64                | 查询时搜索宽度                         |

---

## 九、运行方式

```bash
# 启动 Milvus
docker compose -f milvus-standalone-docker-compose.yml up -d

# 运行
node src/advanced-rag/exercise-04.mjs
```

### 环境变量

```env
API_KEY=your-api-key
BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MODEL_NAME=qwen-plus
EMBEDDINGS_MODEL_NAME=text-embedding-v3
BOCHA_API_KEY=your-bocha-api-key
```

---

## 十、核心设计原则总结

1. **LLM 做决策，代码做兜底**：每个条件边让 LLM 判断方向，但硬性规则（maxRetrievals、已联网检查）防止死循环
2. **结构化输出 > 自由文本**：`withStructuredOutput` + zod 保证 LLM 输出可靠，比正则解析自由文本强得多
3. **状态是记忆**：状态字段越多，系统能做的决策越精细
4. **闭环思维**：检索 → 评估 → 补充 → 再评估，直到充分为止
5. **节点只返回需要更新的字段**：LangGraph 自动合并，不需要把整个 state 原样返回
6. **渐进增强**：从 Task 1 到 Task 4，每一步只加一个能力，状态字段同步扩展
