/**
 * [文档 CRUD 操作]
 *
 * 职责：演示通过 Node.js 代码对 ES 文档进行增删改查
 *
 * 流程：
 * 1. 新增文档（index API）
 * 2. 查询单条文档（get API）
 * 3. 更新文档（update API）
 * 4. 全文搜索（search API + match 查询）
 * 5. 删除文档（delete API）
 *
 * 关键细节：
 * - index API：新增文档，refresh: true 使写入立即可搜索
 * - get API：按 ID 精确获取，返回 _source 字段即文档原始数据
 * - update API：局部更新，只修改指定字段
 * - search API：支持 match（分词搜索）、term（精确匹配）等多种查询
 * - delete API：按 ID 删除，或使用 delete_by_query 条件删除
 *
 * 运行方式：
 *   1. 先运行 node src/create.mjs 创建索引和种子数据
 *   2. 再运行 node src/operate.mjs 执行 CRUD 操作
 */
import { Client } from "@elastic/elasticsearch";

// ============================================
// 1. 创建 ES 客户端连接
// ============================================
const client = new Client({
  node: "http://localhost:9200",
});

const INDEX_NAME = "travel_journal";

// ============================================
// 2. 新增文档
// ============================================
// client.index() 对应 Kibana 中的 POST /{index}/_doc
// refresh: true 表示写入后立即可搜索（生产环境建议用 false，由 ES 自动刷新）
async function createDocument() {
  const now = new Date().toISOString();
  const res = await client.index({
    index: INDEX_NAME,
    document: {
      note_title: "夜跑复盘",
      note_body: "今天夜跑 5 公里，配速稳定，结束后做了拉伸。",
      tags: ["运动", "夜跑"],
      mood: "focused",
      priority: 2,
      created_at: now,
      updated_at: now,
    },
    refresh: true, // 写入后立即可搜索
  });

  console.log("✅ 新增成功，ID =", res._id);
  return res._id;
}

// ============================================
// 3. 根据 ID 查询文档
// ============================================
// client.get() 对应 Kibana 中的 GET /{index}/_doc/{id}
// 返回值中 _source 字段就是文档的原始 JSON 数据
async function getDocument(docId) {
  const res = await client.get({
    index: INDEX_NAME,
    id: docId,
  });
  console.log("📖 查询结果:", res._source);
}

// ============================================
// 4. 局部更新文档
// ============================================
// client.update() 对应 Kibana 中的 POST /{index}/_update/{id}
// 只修改 doc 中指定的字段，其他字段保持不变
// 比全量覆盖更安全（不会丢失未提及的字段）
async function updateDocument(docId) {
  await client.update({
    index: INDEX_NAME,
    id: docId,
    doc: {
      note_body: "今天夜跑 6 公里，状态不错，拉伸后恢复很快。",
      tags: ["运动", "夜跑", "训练"],
      updated_at: new Date().toISOString(),
    },
    refresh: true,
  });
  console.log("🔄 更新成功");
}

// ============================================
// 5. 全文分词搜索
// ============================================
// client.search() 对应 Kibana 中的 GET /{index}/_search
// match 查询：搜索词会被分词器处理，只要文档包含任一分词结果就命中
// multi_match：同时搜索多个字段，^2 表示该字段权重翻倍
async function searchDocuments() {
  const res = await client.search({
    index: INDEX_NAME,
    query: {
      match: {
        note_body: {
          query: "慢跑以及骑行的数据",
          analyzer: "ik_smart", // 搜索时使用 ik_smart 智能分词
        },
      },
    },
  });

  // hits.hits 是匹配到的文档数组
  // 每个元素包含 _id、_score（相关度评分）、_source（原始数据）
  const rows = res.hits.hits.map((item) => ({
    id: item._id,
    score: item._score, // BM25 相关度评分，越高越匹配
    ...item._source,
  }));
  console.log("🔍 搜索结果:", rows);
}

// ============================================
// 6. 删除文档
// ============================================
// client.delete() 对应 Kibana 中的 DELETE /{index}/_doc/{id}
async function deleteDocument(docId) {
  await client.delete({
    index: INDEX_NAME,
    id: docId,
    refresh: true,
  });
  console.log("🗑️ 删除成功");
}

// ============================================
// 7. 主入口 —— 逐步执行 CRUD 流程
// ============================================
async function run() {
  // 第一步：新增文档，获取自动生成的 ID
  const docId = await createDocument();

  // 第二步：查询刚插入的文档
  await getDocument(docId);

  // 第三步：局部更新文档
  await updateDocument(docId);

  // 第四步：验证更新后的内容
  await getDocument(docId);

  // 第五步：全文搜索
  await searchDocuments();

  // 第六步：删除文档
  await deleteDocument(docId);

  console.log("\n🎉 CRUD 操作全部完成！");
}

run().catch((err) => {
  console.error("❌ 操作阶段失败:", err);
  process.exit(1);
});
