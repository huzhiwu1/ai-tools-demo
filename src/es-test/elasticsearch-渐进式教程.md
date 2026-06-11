# Elasticsearch 渐进式教程：从零到 RAG 混合检索

> 本教程从最基础的 ES 环境搭建开始，逐步深入到 IK 中文分词、Node.js 代码操作、RAG 混合检索，每个阶段都有明确的任务和验证标准。跟着步骤一步步来，小白也能学会！

---

## 教程全景图

```
Phase 0: 环境准备          ← 搭建 ES + Kibana + Milvus 开发环境
  ↓
Phase 1: ES 基础操作        ← 在 Kibana 中学习索引和文档的增删改查
  ↓
Phase 2: IK 中文分词        ← 理解中文分词原理，掌握 IK 双分词配置
  ↓
Phase 3: Node.js 操作 ES    ← 用代码连接 ES，实现程序化的 CRUD
  ↓
Phase 4: RAG 混合检索       ← ES 关键词 + Milvus 向量语义 + Rerank
  ↓
Phase 5: Rerank 重排序      ← 理解 Rerank 原理，优化检索精度
```

---

## Phase 0：环境准备

### 目标

启动 Elasticsearch + Kibana + Milvus 开发环境，确保所有服务正常运行。

### 前置条件

- 已安装 Docker Desktop
- 已安装 Node.js 18+
- 已安装 pnpm

### 任务 0.1：配置环境变量

```bash
cd src/es-test
cp .env.example .env
```

编辑 `.env` 文件，填入你的 DashScope API Key：

```
OPENAI_API_KEY=sk-你的真实key
```

> 获取地址：https://dashscope.console.aliyun.com/apiKey

### 任务 0.2：启动 Docker 服务

```bash
# 构建并启动所有服务（ES + Kibana + Milvus 及其依赖）
docker compose up -d --build
```

> 首次构建 ES 镜像需要下载 IK 分词插件，可能需要几分钟

### 任务 0.3：验证服务状态

```bash
# 验证 ES 是否启动成功
curl http://localhost:9200

# 预期返回：包含 "You Know, for Search" 的 JSON
```

在浏览器中打开：

| 服务          | 地址                  | 说明         |
| ------------- | --------------------- | ------------ |
| Elasticsearch | http://localhost:9200 | REST API     |
| Kibana        | http://localhost:5601 | 可视化控制台 |
| Milvus        | localhost:19530       | 向量数据库   |

### 任务 0.4：安装项目依赖

```bash
pnpm install
```

### 验证标准

- [ ] `curl http://localhost:9200` 返回 ES 版本信息
- [ ] Kibana 页面可正常访问
- [ ] `pnpm install` 无报错

---

## Phase 1：ES 索引与文档基础操作

### 目标

在 Kibana Dev Tools 中动手操作，理解 ES 的核心概念：索引（Index）和文档（Document）。

### 核心概念

```
MySQL                 Elasticsearch
─────────────        ─────────────────
Database（数据库）    Index（索引）
Table（表）           Index（索引，ES 6.x 后一个索引≈一张表）
Row（行）             Document（文档，JSON 格式）
Column（列）          Field（字段）
Schema（表结构）      Mapping（映射）
SQL                   REST API（GET/POST/PUT/DELETE）
```

### 任务 1.1：创建索引

在 Kibana Dev Tools（http://localhost:5601 → 左侧菜单 Dev Tools）中执行：

```json
PUT /article
{
  "mappings": {
    "properties": {
      "title": { "type": "text" },
      "content": { "type": "text" },
      "author": { "type": "keyword" },
      "createTime": { "type": "date" },
      "viewCount": { "type": "integer" }
    }
  }
}
```

> 字段类型说明：
>
> - **text**：全文检索类型，会分词，适合模糊搜索
> - **keyword**：精确匹配类型，不分词，适合过滤/排序
> - **date**：日期类型
> - **integer**：整数类型

### 任务 1.2：插入文档

