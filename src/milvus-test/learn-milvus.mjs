import "dotenv/config";
import chalk from "chalk";
import { OpenAIEmbeddings } from "@langchain/openai";

// 目标：用一份可运行的脚本，带你从 0 走完 Milvus 的核心闭环：
// 连接 -> 建 Collection(表) -> 插入数据 -> flush -> 建索引 -> load -> search
//
// 你可以把 Milvus 当成“向量表数据库”：
// - 一行数据 = { 主键 id, 向量 vector, 以及若干标量字段(如 text/topic/source) }
// - 搜索时输入 query vector，Milvus 返回最相近的 TopK 行
//
// Milvus 在 RAG 里的角色：
// - 你把知识库分块后做 embedding，把向量 + 原文/metadata 写入 Milvus
// - 用户提问时：把问题 embedding 成向量 -> 向 Milvus 做相似度检索 -> 拿到原文片段 -> 拼到 prompt 里让 LLM 回答

const env = (name, fallback) => {
  // 读取可选环境变量：
  // - 没配置时返回 fallback
  // - 这样脚本既能“零配置跑通”（随机向量模式），又能“接入真实 embedding”
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v;
};

const mustEnv = (name) => {
  // 读取必需环境变量：
  // - 用于 USE_EMBEDDINGS=1 时，确保 embedding 能正常调用
  // - 如果缺失就立刻抛错，避免跑到一半才出现 401/400 等网络错误
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `缺少环境变量 ${name}。\n` +
        `如果你只是想跑通 Milvus 流程（随机向量示例），可以不配置 OpenAI 相关变量。\n` +
        `如果你想用真实文本向量（更接近 RAG），请配置：\n` +
        `- OPENAI_API_KEY（或 API_KEY）\n` +
        `- OPENAI_BASE_URL（或 BASE_URL，可选）\n` +
        `- EMBEDDINGS_MODEL_NAME\n`,
    );
  }
  return v;
};

const mustEnvAny = (names, label) => {
  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }
  throw new Error(
    `缺少环境变量 ${label}。\n` + `已尝试读取：${names.join(" / ")}\n`,
  );
};

const optionalEnvAny = (names) => {
  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }
  return undefined;
};

const log = {
  // 这里的 log 只是为了让输出更易读，方便你把“每一步在干嘛”对照到代码
  title: (s) => console.log(chalk.blue("\n" + s)),
  step: (s) => console.log(chalk.yellow("\n" + s)),
  ok: (s) => console.log(chalk.green(s)),
  info: (s) => console.log(chalk.gray(s)),
  out: (s) => console.log(chalk.cyan(s)),
};

async function importMilvusSdkOrExplainAndExit() {
  // Milvus 官方 Node SDK：@zilliz/milvus2-sdk-node
  // 这个项目本身不一定已经安装它，所以这里做一个“友好提示”：
  // - 没装：打印安装命令，然后退出
  // - 已装：正常 import 并返回
  try {
    const sdk = await import("@zilliz/milvus2-sdk-node");
    return sdk;
  } catch (e) {
    console.error(
      [
        "你还没安装 Milvus Node.js SDK，所以这个学习脚本暂时跑不起来。",
        "",
        "先安装依赖（二选一）：",
        "- pnpm add @zilliz/milvus2-sdk-node",
        "- npm i @zilliz/milvus2-sdk-node",
        "",
        "然后再运行：",
        "node src/milvus-test/learn-milvus.mjs",
        "",
        "报错详情：",
        String(e?.message || e),
      ].join("\n"),
    );
    process.exit(1);
  }
}

function makeRandomVector(dim) {
  // 随机向量模式（USE_EMBEDDINGS=0）：
  // - 用来学习 Milvus 的 API 流程最省事
  // - 但随机向量没有语义，search 的结果不具备“文本相似度”意义
  return Array.from({ length: dim }, () => Math.random());
}

