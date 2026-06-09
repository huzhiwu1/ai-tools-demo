# naive-rag.mjs 从零实现任务拆分

> 目标：从 0 写出 `naive-rag.mjs`，每一步都能跑通验证。完成后你将理解 RAG + LangGraph 的完整流程。

---

## Step 1：最小骨架——连上 LLM，问一句话

### 你会学到

- 如何用 `ChatOpenAI` 连接大模型
- 环境变量怎么配置
- 最基础的 LLM 调用

### 任务

创建 `naive-rag.mjs`，写入以下代码，确保能跑通：

```javascript
import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";

// 连接大模型（通过环境变量读取配置）
const model = new ChatOpenAI({
  temperature: 0,
  model: process.env.MODEL_NAME,
  configuration: {
    baseURL: process.env.BASE_URL,
  },
  apiKey: process.env.API_KEY,
});

// 调用 LLM，问一句话
const response = await model.invoke("用一句话介绍《天龙八部》");
console.log(response.content);
```

### 验证方式

```bash
node src/advanced-rag/naive-rag.mjs
```

能输出一句关于天龙八部的介绍就说明 LLM 连接成功。

### 需要的环境变量

确认 `.env` 文件中有：

```env
API_KEY=your-api-key
BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MODEL_NAME=qwen-plus
EMBEDDINGS_MODEL_NAME=text-embedding-v3
```

---

## Step 2：加状态定义——理解 Annotation.Root

### 你会学到

- LangGraph 的状态是什么
- `Annotation.Root` 怎么定义状态字段
- 状态是所有节点共享的「白板」

### 任务

在 Step 1 代码的基础上，**在 import 和 model 之间**加入：

```javascript
import { Annotation } from "@langchain/langgraph";
import { COLLECTION_NAME, VECTOR_DIM } from "./constants.mjs";

// 状态：所有节点共享的「白板」
// 每个字段就像白板上的一个格子
// 节点函数 return 的内容会「合并」到状态上（不是替换）
const GraphState = Annotation.Root({
  question: Annotation, // 用户问题
  k: Annotation, // 检索 top-k 数量
  documents: Annotation, // 检索到的文档列表
  generation: Annotation, // LLM 生成的回答
});
```

### 验证方式

这步只是定义，代码还不会用状态。跑一下确保没有语法错误即可。

### 关键理解

- 状态是节点之间传递数据的「共享白板」
- `retrieveNode` 返回 `{ documents: [...] }` → 只有 documents 被更新
- `generateNode` 返回 `{ generation: "..." }` → 只有 generation 被更新
- **不是替换，是合并**

---

## Step 3：加生成节点——让图能调用 LLM 回答

### 你会学到

- 什么是「节点」（一个异步函数）
- 节点怎么读取状态、怎么返回更新
- `StateGraph` 怎么构建和运行
- 流式输出怎么写

### 任务

把 Step 1 的直接调用 `model.invoke` 改造成一个**图节点**：

```javascript
import { END, START, StateGraph } from "@langchain/langgraph";

// 生成节点：读取问题，调用 LLM，返回回答
const generateNode = async (state) => {
  const prompt = `你是一个专业的《天龙八部》小说助手。请回答以下问题：
${state.question}

回答要求：基于你已知的内容回答，如果不确定请说明。`;

  process.stdout.write("\n【AI 回答（流式）】\n");
  let generation = "";
  const stream = await model.stream(prompt);
  for await (const chunk of stream) {
    const text = typeof chunk.content === "string" ? chunk.content : "";
    if (!text) continue;
    generation += text;
    process.stdout.write(text);
  }
  process.stdout.write("\n");

  return { generation }; // 只返回需要更新的字段
};

// 构建最简图：START → generate → END
const graph = new StateGraph(GraphState)
  .addNode("generate", generateNode)
  .addEdge(START, "generate")
  .addEdge("generate", END)
  .compile();

// 运行图
const result = await graph.invoke({
  question: "阿朱的结局是什么？",
  k: 5,
  documents: [],
  generation: "",
});

console.log("\n最终状态中的 generation:", result.generation?.substring(0, 100));
```

### 验证方式

跑一下，能看到流式输出的回答。此时还没有检索，LLM 是纯靠自己的知识回答。

### 关键理解

- `generateNode` 是一个函数，参数 `state` 就是 GraphState 的当前值
- 返回 `{ generation }` 会合并到状态上 → 状态的 generation 被更新
- `graph.invoke({...})` 传入初始状态，返回最终状态
- `addEdge(START, "generate")` → 图的入口连到 generate 节点

---

## Step 4：加 Milvus 检索——连数据库搜文档

### 你会学到

