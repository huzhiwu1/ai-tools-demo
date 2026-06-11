/**
 * [RAG 种子数据：ES + Milvus 双写]
 *
 * 职责：同时向 Elasticsearch 和 Milvus 写入相同的笔记数据
 *       ES 存储原文（关键词检索），Milvus 存储向量（语义检索）
 *
 * 流程：
 * 1. 连接 Milvus 客户端
 * 2. 重建 ES 索引并 bulk 写入原文
 * 3. 重建 Milvus 集合、创建向量索引、插入向量数据
 *
 * 关键细节：
 * - ES 和 Milvus 使用同一个 id，方便后续混合检索时去重合并
 * - ES 的 text 字段配置 IK 双分词
 * - Milvus 需要先用 Embedding 模型把文本转成向量再存入
 * - Milvus 的 doc_text 字段存储拼接后的完整文本，用于 RAG 上下文拼接
 *
 * 运行方式：node src/rag/seed-data.mjs
 */
import "dotenv/config";
import { Client } from "@elastic/elasticsearch";
import { OpenAIEmbeddings } from "@langchain/openai";
import {
  DataType,
  IndexType,
  MetricType,
  MilvusClient,
} from "@zilliz/milvus2-sdk-node";

// ============================================
// 1. 常量配置
// ============================================
const INDEX_NAME = "life_notes"; // 索引/集合名称
const ES_NODE = "http://localhost:9200"; // ES 地址
const MILVUS_ADDRESS = "localhost:19530"; // Milvus 地址

const DOC_TEXT = "doc_text"; // Milvus 中存储完整文本的字段名
const EMBEDDING = "embedding"; // Milvus 中存储向量的字段名

// ============================================
// 2. 种子数据：10 条生活笔记
// ============================================
const ROWS = [
  {
    id: "life_01",
    note_title: "周末煲汤小备忘",
    note_body:
      "排骨冷水下锅焯一下，加姜片料酒；换了砂锅小火炖一小时，最后放盐和白胡椒，海带要提前泡发切条。",
    tags: ["下厨", "周末"],
    mood: "馋",
    priority: 2,
  },
  {
    id: "life_02",
    note_title: "晚饭后遛狗路线",
    note_body:
      "小区东门出去沿河岸走一圈大概四十分钟，记得带拾便袋和水壶；下雨天改地下停车场那层绕两圈也行。",
    tags: ["宠物", "散步"],
    mood: "放松",
    priority: 3,
  },
  {
    id: "life_03",
    note_title: "阳台绿植浇水频率",
    note_body:
      "绿萝见干再浇，龟背竹叶面可以偶尔喷水；夏天蒸发快早上看一眼土表，冬天少浇防止烂根。",
    tags: ["家务", "植物"],
    mood: "碎碎念",
    priority: 1,
  },
  {
    id: "life_04",
    note_title: "路由器偶尔断流排查笔记",
    note_body:
      "先重启光猫再重启路由；信道改成自动或固定 36；固件升级到官网最新版；还不行就还原出厂单独测网线。",
    tags: ["数码", "折腾"],
    mood: "烦躁",
    priority: 2,
  },
  {
    id: "life_05",
    note_title: "净水器滤芯更换记录",
    note_body:
      "官网登记的机身序列 SN-MILO-77821；上次换的是第三代 RO 复合滤芯，配件订单号 PO-20250409-K9；下次提醒换前置 PP 棉。",
    tags: ["家务", "维保"],
    mood: "琐事",
    priority: 1,
  },
  {
    id: "life_06",
    note_title: "梧州龟苓膏粉冲泡比例",
    note_body:
      "双钱牌粉一包兑常温凉水先搅匀再小火搅拌到冒小泡；千万别用滚烫开水直接冲容易结块；可加少量桂花蜜。",
    tags: ["下厨", "甜品"],
    mood: "解馋",
    priority: 1,
  },
  {
    id: "life_07",
    note_title: "租房合同划的重点句",
    note_body:
      "第八条写的是押一付三提前三十日书面通知；手写补充了一句「甲方不得以不正当理由扣减退房押金」记得双方都签了字。",
    tags: ["租房", "法律"],
    mood: "谨慎",
    priority: 3,
  },
  {
    id: "life_08",
    note_title: "肉汤熬久了反而涩",
    note_body:
      "大块骨肉要先焯掉浮沫，文火咕嘟太久胶质出来了汤会发黏发涩；觉得不清爽可以中途打掉一层油，起锅前再调味。",
    tags: ["下厨", "技巧"],
    mood: "琢磨",
    priority: 2,
  },
  {
    id: "life_09",
    note_title: "半夜趴窗台透气",
    note_body:
      "脑子停不下来就一直复盘白天在会上说的话，越想越清醒；干脆开窗吹两分钟冷风，把手机扔到客厅充电再回屋。",
    tags: ["情绪", "失眠"],
    mood: "飘",
    priority: 2,
  },
  {
    id: "life_10",
    note_title: "出差酒店网速玄学",
    note_body:
      "同一个SSID走廊尽头满格会议室里假信号；连手机热点写周报反而稳；视频会议尽量靠窗座位别躲在最里间死角。",
    tags: ["差旅", "办公"],
    mood: "无奈",
    priority: 2,
  },
];