async function getEmbeddingVectorsOrRandom({ texts, dim }) {
  // 向量从哪里来：
  // 1) 随机向量（默认）：跑通流程
  // 2) 文本 embedding（USE_EMBEDDINGS=1）：更接近真实 RAG
  //
  // 为什么 dim 重要：
  // - Milvus 的 FloatVector 字段必须声明 dim（维度）
  // - 你插入/搜索时提供的向量长度必须与 dim 完全一致，否则会报错
  const useEmbeddings = env("USE_EMBEDDINGS", "0") === "1";
  if (!useEmbeddings) {
    return {
      mode: "random",
      vectors: texts.map(() => makeRandomVector(dim)),
      dim,
    };
  }

  const apiKey = mustEnvAny(["OPENAI_API_KEY", "API_KEY"], "OpenAI API Key");
  const baseURL = optionalEnvAny(["OPENAI_BASE_URL", "BASE_URL"]);
  const model = mustEnv("EMBEDDINGS_MODEL_NAME");
  const dimensionsRaw = env("VECTOR_DIM", "");
  const dimensions =
    dimensionsRaw && Number.isFinite(Number(dimensionsRaw)) ?
      Number(dimensionsRaw)
    : undefined;

  // 这里复用你项目里已安装的 LangChain OpenAIEmbeddings：
  // - embeddings.embedQuery(text) -> number[]
  // - 对每条文本生成一个向量
  //
  // batchSize：一次请求里同时 embedding 的条数上限（很多兼容 OpenAI 的服务会有限制）
  // 你之前遇到的 “batch size must not be larger than 10” 就是这个原因。
  const embeddings = new OpenAIEmbeddings({
    apiKey,
    model,
    configuration: baseURL ? { baseURL } : undefined,
    batchSize: 10,
    // dimensions：可选。只有部分 embedding 模型支持“降维输出”（例如 text-embedding-3-*）。
    // 如果你的模型不支持这个参数，可能会报错；那就删掉 VECTOR_DIM 环境变量即可。
    ...(dimensions ? { dimensions } : {}),
  });

  // 这里故意用“逐条 embedQuery”，是为了让小白更好理解每一步发生了什么。
  // 真正生产里会更倾向批量 embedding（embedDocuments）以减少网络往返。
  const vectors = [];
  for (const t of texts) {
    const v = await embeddings.embedQuery(t);
    vectors.push(v);
  }

  // embedding 模型输出向量的维度是固定的，所以我们从第一条向量推断 dim。
  // 如果推断失败才回退到传入的 dim。
  const inferredDim = vectors[0]?.length ?? dim;
  return { mode: "embeddings", vectors, dim: inferredDim };
}

