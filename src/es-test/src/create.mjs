/**
 * [索引创建 + 种子数据]
 *
 * 职责：创建 ES 索引并批量写入初始数据
 *
 * 流程：
 * 1. 连接 ES 客户端
 * 2. 检查索引是否已存在（避免重复创建报错）
 * 3. 创建索引并指定字段映射（IK 双分词配置）
 * 4. 使用 bulk API 批量写入种子数据
 *
 * 关键细节：
 * - IK 分词：入库用 ik_max_word（细粒度），搜索用 ik_smart（智能）
 * - bulk API 比逐条插入效率高很多（一次网络往返）
 * - refresh: true 表示写入后立即可搜索
 *
 * 运行方式：node src/create.mjs
 */
import { Client } from "@elastic/elasticsearch";

// ============================================
// 1. 创建 ES 客户端连接
// ============================================
// node 参数指定 ES 服务地址
// 开发环境关闭了安全认证，无需用户名密码
const client = new Client({
  node: "http://localhost:9200",
});

// 索引名称：旅行笔记
const INDEX_NAME = "travel_journal";

// ============================================
// 2. 创建索引（带 IK 双分词映射）
// ============================================
async function createIndex() {
  // 先检查索引是否已存在
  const exists = await client.indices.exists({ index: INDEX_NAME });
  if (exists) {
    console.log(`ℹ️ 索引已存在: ${INDEX_NAME}`);
    return;
  }

  // 创建索引并定义字段映射
  // text 类型：会分词，适合全文检索
  //   analyzer: 入库时用的分词器（ik_max_word = 细粒度切分）
  //   search_analyzer: 搜索时用的分词器（ik_smart = 智能切分）
  // keyword 类型：不分词，适合精确匹配、排序、聚合
  // integer 类型：数值，适合范围查询和排序
  // date 类型：日期，支持日期范围查询
  await client.indices.create({
    index: INDEX_NAME,
    mappings: {
      properties: {
        note_title: {
          type: "text",
          analyzer: "ik_max_word",
          search_analyzer: "ik_smart",
        },
        note_body: {
          type: "text",
          analyzer: "ik_max_word",
          search_analyzer: "ik_smart",
        },
        tags: { type: "keyword" },
        mood: { type: "keyword" },
        priority: { type: "integer" },
        created_at: { type: "date" },
        updated_at: { type: "date" },
      },
    },
  });

  console.log(`✅ 索引创建成功: ${INDEX_NAME}`);
}

// ============================================
// 3. 批量写入种子数据
// ============================================
// bulk API 是 ES 的高性能批量写入方式
// 格式：[action, document, action, document, ...]
// 每对数据由"操作指令行 + 文档数据行"组成
async function seedData() {
  const now = new Date().toISOString();
  const docs = [
    {
      note_title: "杭州西湖半日游",
      note_body: "早上绕湖慢跑，中午吃片儿川，下午在断桥拍照放松。",
      tags: ["旅行", "周末", "杭州"],
      mood: "relaxed",
      priority: 2,
      created_at: now,
      updated_at: now,
    },
    {
      note_title: "城市骑行计划",
      note_body: "周六沿江骑行 20 公里，带上水和简易修车工具。",
      tags: ["运动", "骑行"],
      mood: "energetic",
      priority: 3,
      created_at: now,
      updated_at: now,
    },
    {
      note_title: "雨天宅家阅读",
      note_body: "下雨天在家看书，整理本周笔记并做晚餐。",
      tags: ["生活", "阅读"],
      mood: "calm",
      priority: 1,
      created_at: now,
      updated_at: now,
    },
  ];

  // flatMap 将每个文档展开为 [index 操作指令, 文档数据] 两个元素
  const operations = docs.flatMap((doc) => [
    { index: { _index: INDEX_NAME } }, // 操作指令：插入到 INDEX_NAME
    doc, // 文档数据
  ]);

  // refresh: true 表示写入完成后立即刷新，让数据可被搜索到
  await client.bulk({ refresh: true, operations });
  console.log(`✅ 初始化数据完成，共 ${docs.length} 条`);
}

// ============================================
// 4. 主入口
// ============================================
async function run() {
  await createIndex();
  await seedData();
}

run().catch((err) => {
  console.error("❌ 创建阶段失败:", err);
  process.exit(1);
});