// ============================================
// 3. Embedding 模型（文本 → 向量）
// ============================================
// 使用阿里云 DashScope 的 text-embedding-v3 模型
// 1024 维向量，适合中文语义检索
const embeddings = new OpenAIEmbeddings({
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.EMBEDDINGS_MODEL_NAME ?? "text-embedding-v3",
  configuration: {
    baseURL:
      process.env.OPENAI_BASE_URL ??
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
});

// ============================================
// 4. Milvus 客户端
// ============================================
const milvusClient = new MilvusClient({
  address: MILVUS_ADDRESS,
});

/**
 * 重建 ES 索引并 bulk 写入
 *
 * 流程：
 * 1. 如果索引已存在则先删除（重建，确保映射正确）
 * 2. 创建索引并指定 IK 双分词映射
 * 3. 批量写入所有文档
 */
async function seedElasticsearch(indexName, rows) {
  try {
    console.log("\n[Elasticsearch]");
    const client = new Client({ node: ES_NODE });

    // 检查索引是否已存在，存在则先删除
    const exists = await client.indices.exists({ index: indexName });
    if (exists) {
      console.log("删除已有索引...");
      await client.indices.delete({ index: indexName });
      console.log("✓ 已删除");
    }

    // 创建索引与映射
    console.log("创建索引与 mapping...");
    await client.indices.create({
      index: indexName,
      mappings: {
        properties: {
          // IK 双分词：入库 ik_max_word，搜索 ik_smart
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
    console.log("✓ 索引创建成功");

    // 批量写入
    const now = new Date().toISOString();
    console.log(`写入 ${rows.length} 条文档...`);
    await client.bulk({
      refresh: true,
      operations: rows.flatMap((row) => {
        const { id, ...rest } = row;
        return [
          { index: { _index: indexName, _id: id } },
          { ...rest, created_at: now, updated_at: now },
        ];
      }),
    });
    console.log("✓ ES 写入完成");
  } catch (error) {
    console.error("Elasticsearch 出错:", error.message);
    throw error;
  }
}

/**
 * 重建 Milvus 集合并写入向量数据
 *
 * 流程：
 * 1. 如果集合已存在则先删除
 * 2. 创建集合（定义字段：id、note_title、note_body、向量等）
 * 3. 创建向量索引（HNSW，适合大规模向量检索）
 * 4. 加载集合到内存
 * 5. 插入向量数据
 *
 * 关键细节：
 * - Milvus 的集合需要先 load 到内存才能被搜索
 * - HNSW 索引参数：M=8（每层最大连接数），efConstruction=64（构建时搜索宽度）
 * - langchain_primaryid 是 LangChain 集成需要的自增主键
 */
async function seedMilvus(collectionName, rows, emb) {
  try {
    console.log("\n[Milvus]");

    // 生成文本向量：把每条笔记的 title + body 拼接后用 Embedding 模型转成向量
    const texts = rows.map((row) => `${row.note_title}\n${row.note_body}`);
    console.log("生成向量嵌入...");
    const vectors = await emb.embedDocuments(texts);
    const dim = vectors[0].length; // 向量维度（text-embedding-v3 是 1024 维）

    // 检查集合是否已存在，存在则先删除
    const hasCollection = await milvusClient.hasCollection({
      collection_name: collectionName,
    });
    if (hasCollection.value) {
      console.log("删除已有集合...");
      await milvusClient.dropCollection({ collection_name: collectionName });
      console.log("✓ 已删除");
    }

    // 创建集合（定义所有字段）
    console.log("创建集合...");
    await milvusClient.createCollection({
      collection_name: collectionName,
      fields: [
        { name: "id", data_type: DataType.VarChar, max_length: 100 },
        { name: "note_title", data_type: DataType.VarChar, max_length: 512 },
        { name: "note_body", data_type: DataType.VarChar, max_length: 4096 },
        { name: "mood", data_type: DataType.VarChar, max_length: 64 },
        { name: "priority", data_type: DataType.VarChar, max_length: 16 },
        { name: "tags", data_type: DataType.VarChar, max_length: 256 },
        // LangChain 集成需要自增主键
        {
          name: "langchain_primaryid",
          data_type: DataType.Int64,
          is_primary_key: true,
          autoID: true,
        },
        // doc_text: 拼接后的完整文本，用于 RAG 上下文拼接
        { name: DOC_TEXT, data_type: DataType.VarChar, max_length: 10000 },
        // embedding: 向量字段，维度和 Embedding 模型输出一致
        { name: EMBEDDING, data_type: DataType.FloatVector, dim },
      ],
    });
    console.log("✓ 集合创建成功");

    // 创建向量索引（HNSW 算法，适合大规模向量检索）
    // HNSW 是一种近似最近邻算法，比暴力搜索快很多
    console.log("创建向量索引...");
    await milvusClient.createIndex({
      collection_name: collectionName,
      field_name: EMBEDDING,
      index_type: IndexType.HNSW,
      metric_type: MetricType.L2,
      params: { M: 8, efConstruction: 64 },
    });
    console.log("✓ 索引创建成功");

    // 加载集合到内存（Milvus 要求集合必须在内存中才能被搜索）
    try {
      await milvusClient.loadCollection({ collection_name: collectionName });
      console.log("✓ 集合已加载");
    } catch {
      console.log("✓ 集合已处于加载状态");
    }

    // 插入向量数据
    console.log(`插入 ${rows.length} 条...`);
    const insertData = rows.map((row, i) => ({
      id: row.id,
      note_title: row.note_title,
      note_body: row.note_body,
      mood: row.mood,
      priority: String(row.priority),
      tags: row.tags.join(","),
      [DOC_TEXT]: texts[i], // 完整文本
      [EMBEDDING]: vectors[i], // 向量
    }));

    const insertResult = await milvusClient.insert({
      collection_name: collectionName,
      data: insertData,
    });

    // flush 确保数据持久化
    await milvusClient.flushSync({ collection_names: [collectionName] });

    const cnt = Number(insertResult.insert_cnt) || rows.length;
    console.log(`✓ Milvus 写入完成（insert_cnt: ${cnt}）`);
  } catch (error) {
    console.error("Milvus 出错:", error.message);
    throw error;
  }
}

/**
 * 主入口
 */
async function main() {
  try {
    console.log("\n连接 Milvus...");
    await milvusClient.connectPromise;
    console.log("✓ 已连接");

    await seedElasticsearch(INDEX_NAME, ROWS);
    await seedMilvus(INDEX_NAME, ROWS, embeddings);
  } catch (error) {
    console.error("\n错误:", error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