```json
// 自动生成 ID
POST /article/_doc
{
  "title": "Elasticsearch 全文检索入门",
  "content": "ES 基于倒排索引与 BM25 实现全文搜索",
  "author": "后端开发",
  "createTime": "2026-04-26",
  "viewCount": 128
}

// 指定自定义 ID
PUT /article/_doc/1001
{
  "title": "RAG 混合检索实战",
  "content": "ES 负责关键词检索，Milvus 负责向量语义检索",
  "author": "AI开发",
  "createTime": "2026-04-26",
  "viewCount": 256
}
```

### 任务 1.3：查询文档

```json
// 根据 ID 查询
GET /article/_doc/1001

// 查询全部
GET /article/_search
{
  "query": { "match_all": {} }
}

// 全文分词检索（搜索词会被分词后再匹配）
GET /article/_search
{
  "query": {
    "match": { "content": "RAG 向量 检索" }
  }
}

// 精确匹配（keyword 字段，搜索词不分词）
GET /article/_search
{
  "query": {
    "term": { "author": "AI开发" }
  }
}
```

### 任务 1.4：更新和删除文档

```json
// 局部更新（推荐，只修改指定字段）
POST /article/_update/1001
{
  "doc": { "viewCount": 999 }
}

// 根据 ID 删除
DELETE /article/_doc/1001
```

### 练习任务

打开 `kibana/01-索引与文档基础操作.md`，按顺序执行所有命令，观察每一步的返回结果。

### 思考题

1. `match` 和 `term` 查询有什么区别？什么场景用哪个？
2. 局部更新（`_update`）和全量覆盖（`PUT _doc/id`）有什么区别？

### 验证标准

- [ ] 能独立创建索引、插入文档、查询文档
- [ ] 理解 text 和 keyword 字段类型的区别
- [ ] 理解 match 和 term 查询的区别

---

## Phase 2：IK 中文分词实战

### 目标

理解为什么中文需要专门的分词器，掌握 IK 双分词配置（ik_max_word + ik_smart）。

### 核心概念

ES 默认的 **standard** 分词器按空格和标点拆分文本，但中文没有空格分隔词语，所以 standard 对中文几乎无效。

**IK 分词器**是专为中文设计的 ES 插件，提供两种分词模式：

| 分词器      | 切分策略     | 用途                                 | 示例（"混合检索知识库"）                |
| ----------- | ------------ | ------------------------------------ | --------------------------------------- |
| ik_max_word | 最细粒度切分 | 入库时使用（尽量多分词，提高召回率） | 混合/混/合检/检索/搜索/知识库/知识/识库 |
| ik_smart    | 智能切分     | 搜索时使用（分词更自然，提高准确率） | 混合/检索/知识库                        |

> **为什么"入库用细、搜索用粗"？**
>
> - 入库时细粒度分词 → 文档被更多 token 索引 → 搜索时更容易被命中（召回率高）
> - 搜索时智能分词 → 搜索词切分更合理 → 匹配结果更精准（准确率高）

### 任务 2.1：验证 IK 分词插件

在 Kibana Dev Tools 中执行：

```json
// 查看已安装插件（应看到 analysis-ik）
GET /_cat/plugins?v

// 对比三种分词器的效果
POST /_analyze
{
  "analyzer": "standard",
  "text": "Elasticsearch RAG 混合检索知识库"
}

POST /_analyze
{
  "analyzer": "ik_max_word",
  "text": "Elasticsearch RAG 混合检索知识库"
}

POST /_analyze
{
  "analyzer": "ik_smart",
  "text": "Elasticsearch RAG 混合检索知识库"
}
```

### 任务 2.2：创建带 IK 分词的索引

```json
PUT /life_note
{
  "mappings": {
    "properties": {
      "title": {
        "type": "text",
        "analyzer": "ik_max_word",      // 入库时：细粒度分词
        "search_analyzer": "ik_smart"   // 搜索时：智能分词
      },
      "content": {
        "type": "text",
        "analyzer": "ik_max_word",
        "search_analyzer": "ik_smart"
      },
      "type": { "type": "keyword" },
      "author": { "type": "keyword" },
      "record_time": { "type": "date" }
    }
  }
}
```

### 任务 2.3：插入数据并验证 IK 分词搜索

```json
// 插入测试数据
PUT /life_note/_doc/3001
{
  "title": "健康饮食与居家养生",
  "content": "规律作息、清淡饮食，多吃蔬菜水果，减少熬夜，合理运动才能保持身体健康",
  "type": "健康生活",
  "author": "生活达人",
  "record_time": "2026-04-27"
}

// IK 智能分词搜索
GET /life_note/_search
{
  "query": {
    "match": { "content": "健康 作息 旅行" }
  }
}
```