async function main() {
  log.title(
    "Milvus 学习脚本：AI 日记向量库（建表 -> 写入 -> 建索引 -> 加载 -> 检索）",
  );

  log.info(
    [
      "前置条件：你需要先把 Milvus 跑起来（你项目里已经有 docker compose 文件）。",
      "常见命令：docker compose -f ./milvus-standalone-docker-compose.yml up -d",
      "",
      "学习目标（对应你给的 diary 示例代码）：",
      "- 用 Milvus 存“日记内容 content 的向量”，并把 date/mood/tags 等字段一起存进去",
      "- 之后你可以：按语义检索相似日记、按时间/心情过滤再检索、做个人知识库/RAG",
    ].join("\n"),
  );

  const { MilvusClient, DataType } = await importMilvusSdkOrExplainAndExit();

  // Milvus 默认端口：
  // - 19530：gRPC 服务端口（SDK 通常连这个）
  // - 9091：健康检查/监控端口（docker compose 里暴露了）
  const address = env("MILVUS_ADDRESS", "127.0.0.1:19530");
  // Collection 名称：可以理解成“表名”
  // 这里默认用你给的示例：ai_diary
  const collectionName = env("MILVUS_COLLECTION", "ai_diary");
  const resetCollection = env("RESET_COLLECTION", "1") === "1";
  const nlist = Number(env("IVF_NLIST", "1024"));
  const nprobe = Number(env("IVF_NPROBE", "16"));
  const topK = Number(env("TOPK", "3"));

  log.step("Step 1/8：连接 Milvus（address=host:port）");
  // MilvusClient 会建立到 Milvus 的连接
  // await client.connectPromise：等待连接完成，避免后续调用出现“client not ready”
  const client = new MilvusClient({ address });
  await client.connectPromise;
  log.ok(`已连接 Milvus：${address}`);

  log.step("Step 2/8：准备“日记数据”（我们会把 content 转向量）");
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

  log.info(
    [
      "这组数据里，只有 content 需要做 embedding（文本 -> 向量）。",
      "其他字段（date/mood/tags）属于“标量字段”，用来：",
      "- 输出展示（告诉你是哪条日记）",
      "- 过滤（例如 mood == 'happy' 只看开心日记）",
    ].join("\n"),
  );

  log.step("Step 3/8：把 content 转为向量（embedding），并确定向量维度 dim");
  log.info(
    [
      "你给的代码里写死 VECTOR_DIM=1024，并把它同时用于：",
      "- Milvus schema 的 dim",
      "- embedding 模型的 dimensions（如果模型支持）",
      "",
      "这里我做了一个更稳的策略：",
      "- 如果 USE_EMBEDDINGS=1：先生成向量，再从结果推断 dim，避免 dim 不一致",
      "- 如果 USE_EMBEDDINGS=0：用随机向量，并用 VECTOR_DIM/DIM 来当 dim",
      "",
      "切换方式：",
      "- USE_EMBEDDINGS=0：只学 Milvus API 流程（不需要 OpenAI 环境变量）",
      "- USE_EMBEDDINGS=1：学“真实语义检索”，需要配置 OPENAI_API_KEY 等",
    ].join("\n"),
  );

  const fallbackDim = Number(env("VECTOR_DIM", env("DIM", "8")));
  const { mode, vectors, dim } = await getEmbeddingVectorsOrRandom({
    texts: diaryContents.map((d) => d.content),
    dim: fallbackDim,
  });
  log.ok(`向量准备完成：mode=${mode} dim=${dim} count=${vectors.length}`);

  log.step("Step 4/8：设计 Schema（表结构）");
  log.info(
    [
      "Milvus 里最核心的是 Collection（可以理解成一张表）。",
      "一张 Collection 至少要有：",
      "- 主键字段（primary key）：Int64 或 VarChar",
      "- 向量字段（vector field）：FloatVector / BinaryVector，必须有固定 dim",
      "",
      "这次我们对齐你的 diary 场景：",
      "- id：VarChar，主键（由你自己指定 diary_001 这种 id）",
      "- vector：FloatVector，存 content 的向量",
      "- content：VarChar，存原文（日记正文）",
      "- date：VarChar，日期字符串（也可以用 Int64 时间戳）",
      "- mood：VarChar，心情标签（用于过滤）",
      "- tags：Array<VarChar>，多标签（用于过滤/分类）",
    ].join("\n"),
  );

  log.step("Step 5/8：创建 Collection（存在则按需删除，便于反复练习）");
  // RESET_COLLECTION=1（默认）：
  // - 如果 collection 已存在就 drop 再重建
  // - 这样你反复跑脚本时不会撞上“schema/dim 不一致”的坑
  //
  // RESET_COLLECTION=0：
  // - 如果已存在就复用（更接近生产）
  const has = await client.hasCollection({ collection_name: collectionName });
  if (has?.value === true) {
    if (resetCollection) {
      log.info(
        `发现同名 collection=${collectionName}，RESET_COLLECTION=1，先删除再重建`,
      );
      await client.dropCollection({ collection_name: collectionName });
    } else {
      log.info(
        `发现同名 collection=${collectionName}，RESET_COLLECTION=0，复用已有集合`,
      );
    }
  }

  if (has?.value !== true || resetCollection) {
    const fields = [
      // 主键字段（Primary Key）：
      // - 你选择 VarChar 主键：适合自定义 ID（diary_001）
      // - 注意：VarChar 主键需要 max_length
      {
        name: "id",
        data_type: DataType.VarChar,
        max_length: 50,
        is_primary_key: true,
        autoID: false,
      },
      // 向量字段（Vector Field）：
      // - content 的 embedding 向量存这里
      // - dim 必须固定；插入/搜索向量长度必须一致
      {
        name: "vector",
        data_type: DataType.FloatVector,
        dim,
      },
      // 标量字段：用来输出/过滤/溯源
      { name: "content", data_type: DataType.VarChar, max_length: 5000 },
      { name: "date", data_type: DataType.VarChar, max_length: 50 },
      { name: "mood", data_type: DataType.VarChar, max_length: 50 },
      // Array 字段：
      // - element_type：数组里每个元素的数据类型（这里是 VarChar）
      // - max_capacity：一个数组最多多少个元素
      // - max_length：当 element_type 是 VarChar 时，必须声明每个元素的最大长度
      {
        name: "tags",
        data_type: DataType.Array,
        element_type: DataType.VarChar,
        max_capacity: 10,
        max_length: 50,
      },
    ];

    await client.createCollection({
      collection_name: collectionName,
      fields,
      enable_dynamic_field: false,
    });
    log.ok(`Collection 已创建：${collectionName}`);
  }

  log.step("Step 6/8：插入日记数据（Insert）并 flush");
  log.info(
    [
      "关键点：你插入的数据对象 key 必须与 schema 字段名一致。",
      "本例每条数据包含：{ id, vector, content, date, mood, tags }",
      "",
      "flush 的意义：",
      "- 把新增数据段从内存写到存储，并让后续建索引/检索更稳定",
    ].join("\n"),
  );

  const diaryData = diaryContents.map((d, i) => ({
    id: d.id,
    vector: vectors[i],
    content: d.content,
    date: d.date,
    mood: d.mood,
    tags: d.tags,
  }));

  const insertResult = await client.insert({
    collection_name: collectionName,
    data: diaryData,
  });
  log.ok(
    `已插入数据（Milvus 返回 insert_cnt=${insertResult?.insert_cnt ?? "unknown"}）`,
  );

  await client.flushSync({ collection_names: [collectionName] });
  log.ok("flush 完成");

  log.step("Step 7/8：创建向量索引（IVF_FLAT + COSINE）并 load");
  log.info(
    [
      "IVF_FLAT 是典型的倒排类索引：",
      "- nlist：把向量空间粗略聚成多少个“桶”（聚类中心）",
      "- nprobe：搜索时探测多少个桶；nprobe 越大召回更好但更慢",
      "",
      "生产里你会根据数据量调参：",
      "- nlist 常与数据规模相关（例如 1e6 级别常用更大的 nlist）",
      "- nprobe 常在 8/16/32/64 这类范围内试",
    ].join("\n"),
  );

  await client.createIndex({
    collection_name: collectionName,
    field_name: "vector",
    index_type: "IVF_FLAT",
    metric_type: "COSINE",
    params: { nlist },
  });
  log.ok("索引创建完成");

  try {
    await client.loadCollectionSync({ collection_name: collectionName });
  } catch {
    await client.loadCollection({ collection_name: collectionName });
  }
  log.ok("load 完成");

  log.step("Step 8/8：语义检索（Search）+ 过滤（filter）");
  log.info(
    [
      "你可以把 search 理解成：",
      "- 输入：query 向量",
      "- 输出：TopK 相似记录（带 score）",
      "",
      "filter 的意义：先用标量条件把候选集缩小，再在候选集做向量检索。",
      "例如：只在 mood == 'happy' 的日记里做语义检索。",
    ].join("\n"),
  );

  const queryText = env("QUERY", "今天心情不错，去户外走走，感觉很放松");
  const queryVectorResult = await getEmbeddingVectorsOrRandom({
    texts: [queryText],
    dim,
  });
  const queryVector = queryVectorResult.vectors[0];

  const baseSearchRequest = {
    collection_name: collectionName,
    limit: topK,
    output_fields: ["id", "date", "mood", "tags", "content"],
    filter: 'mood in ["happy", "relaxed"]',
    params: { nprobe },
  };

  let searchRes;
  try {
    searchRes = await client.search({
      ...baseSearchRequest,
      data: [queryVector],
    });
  } catch {
    try {
      searchRes = await client.search({
        ...baseSearchRequest,
        vectors: [queryVector],
      });
    } catch {
      searchRes = await client.search({
        ...baseSearchRequest,
        vector: queryVector,
      });
    }
  }

  const results = searchRes?.results ?? [];
  log.ok("检索完成，TopK 结果：");
  results.forEach((r, i) => {
    log.out(
      `[Top ${i + 1}] score=${r.score} id=${r.id} date=${r.date} mood=${r.mood} tags=${JSON.stringify(
        r.tags,
      )}\n${r.content}`,
    );
  });

  log.info(
    [
      "",
      "你已经用 diary 场景跑通了 Milvus 的核心闭环。",
      "下一步建议（从易到难）：",
      "1) 把 date 改成 Int64 时间戳，并用范围过滤（date >= ...）",
      "2) 加一个 userId/tenantId 字段，学会多租户隔离（filter + 向量检索）",
      "3) 把检索结果作为 RAG 的 context，让模型总结“近期情绪趋势/工作压力”等",
    ].join("\n"),
  );
}

await main();
