import "dotenv/config";

import {
  DataType,
  MilvusClient,
  IndexType,
  MetricType,
} from "@zilliz/milvus2-sdk-node";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import chalk from "chalk";

const COLLECTION_NAME = process.env.COLLECTION_NAME || "diary";

// 1.创建 Milvus 客户端实例
const client = new MilvusClient({
  address: process.env.MILVUS_ADDRESS,
});

// 创建embedding用来生成向量
const embeddingModel = new OpenAIEmbeddings({
  model: process.env.EMBEDDINGS_MODEL_NAME,
  apiKey: process.env.API_KEY,
  configuration: {
    baseURL: process.env.BASE_URL,
  },
  dimensions: Number(process.env.EMBEDDINGS_DIMENSIONS),
  batchSize: 10,
});

const llm = new ChatOpenAI({
  model: process.env.MODEL_NAME,
  apiKey: process.env.API_KEY,
  configuration: {
    baseURL: process.env.BASE_URL,
  },
  temperature: 0,
});

// 把文本变成向量
async function getEmbedding(text) {
  const result = await embeddingModel.embedQuery(text);
  return result;
}

// 创建集合
async function ensureCollectionExists(collectionName, dim) {
  // 检查集合是否存在
  const exists = await client.hasCollection({
    collection_name: collectionName,
  });
  const isExists = exists?.value === true;
  if (!isExists) {
    await client.createCollection({
      collection_name: collectionName,
      fields: [
        {
          name: "id",
          data_type: DataType.VarChar,
          is_primary_key: true,
          auto_id: false,
          max_length: 256,
        },
        {
          name: "vector",
          data_type: DataType.FloatVector,
          dim,
        },
        {
          name: "content",
          data_type: DataType.VarChar,
          max_length: 5000,
        },
        {
          name: "date",
          data_type: DataType.VarChar,
          max_length: 50,
        },
        {
          name: "mood",
          data_type: DataType.VarChar,
          max_length: 50,
        },
        {
          name: "tags",
          data_type: DataType.Array,
          element_type: DataType.VarChar,
          max_capacity: 10,
          max_length: 50,
        },
      ],
    });
  }
}

async function inferVectorsAndDim(diaryContents) {
  const vectors = await Promise.all(
    diaryContents.map(async (item) => await getEmbedding(item.content)),
  );
  const dim = vectors[0].length;
  return { vectors, dim };
}
// 构建prompt
function buildPrompt(context, question) {
  return (
    "你是一个耐心的中文助手，只能基于【日记片段】回答问题。\n" +
    "如果【日记片段】里没有明确依据，请回复：不知道，并说明缺少哪些信息。\n" +
    "回答时尽量引用你依据的片段编号（例如：日记片段 2）。\n\n" +
    `【日记片段】\n${context}\n\n` +
    `【问题】\n${question}\n\n` +
    "【回答】"
  );
}

// 格式化检索结果
function formatSearchResults(results) {
  return results
    .map((item, i) => {
      return [
        `【日记片段 ${i + 1}】`,
        `ID: ${item.id}`,
        `内容: ${item.content}`,
        `日期: ${item.date}`,
        `心情: ${item.mood}`,
        `标签: ${item.tags.join(", ")}`,
      ].join("\n");
    })
    .join("\n\n---\n\n");
}

async function getResponse(prompt) {
  const res = await llm.invoke(prompt);
  return res.content;
}

function normalizeSearchResults(searchRes) {
  const r = searchRes?.results;
  if (!r) return [];
  if (Array.isArray(r) && r.length > 0 && Array.isArray(r[0])) return r[0];
  return r;
}