### 练习任务

打开 `kibana/02-IK中文分词实战.md`，按顺序执行所有命令。

### 思考题

1. 对比 ik_max_word 和 ik_smart 对"居家健康养生"的分词结果，说说区别
2. 如果建索引和搜索都用 ik_max_word，会有什么问题？
3. 如果都用 ik_smart，又会有什么问题？

### 验证标准

- [ ] 能说出 standard 和 IK 分词器在中文场景的核心区别
- [ ] 能说出 ik_max_word 和 ik_smart 的区别及各自适用场景
- [ ] 能独立创建带 IK 双分词配置的索引

---

## Phase 3：用 Node.js 代码操作 ES

### 目标

从 Kibana 手动操作过渡到用代码程序化操作 ES，为后续 RAG 流水线打基础。

### 任务 3.1：创建索引 + 种子数据

```bash
node src/create.mjs
```

预期输出：

```
✅ 索引创建成功: travel_journal
✅ 初始化数据完成，共 3 条
```

> 阅读代码重点：
>
> - `client.indices.exists()` / `client.indices.create()` — 索引操作
> - `client.bulk()` — 批量写入（比逐条插入效率高很多）
> - IK 双分词配置：`analyzer: 'ik_max_word'` + `search_analyzer: 'ik_smart'`

### 任务 3.2：执行 CRUD 操作

```bash
node src/operate.mjs
```

预期输出：

```
✅ 新增成功，ID = xxxxx
📖 查询结果: { note_title: '夜跑复盘', ... }
🔄 更新成功
📖 查询结果: { note_title: '夜跑复盘', note_body: '今天夜跑 6 公里...', ... }
🔍 搜索结果: [ ... ]
🗑️ 删除成功
🎉 CRUD 操作全部完成！
```

> 阅读代码重点：
>
> - `client.index()` — 新增文档
> - `client.get()` — 按 ID 查询
> - `client.update()` — 局部更新
> - `client.search()` — 全文搜索
> - `client.delete()` — 按 ID 删除

### 任务 3.3：在 Kibana 中验证

在 Kibana Dev Tools 中执行：

```json
// 查看 travel_journal 索引的映射
GET /travel_journal/_mapping

// 查询所有文档
GET /travel_journal/_search
{
  "query": { "match_all": {} }
}
```

### 练习：修改 operate.mjs

尝试修改 `src/operate.mjs`，实现以下功能：

1. 添加一个 `searchByTag` 函数，使用 `term` 查询按 tags 字段精确搜索
2. 添加一个 `countDocuments` 函数，统计索引中的文档总数
3. 修改 `searchDocuments` 函数，使用 `multi_match` 同时搜索 note_title 和 note_body

<details>
<summary>参考答案（点击展开）</summary>

```javascript
// 按 tag 精确搜索
async function searchByTag(tag) {
  const res = await client.search({
    index: INDEX_NAME,
    query: {
      term: { tags: tag },
    },
  });
  return res.hits.hits.map((item) => ({ id: item._id, ...item._source }));
}

// 统计文档总数
async function countDocuments() {
  const res = await client.count({ index: INDEX_NAME });
  console.log(`📊 文档总数: ${res.count}`);
}

// multi_match 多字段搜索
async function searchMultiField(keyword) {
  const res = await client.search({
    index: INDEX_NAME,
    query: {
      multi_match: {
        query: keyword,
        fields: ["note_title^2", "note_body"],
        type: "best_fields",
        analyzer: "ik_smart",
      },
    },
  });
  return res.hits.hits.map((item) => ({
    id: item._id,
    score: item._score,
    ...item._source,
  }));
}
```

</details>

### 验证标准

- [ ] `node src/create.mjs` 能成功创建索引并写入数据
- [ ] `node src/operate.mjs` 能完成 CRUD 全流程
- [ ] 能独立添加新的查询函数

---

## Phase 4：RAG 混合检索

### 目标

理解并实现完整的 RAG 混合检索流水线：ES 关键词检索 + Milvus 向量语义检索 + Rerank 重排。