- 向量数据库是什么，怎么连
- `similaritySearchWithScore` 做语义搜索
- Embeddings 怎么把文字变成向量

### 任务

在 Step 3 基础上，加入 Milvus 连接和检索逻辑：

```javascript
import { OpenAIEmbeddings } from "@langchain/openai";
import { Milvus } from "@langchain/community/vectorstores/milvus";

// Embeddings：把文字转成向量（数字数组）
const embeddings = new OpenAIEmbeddings({
  model: process.env.EMBEDDINGS_MODEL_NAME,
  dimensions: VECTOR_DIM,
});

let vectorStore; // 全局变量，main 中初始化

// 检索函数：用问题去 Milvus 搜最相似的 k 条文档
async function retrieveRelevantContent(question, k = 5) {
  try {
    const docsWithScores = await vectorStore.similaritySearchWithScore(
      question,
      k,
    );
    return docsWithScores.map(([doc, score]) => ({
      score, // 相似度分数
      content: doc.pageContent, // 文档内容
      id: doc.metadata?.id ?? "unknown",
      book_id: doc.metadata?.book_id ?? "未知",
      chapter_num: doc.metadata?.chapter_num ?? "未知",
      index: doc.metadata?.index ?? "未知",
    }));
  } catch (error) {
    console.error("检索内容时出错:", error.message);
    return [];
  }
}

// 检索节点：用 state.question 去搜，结果存到 state.documents
const retrieveNode = async (state) => {
  const documents = await retrieveRelevantContent(state.question, state.k);
  return { documents };
};
```

同时在 main 函数中加入 Milvus 连接（在 `graph.invoke` 之前）：

```javascript
console.log("连接到 Milvus...");
vectorStore = await Milvus.fromExistingCollection(embeddings, {
  collectionName: COLLECTION_NAME, // 要连接的 Milvus 集合名（即数据库的「表名」）
  url: "localhost:19530", // Milvus 服务的地址和端口（Docker 默认 19530）
  textField: "content", // 存储原文内容的字段名（检索结果中 doc.pageContent 从这里来）
  primaryField: "id", // 主键字段名（每条文档的唯一标识，用于去重和更新）
  vectorField: "vector", // 向量字段名（存储 embedding 数组的字段，检索时用这个字段算相似度）
  indexCreateOptions: {
    metric_type: "COSINE", // 距离度量方式：COSINE=余弦相似度（-1到1，越大越相似）
    index_type: "HNSW", // 索引类型：HNSW=层次可导航小世界图（适合中小规模，查询快）
    params: { M: 16, efConstruction: 200 }, // 建索引参数：M=每个节点的邻居数(8~64)，efConstruction=建图时搜索宽度(越大越精确但越慢)
    search_params: { ef: 64 }, // 搜索参数：ef=查询时搜索宽度(越大越精确但越慢，应 ≤ efConstruction)
  },
});
vectorStore.indexSearchParams = {
  metric_type: "COSINE",
  params: JSON.stringify({ ef: 64 }),
};
console.log("✓ 已连接\n");

try {
  await vectorStore.client.loadCollection({ collection_name: COLLECTION_NAME });
  console.log(`✓ 集合 ${COLLECTION_NAME} 已加载\n`);
} catch (error) {
  if (!error.message.includes("already loaded")) throw error;
  console.log(`✓ 集合 ${COLLECTION_NAME} 已处于加载状态\n`);
}
```

### 验证方式

单独测试检索函数：

```javascript
// 临时测试代码（之后删掉）
const docs = await retrieveRelevantContent("阿朱的结局", 3);
console.log("检索到", docs.length, "条文档");
docs.forEach((d, i) =>
  console.log(
    `[${i + 1}] score=${d.score} 内容=${d.content.substring(0, 80)}...`,
  ),
);
```

能看到检索到文档和相似度分数就说明 Milvus 连接成功。

### 关键理解

- `similaritySearchWithScore` 返回 `[[doc, score], ...]`，score 是相似度
- `fromExistingCollection` 连接已有集合，不需要重新写入数据
- `loadCollection` 让集合从磁盘加载到内存，才能搜索
- 前提：Milvus 服务在跑（`docker compose up -d`），且 `ebook` 集合已有数据

---

## Step 5：组装完整图——检索→生成流水线

### 你会学到

- 怎么把两个节点串成流水线
- `retrieve` 的输出怎么变成 `generate` 的输入
- 状态在节点间自动流转

### 任务

修改 Step 4 的图构建代码，加入 `retrieve` 节点：

```javascript
// 修改 generateNode：使用检索到的文档作为上下文
const generateNode = async (state) => {
  // 把检索到的文档拼成上下文
  const context = state.documents
    .map(
      (item, i) =>
        `[片段 ${i + 1}]