async function main() {
  console.log(chalk.blue("连接 Milvus 服务器..."));
  // 2.连接 Milvus 服务器

  await client.connectPromise;
  console.log(chalk.green("✓ 连接 Milvus 服务器成功"));
  // 准备日记数据
  const diaryContents = [
    {
      id: "diary_001",
      content:
        "今天天气很好，去公园散步了，心情愉快。看到了很多花开了，春天真美好。",
      date: "2026-01-10",
      mood: "happy",
      tags: ["生活", "散步"],
    },
    {
      id: "diary_002",
      content:
        "今天工作很忙，完成了一个重要的项目里程碑。团队合作很愉快，感觉很有成就感。",
      date: "2026-01-11",
      mood: "excited",
      tags: ["工作", "成就"],
    },
    {
      id: "diary_003",
      content:
        "周末和朋友去爬山，天气很好，心情也很放松。享受大自然的感觉真好。",
      date: "2026-01-12",
      mood: "relaxed",
      tags: ["户外", "朋友"],
    },
    {
      id: "diary_004",
      content:
        "今天学习了 Milvus 向量数据库，感觉很有意思。向量搜索技术真的很强大。",
      date: "2026-01-12",
      mood: "curious",
      tags: ["学习", "技术"],
    },
    {
      id: "diary_005",
      content:
        "晚上做了一顿丰盛的晚餐，尝试了新菜谱。家人都说很好吃，很有成就感。",
      date: "2026-01-13",
      mood: "proud",
      tags: ["美食", "家庭"],
    },
  ];
  console.log(chalk.blue("开始生成向量（Embeddings）..."));
  // 3.为日记生成向量（Embeddings）
  const { vectors, dim } = await inferVectorsAndDim(diaryContents);
  console.log(
    chalk.green(
      `✓ 生成向量（Embeddings）成功，共 ${vectors.length} 条，每个维度 ${dim}`,
    ),
  );
  // 4.创建集合
  console.log(chalk.blue("开始创建集合..."));
  await ensureCollectionExists(COLLECTION_NAME, dim);
  console.log(chalk.green("✓ 集合创建成功"));
  // 创建索引
  console.log(chalk.blue("开始创建索引..."));
  await client.createIndex({
    collection_name: COLLECTION_NAME,
    field_name: "vector",
    index_type: IndexType.IVF_FLAT,
    metric_type: MetricType.COSINE,
    params: {
      nlist: Number(process.env.IVF_NLIST || "1024"),
    },
  });
  // 加载集合
  console.log(chalk.blue("开始加载集合..."));
  try {
    await client.loadCollectionSync({ collection_name: COLLECTION_NAME });
  } catch {
    try {
      await client.loadCollection({ collection_name: COLLECTION_NAME });
    } catch (e) {
      const msg = String(e?.message || e || "").toLowerCase();
      if (!msg.includes("already loaded")) throw e;
    }
  }
  console.log(chalk.green("✓ 集合加载成功"));
  // 插入数据
  console.log(chalk.blue("开始插入数据..."));
  await client.insert({
    collection_name: COLLECTION_NAME,
    data: diaryContents.map((item, i) => ({
      id: item.id,
      vector: vectors[i],
      content: item.content,
      date: item.date,
      mood: item.mood,
      tags: item.tags,
    })),
  });
  console.log(chalk.green("✓ 数据插入成功"));
  // flush：让数据持久化并更稳定地参与索引/检索
  console.log(chalk.blue("开始刷新集合..."));
  try {
    await client.flushSync({ collection_names: [COLLECTION_NAME] });
  } catch {
    await client.flushCollection({ collection_name: COLLECTION_NAME });
  }
  console.log(chalk.green("✓ 集合刷新成功"));
  // 根据问题进行检索
  const questions = [
    "哪篇日记提到了去公园散步？具体看到了什么？",
    "哪一天的日记心情是 excited？那天发生了什么？",
    "有哪篇日记提到了 Milvus？作者对它的感受是什么？",
    "2026-01-12 这一天发生了哪些事？分别是什么心情？",
    "哪篇日记和“朋友”有关？做了什么活动？",
    "哪篇日记和“工作”有关？完成了什么里程碑？",
    "哪篇日记提到了做晚餐/新菜谱？家人反馈如何？",
    "找出最放松的一天，并说明为什么放松。",
    "按时间顺序总结这几天的主要事件，每天一句话。",
    "哪些日记表达了“成就感”？分别来自什么事情？",
  ];
  for (const question of questions) {
    console.log(chalk.blue(`开始检索问题：${question}`));
    // params.nprobe：搜索时探测的桶数量，越大召回更好但更慢
    const queryVector = await getEmbedding(question);
    const baseReq = {
      collection_name: COLLECTION_NAME,
      vector: queryVector,
      limit: Number(process.env.TOPK || "3"),
      output_fields: ["id", "date", "mood", "tags", "content"],
      metric_type: MetricType.COSINE,
    };
    const res = await client.search(baseReq);
    const results = normalizeSearchResults(res);
    console.log(chalk.green(`✓ 检索成功，共 ${results.length} 条结果`));
    const context = formatSearchResults(results);
    const prompt = buildPrompt(context, question);
    console.log(chalk.blue("开始调用模型..."));
    const response = await getResponse(prompt);
    console.log(chalk.green(`✓ 检索问题：${question}，回答：${response}`));
  }
}

main();