### 核心概念

```
用户问题
  ↓
查询扩展（LLM 生成 3 条多角度检索问句）
  ↓            ↓
ES 关键词检索   Milvus 向量检索    ← 并行执行
  ↓            ↓
  合并去重
  ↓
Rerank 重排序
  ↓
LLM 生成回答
```

**为什么需要混合检索？**

| 检索方式     | 擅长                       | 不擅长   | 示例                         |
| ------------ | -------------------------- | -------- | ---------------------------- |
| ES 关键词    | 精确匹配（订单号、品牌名） | 语义理解 | "PO-20250409-K9" ✅          |
| Milvus 向量  | 语义匹配（意思相近）       | 精确匹配 | "网络不稳定"→"路由器断流" ✅ |
| **混合检索** | **两者兼顾**               | —        | 综合效果最好                 |

### 任务 4.1：初始化种子数据（ES + Milvus 双写）

```bash
node src/rag/seed-data.mjs
```

> 这个脚本会同时向 ES 和 Milvus 写入相同的 10 条生活笔记数据：
>
> - ES：存储原文，配置 IK 双分词
> - Milvus：存储文本的向量表示（通过 Embedding 模型转换）

预期输出：

```
[Elasticsearch]
✓ 索引创建成功
✓ ES 写入完成

[Milvus]
✓ 集合创建成功
✓ 索引创建成功
✓ Milvus 写入完成
```

### 任务 4.2：运行混合检索

```bash
node src/rag/hybrid-retrieval.mjs
```

> 观察输出内容：
>
> 1. 查询扩展：LLM 把原始问题扩展为 3 条检索问句
> 2. ES 检索结果
> 3. Milvus 检索结果
> 4. 重排后保留的文档
> 5. LLM 生成的最终回答

### 任务 4.3：阅读代码，理解 LangGraph 工作流

重点阅读 `src/rag/hybrid-retrieval.mjs` 中的 `compileHybridRetrievalGraph` 函数：

```
START → query_augment → es_recall ∥ milvus_recall → merge → rerank → generate_answer → END
```

关键代码段解读：

1. **查询扩展**：`augmentQuery()` 用 LLM 生成 3 条不同角度的检索问句
2. **并行检索**：`es_recall` 和 `milvus_recall` 通过 `addEdge("query_augment", ...)` 实现并行
3. **合并去重**：`merge()` 按 `metadata.id` 去重，ES 结果优先
4. **重排序**：`reranker.compressDocuments()` 用 Rerank 模型统一打分
5. **生成回答**：LLM 基于重排后的上下文生成最终答案

### 练习：修改检索参数

1. 修改 `SAMPLE_QUERIES` 数组，添加你自己的查询问题，观察检索效果
2. 调整 `ES_K` 和 `MILVUS_K` 参数（如从 15 改为 5 或 30），观察检索结果的变化
3. 修改 `reranker` 的 `topN` 参数（如从 3 改为 5），观察重排后保留的文档数

### 思考题

1. 为什么 ES 和 Milvus 的结果需要去重？什么情况下会出现重复？
2. 如果去掉 Rerank 步骤，直接用合并后的结果让 LLM 生成回答，效果会有什么变化？

### 验证标准

- [ ] 种子数据写入成功（ES 和 Milvus 各 10 条）
- [ ] 混合检索能返回相关结果
- [ ] 能说出混合检索比单一检索的优势

---

## Phase 5：Rerank 重排序

### 目标

深入理解 Rerank 的原理和作用，独立测试 Rerank 功能。

### 核心概念

**Rerank（重排序）** 是什么？

ES 按 BM25 算法评分，Milvus 按向量距离评分。两者评分体系不同、不可比。混合检索合并后，文档的排列顺序可能不合理。Rerank 模型就是来解决这个问题的：

```
合并后的文档（顺序可能不合理）
  ↓
Rerank 模型：对每个文档与查询的相关度统一打分
  ↓
按 Rerank 分数从高到低重排
  ↓
只保留 topN 个最相关的文档
```

### 任务 5.1：独立测试 Rerank

```bash
node src/rerank/test.mjs
```

预期输出：