章节: 第 ${item.chapter_num} 章
内容: ${item.content}`,
    )
    .join("\n\n━━━━━\n\n");

  const prompt = `你是一个专业的《天龙八部》小说助手。基于小说内容回答问题，用准确、详细的语言。

请根据以下《天龙八部》小说片段内容回答问题：
${context}

用户问题: ${state.question}

回答要求：
1. 如果片段中有相关信息，请结合小说内容给出详细、准确的回答
2. 可以综合多个片段的内容，提供完整的答案
3. 如果片段中没有相关信息，请如实告知用户
4. 回答要准确，符合小说的情节和人物设定
5. 可以引用原文内容来支持你的回答

AI 助手的回答:`;

  process.stdout.write("\n【AI 回答（流式）】\n");
  let generation = "";
  const stream = await model.stream(prompt);
  for await (const chunk of stream) {
    const text = typeof chunk.content === "string" ? chunk.content : "";
    if (!text) continue;
    generation += text;
    process.stdout.write(text);
  }
  process.stdout.write("\n");

  return { generation };
};

// 构建完整图：START → retrieve → generate → END
const graph = new StateGraph(GraphState)
  .addNode("retrieve", retrieveNode)
  .addNode("generate", generateNode)
  .addEdge(START, "retrieve") // 入口 → 检索
  .addEdge("retrieve", "generate") // 检索 → 生成
  .addEdge("generate", END) // 生成 → 结束
  .compile();
```

### 验证方式

```bash
node src/advanced-rag/naive-rag.mjs
```

能看到：

1. 连接 Milvus 成功
2. 流式输出一段基于小说内容的回答
3. 回答中引用了检索到的片段

### 关键理解

数据流转过程：

```
用户问题 → state.question
  ↓
retrieveNode 读取 state.question → 搜 Milvus → 返回 { documents: [...] }
  ↓  状态自动合并：state.documents 更新了
generateNode 读取 state.documents + state.question → 拼 Prompt → 调 LLM → 返回 { generation: "..." }
  ↓  状态自动合并：state.generation 更新了
result = 最终状态（包含 question, k, documents, generation）
```

你**不需要手动传递数据**，LangGraph 通过状态自动流转。

---

## Step 6：加结果展示——打印检索详情和 Mermaid 图

### 你会学到

- `graph.invoke` 返回的结果怎么展示
- `graph.getGraphAsync()` 导出流程图
- 最终代码的完整结构

### 任务

在 `graph.invoke` 之后加入结果打印逻辑：

```javascript
// 导出 Mermaid 流程图
const drawable = await graph.getGraphAsync();
const mermaid = drawable.drawMermaid({ withStyles: true });
console.log(mermaid);

// 打印检索结果
console.log("\n【检索相关内容】");
if (result.documents.length === 0) {
  console.log("未找到相关内容");
} else {
  result.documents.forEach((item, i) => {
    console.log(`\n[片段 ${i + 1}] 相似度: ${item.score.toFixed(4)}`);
    console.log(`书籍: ${item.book_id}`);
    console.log(`章节: 第 ${item.chapter_num} 章`);
    console.log(`片段索引: ${item.index}`);
    console.log(
      `内容: ${item.content.substring(0, 200)}${item.content.length > 200 ? "..." : ""}`,
    );
  });
}

if (!result.generation) {
  console.log("\n【AI 回答】");
  console.log("模型未返回内容。");
}
```

### 验证方式

最终运行输出应该包含：

1. Mermaid 格式的流程图文本
2. Milvus 连接信息
3. 流式 AI 回答
4. 检索到的文档详情（相似度、章节、内容预览）

### 完成标志

你的 `naive-rag.mjs` 现在就是一个完整的朴素 RAG 系统：

```
START → retrieve → generate → END
```

能从 Milvus 检索小说片段，基于片段流式生成回答，并展示检索详情。

---

## 总结：6 步对应代码结构

| Step | 新增代码                                                          | 对应 naive-rag.mjs 行数    |
| ---- | ----------------------------------------------------------------- | -------------------------- |
| 1    | import + ChatOpenAI + invoke                                      | 第 1-22 行                 |
| 2    | Annotation.Root 状态定义                                          | 第 6-14 行                 |
| 3    | generateNode + StateGraph 最简图                                  | 第 61-112 行               |
| 4    | embeddings + retrieveRelevantContent + retrieveNode + Milvus 连接 | 第 25-59 行, 第 123-153 行 |
| 5    | 修改 generateNode 加上下文 + 完整图                               | 第 61-112 行               |
| 6    | Mermaid + 结果打印                                                | 第 118-187 行              |
