# Neo4j GraphRAG 渐进式教程

> 从零开始，用图数据库 + LLM 构建智能知识问答系统

## 学习路径总览

```
01-neo4j-connect.mjs     连接 Neo4j + 基础 CRUD
        ↓
02-build-food-graph.mjs  构建美食知识图谱（5种节点 + 4种关系）
        ↓
03-query-graph.mjs       多跳关系查询（1跳→2跳→聚合→路径）
        ↓
04-graphrag.mjs          GraphRAG 核心实现（LangGraph 三步工作流）
        ↓
05-graphrag-enhanced.mjs 增强版（Schema自动获取 + 重试 + 日志）
```

## 前置准备

### 1. 安装依赖

```bash
# 在项目根目录
pnpm add neo4j-driver @langchain/community @langchain/core @langchain/openai @langchain/langgraph dotenv
```

### 2. 启动 Neo4j

```bash
cd src/neo4j-graphrag
docker compose up -d

# 等待约 10 秒，验证启动成功
# 浏览器打开 http://localhost:7474（用户名 neo4j，密码 12345678）
```

### 3. 配置环境变量

复制 `.env.example` 为 `.env`，填入你的 API Key：

```env
OPENAI_API_KEY=sk-your-api-key
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MODEL_NAME=qwen-plus
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=12345678
```

---

## 第一站：Neo4j 连接与基础 CRUD

**文件**：`01-neo4j-connect.mjs`

**运行**：`node src/neo4j-graphrag/01-neo4j-connect.mjs`

### 核心知识

**Neo4j 是什么？**
图数据库，用「节点（Node）」和「关系（Relationship）」存储数据，天然适合表达复杂的关联关系。

**图数据库 vs 关系型数据库：**

| 维度     | MySQL（关系型）      | Neo4j（图）                  |
| -------- | -------------------- | ---------------------------- |
| 数据模型 | 表格 + 外键          | 节点 + 关系                  |
| 多表查询 | JOIN，越多越慢       | 模式匹配，多跳也很快         |
| 适用场景 | 事务处理、结构化数据 | 社交网络、知识图谱、推荐系统 |
| 查询语言 | SQL                  | Cypher                       |

**Cypher 五大关键词：**

| 关键词   | 作用          | SQL 等价     |
| -------- | ------------- | ------------ |
| `CREATE` | 创建节点/关系 | INSERT       |
| `MATCH`  | 模式匹配      | SELECT WHERE |
| `SET`    | 更新属性      | UPDATE SET   |
| `DELETE` | 删除节点/关系 | DELETE       |
| `RETURN` | 返回结果      | SELECT 列    |

**Bolt 协议：** Neo4j 的原生二进制协议，端口 7687，速度最快，Node.js 连接用这个。

### 代码要点

```javascript
// 创建连接
const driver = neo4j.driver('bolt://localhost:7687', neo4j.auth.basic('neo4j', '12345678'))
const session = driver.session()

// Cypher CRUD
await session.run(`CREATE (p:Product {name: "红烧肉"})`)           // 创建节点
await session.run(`MATCH (p:Product {name: "红烧肉"}) SET p.price = 38`)  // 更新
await session.run(`MATCH (p:Product {name: "红烧肉"}) DETACH DELETE p`)   // 删除
```

**小白注意：** session 用完必须 `close()`，否则连接泄漏！

---

## 第二站：构建美食知识图谱

**文件**：`02-build-food-graph.mjs`

**运行**：`node src/neo4j-graphrag/02-build-food-graph.mjs`

### 核心知识

本教程构建一个「美食知识图谱」，包含 5 种节点和 4 种关系：

```
(Product)   -[属于]->   (Type)        红烧肉 属于 热菜
(Product)   -[包含]->   (Ingredient)  红烧肉 包含 五花肉
(Product)   -[推荐]->   (People)      红烧肉 推荐 张三
(Ingredient)-[做法]->   (Method)      五花肉 做法 炖
```

**数据总览：**

- 3 个产品：红烧肉、番茄炒蛋、宫保鸡丁
- 2 个类型：热菜、凉菜
- 5 个食材：五花肉、鸡蛋、番茄、鸡胸肉、花生
- 2 个做法：炒、炖
- 3 个人物：张三、李四、王五

### 知识扩展：CREATE vs MERGE

| 关键词   | 行为                           | 适用场景         |
| -------- | ------------------------------ | ---------------- |
| `CREATE` | 无条件创建，可能重复           | 配合先清空数据   |
| `MERGE`  | 先查找，不存在才创建（UPSERT） | 生产环境，防重复 |

**关系方向很重要！** 创建时 `(A)-[r]->(B)`，查询时箭头方向必须一致。

---

## 第三站：多跳关系查询

**文件**：`03-query-graph.mjs`

**运行**：`node src/neo4j-graphrag/03-query-graph.mjs`

### 核心知识

图数据库最强大的能力——多跳遍历（Multi-hop Traversal）：

| 查询类型 | Cypher 模式            | 示例问题                 |
| -------- | ---------------------- | ------------------------ |
| 一跳     | `(a)-[r]->(b)`         | 红烧肉包含哪些食材？     |
| 两跳     | `(a)-[]->(b)-[]->(c)`  | 红烧肉的食材用什么做法？ |
| 反向     | 箭头方向指向查询目标   | 哪些菜推荐给了张三？     |
| 聚合     | `count()`, `collect()` | 每种类型有几道菜？       |
| 可变路径 | `-[*1..3]->`           | 两节点之间的任意长度路径 |

### 知识扩展：为什么 GraphRAG 需要理解多跳？

GraphRAG 的核心就是让 LLM 学会生成多跳 Cypher。例如：