```
原始文档顺序：
  [0] 预训练语言模型的发展给文本排序模型带来了新的进展
  [1] 量子计算是计算科学的一个前沿领域
  [2] 文本排序模型广泛用于搜索引擎和推荐系统中…

重排后顺序（按与查询的相关度从高到低）：
  - 文本排序模型广泛用于搜索引擎和推荐系统中…
  - 预训练语言模型的发展给文本排序模型带来了新的进展
  - 量子计算是计算科学的一个前沿领域
```

> 可以看到，与"文本排序模型"最相关的文档被排到了最前面，完全无关的"量子计算"被排到了最后。

### 任务 5.2：阅读 DashScopeRerank 代码

阅读 `src/rerank/dashscope-rerank.mjs`，理解：

1. `compressDocuments()` 方法的输入输出
2. DashScope Rerank API 的请求格式
3. 返回的 `results` 数组中 `index` 字段的含义

### 练习：修改 Rerank 测试

修改 `src/rerank/test.mjs`：

1. 修改 `query` 为其他问题（如"搜索引擎的工作原理"），观察重排结果
2. 添加更多测试文档，观察 `topN=3` 时只返回最相关的 3 条
3. 修改 `topN` 为 2 或 5，观察返回文档数的变化

### 验证标准

- [ ] Rerank 测试脚本能正常运行
- [ ] 能说出 Rerank 在混合检索流水线中的作用
- [ ] 能说出为什么混合检索后需要重排序

---

## 项目文件结构速查

```
src/es-test/
├── docker-compose.yml            # Docker 服务编排
├── package.json                  # 依赖配置
├── .env.example                  # 环境变量模板
├── elasticsearch/
│   └── Dockerfile                # ES 镜像（内置 IK 分词插件）
├── kibana/                       # Kibana Dev Tools 练习脚本
│   ├── 01-索引与文档基础操作.md    # Phase 1 练习
│   └── 02-IK中文分词实战.md       # Phase 2 练习
├── src/
│   ├── create.mjs                # Phase 3：创建索引 + 种子数据
│   ├── operate.mjs               # Phase 3：文档 CRUD 操作
│   └── rag/
│       ├── seed-data.mjs         # Phase 4：ES + Milvus 种子数据
│       ├── query-augment.mjs     # Phase 4：查询扩展
│       └── hybrid-retrieval.mjs  # Phase 4：混合检索主程序
│   └── rerank/
│       ├── dashscope-rerank.mjs  # Phase 5：Rerank 重排序器
│       └── test.mjs              # Phase 5：Rerank 独立测试
└── elasticsearch-渐进式教程.md    # 本教程文档
```

---

## 快速命令参考

```bash
# 启动服务
docker compose up -d --build

# 停止服务
docker compose down

# 查看服务状态
docker compose ps

# Phase 3
node src/create.mjs       # 创建索引 + 种子数据
node src/operate.mjs      # CRUD 操作

# Phase 4
node src/rag/seed-data.mjs           # 初始化 ES + Milvus 数据
node src/rag/hybrid-retrieval.mjs    # 运行混合检索

# Phase 5
node src/rerank/test.mjs             # 测试 Rerank
```

---

## 常见问题

### Q: docker compose up 后 ES 启动失败？

ES 对内存有要求，确保 Docker Desktop 分配了至少 4GB 内存。如果启动报 `max virtual memory areas vm.max_map_count` 错误，需要在宿主机上执行：

```bash
# Windows (以管理员身份运行 PowerShell)
wsl -d docker-desktop
sysctl -w vm.max_map_count=262144
```

### Q: Kibana 启动后页面打不开？

Kibana 启动需要等待 ES 就绪，通常需要 1-2 分钟。如果超过 3 分钟仍无法访问，检查 ES 是否正常运行：

```bash
docker compose logs es
docker compose logs kibana
```

### Q: Milvus 连接失败？

Milvus 依赖 etcd 和 minio，启动较慢。等待 healthcheck 通过后再尝试连接：

```bash
docker compose ps  # 查看 standalone 状态是否为 healthy
```

### Q: pnpm install 报错？

确保 Node.js 版本 >= 18，且网络可以访问 npm 仓库。如果使用国内网络，可以配置淘宝镜像：

```bash
pnpm config set registry https://registry.npmmirror.com
```