用户问："红烧肉的食材怎么烹饪？"
LLM 需要生成两跳查询：

```cypher
MATCH (p:Product {name: "红烧肉"})-[:包含]->(i:Ingredient)-[:做法]->(m:Method)
RETURN p.name, i.name, m.name
```

这在 SQL 中需要 3 张表的 JOIN，而 Cypher 只需要多写一段箭头。

---

## 第四站：GraphRAG 核心实现

**文件**：`04-graphrag.mjs`

**运行**：`node src/neo4j-graphrag/04-graphrag.mjs`

### 核心知识

**GraphRAG = Graph + RAG**

| 维度     | 传统 RAG               | GraphRAG                     |
| -------- | ---------------------- | ---------------------------- |
| 检索源   | 向量数据库（文本片段） | 图数据库（结构化关系）       |
| 检索方式 | 语义相似度匹配         | LLM 生成 Cypher 查询         |
| 擅长问题 | "什么是XXX"            | "A和B有什么关系""通过C找到D" |
| 结果形式 | 文本段落               | 结构化 JSON                  |

**三步工作流（LangGraph StateGraph）：**

```
用户问题 → [generateCypher] → [executeGraph] → [generateAnswer] → 最终答案
              LLM生成Cypher    查询Neo4j        LLM生成回答
```

### 关键实现细节

**1. Neo4jGraph vs neo4j-driver**

| 工具                      | 用途                                          |
| ------------------------- | --------------------------------------------- |
| `neo4j-driver`            | 官方底层驱动，灵活但代码多                    |
| `Neo4jGraph`（LangChain） | 高层封装，提供 `getSchema()` 自动获取图谱结构 |

**2. LangGraph StateGraph 状态管理**

```javascript
const state = {
  messages: { value: (left, right) => left.concat(right) },  // reducer：消息累积
  cypher: null,     // 普通字段：每次覆盖
  context: null,
  answer: null,
}
```

- `messages` 用 reducer 函数，新消息追加而非覆盖
- 其他字段是普通赋值，每次更新覆盖旧值

**3. Prompt Engineering 要点**

生成 Cypher 的 Prompt 必须包含：

1. 图谱 Schema（节点类型、关系方向）
2. 输出约束（只要 Cypher，不要 markdown）
3. 安全规则（只 MATCH，不要 CREATE/DELETE）

---

## 第五站：增强版 GraphRAG

**文件**：`05-graphrag-enhanced.mjs`

**运行**：`node src/neo4j-graphrag/05-graphrag-enhanced.mjs`

### 三大增强

**1. Schema 自动获取**

```javascript
const schema = await graph.getSchema()
// 自动返回图谱的完整结构描述，无需手动维护
```

解决了第四站硬编码 Schema 的问题。图谱结构变了，Prompt 自动适应。

**2. 条件路由 + 自动重试**

```
executeGraph → [条件判断]
                ↓ 成功 → generateAnswer
                ↓ 失败且可重试 → generateCypher（带错误反馈）
                ↓ 失败且不可重试 → generateAnswer（兜底回答）
```

Cypher 生成可能出错（语法错误、关系方向反了），自动重试让 LLM 修正错误。

**3. 结构化日志**

每个节点记录：输入、输出、耗时，便于调试 LLM 应用。

---

## Cypher 速查手册

### 节点操作

```cypher
// 创建
CREATE (p:Product {name: "红烧肉"})

// 查询
MATCH (p:Product) RETURN p
MATCH (p:Product {name: "红烧肉"}) RETURN p

// 更新
MATCH (p:Product {name: "红烧肉"}) SET p.price = 38, p.taste = "咸鲜"

// 删除（DETACH 会同时删除关系）
MATCH (p:Product {name: "红烧肉"}) DETACH DELETE p
```

### 关系操作

```cypher
// 创建关系
MATCH (p:Product {name: "红烧肉"}), (i:Ingredient {name: "五花肉"})
CREATE (p)-[:包含]->(i)

// 查询关系
MATCH (p:Product)-[r:包含]->(i:Ingredient) RETURN p.name, i.name

// 多跳查询
MATCH (p:Product)-[:包含]->(i:Ingredient)-[:做法]->(m:Method)
RETURN p.name, i.name, m.name

// 删除关系
MATCH (p:Product)-[r:包含]->(i:Ingredient) DELETE r
```

### 聚合查询

```cypher
// 计数 + 分组
MATCH (p:Product)-[:属于]->(t:Type)
RETURN t.name, count(p), collect(p.name)

// 全局统计
MATCH (n) RETURN count(n) AS nodeCount
MATCH ()-[r]->() RETURN count(r) AS relCount
```

---

## 常见问题

### Q: Neo4j 连不上？

```bash
# 检查容器是否运行
docker compose ps

# 查看日志
docker compose logs neo4j

# Neo4j 启动需要约 10 秒，耐心等待
```

### Q: LLM 生成的 Cypher 执行失败？

这是正常的！LLM 可能生成语法错误的 Cypher。第五站的重试机制会自动修正。

### Q: 如何可视化图谱？

浏览器打开 http://localhost:7474，输入：

```cypher
MATCH (n) RETURN n
```

### Q: 如何清空所有数据？

在 Neo4j Browser 中执行：

```cypher
MATCH (n) DETACH DELETE n
```

---

## 进阶方向

1. **混合 GraphRAG**：向量检索 + 图查询结合，兼顾语义相似和关系遍历
2. **流式输出**：使用 `app.stream()` 逐节点输出，提升用户体验
3. **多轮对话**：添加 `messages` 历史管理，支持上下文连续问答
4. **权限控制**：限制 LLM 只能查询特定标签/关系，防止越权访问
