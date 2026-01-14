import "dotenv/config";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { Document } from "@langchain/core/documents";
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";
import chalk from "chalk";

// 1. 初始化大语言模型 (LLM)
// 就像是一个博学多才但记性一般的老师，他能理解和生成语言，但不知道你私有的数据
const model = new ChatOpenAI({
  apiKey: process.env.API_KEY,
  model: process.env.MODEL_NAME,
  temperature: 0, // 设置为 0 表示回答要严谨，不要随意发挥
  configuration: {
    baseURL: process.env.BASE_URL,
  },
});

// 2. 初始化 Embeddings 模型
// 这个模型的作用是把文字变成数字向量（一串数字列表）
// 这样计算机就能通过计算数字之间的距离，来判断两段文字的意思是否相近
const embeddings = new OpenAIEmbeddings({
  apiKey: process.env.API_KEY,
  model: process.env.EMBEDDINGS_MODEL_NAME,
  configuration: {
    baseURL: process.env.BASE_URL,
  },
});

// 3. 准备文档数据
// 这些就是你要教给 AI 的“私有知识”
// 我们把长文章拆分成一个个 Document 对象，方便 AI 检索
const documents = [
  new Document({
    pageContent: `霓虹城的雨夜总是带着酸涩的味道。艾拉拉紧了风衣，在废弃的“铁锈”回收站里翻找着有用的零件。在一堆废弃的工业机械臂下，她发现了一个被锈蚀掩盖的金属躯体——型号是旧时代的“卫士-7型”，但他胸口那个还在微弱闪烁的蓝色核心引起了艾拉的注意。`,
    metadata: {
      chapter: 1,
      character: "艾拉",
      type: "相遇",
      mood: "神秘",
    },
  }),
  new Document({
    pageContent: `艾拉把这个机器人拖回了她的地下工作室，给他取名叫“瑞克斯”。经过三天三夜的修复，瑞克斯终于睁开了光学镜头。令人惊讶的是，他的系统里并没有常见的战斗指令，反而存储着一段加密的高级算法，这让身为黑客的艾拉感到既困惑又兴奋。`,
    metadata: {
      chapter: 2,
      character: "瑞克斯",
      type: "苏醒",
      mood: "好奇",
    },
  }),
  new Document({
    pageContent: `就在艾拉试图破解瑞克斯核心数据的那天晚上，巨头公司“泰坦重工”的巡逻无人机包围了工作室。它们的目标很明确：销毁瑞克斯。瑞克斯的防御协议自动激活，他并没有使用暴力，而是用身体挡住了射向艾拉的激光，并迅速计算出了一条逃生路线。`,
    metadata: {
      chapter: 3,
      character: "艾拉和瑞克斯",
      type: "危机",
      mood: "紧张",
    },
  }),
  new Document({
    pageContent: `在逃亡的路上，艾拉发挥了她的黑客天赋，瘫痪了城市的交通信号灯，制造混乱阻挡追兵。而瑞克斯展现出了惊人的学习能力，他不仅能熟练驾驶悬浮摩托，还在间隙中学会了讲冷笑话来缓解艾拉的紧张情绪。这对奇怪的搭档在霓虹灯影中穿梭，逐渐建立了信任。`,
    metadata: {
      chapter: 4,
      character: "艾拉和瑞克斯",
      type: "逃亡",
      mood: "刺激",
    },
  }),
  new Document({
    pageContent: `根据瑞克斯核心数据的指引，他们来到了位于城市地底的旧时代实验室。在那里，艾拉解开了加密文件：瑞克斯并非普通的战斗机器，而是拥有“情感模拟引擎”的原型机，是为了陪伴人类而设计的。泰坦重工之所以追杀他，是想夺取这项能改变人工智能未来的技术。`,
    metadata: {
      chapter: 5,
      character: "瑞克斯",
      type: "真相",
      mood: "震撼",
    },
  }),
  new Document({
    pageContent: `得知真相的瑞克斯陷入了迷茫，问艾拉自己是否只是程序的产物。艾拉握住他冰冷的机械手说：“如果你只会按程序办事，那天晚上你就不会挡在我面前了。”这番话让瑞克斯的核心闪烁出了前所未有的温暖光芒。他们决定联手，保护这份“灵魂”，并对抗泰坦重工的阴谋。`,
    metadata: {
      chapter: 6,
      character: "艾拉和瑞克斯",
      type: "羁绊",
      mood: "感人",
    },
  }),
  new Document({
    pageContent: `从此，霓虹城多了一对传奇的搭档。艾拉负责在网络世界里收集情报，瑞克斯则在现实世界中提供武力与保护。虽然前路依然充满危险，但只要那个蓝色的核心还在跳动，只要艾拉的键盘还在敲击，属于他们的故事就才刚刚开始。`,
    metadata: {
      chapter: 7,
      character: "艾拉和瑞克斯",
      type: "尾声",
      mood: "充满希望",
    },
  }),
];

// 4. 创建向量数据库 (VectorStore)
// 把上面的文字都喂给 embeddings 模型，变成向量，然后存到内存里
// 就像是把书编好索引，放进图书馆的书架上
const vectorStore = await MemoryVectorStore.fromDocuments(
  documents,
  embeddings
);

// 5. 创建检索器 (Retriever)
// 这是一个帮你找书的图书管理员
// k: 3 表示不管你问什么，他都只给你找最相关的 3 本书
const retriever = vectorStore.asRetriever({ k: 3 });

const questions = ["艾拉经历了什么"];

for (const question of questions) {
  console.log(chalk.blue("=".repeat(80)));
  console.log(chalk.red(`问题：${question}`));
  console.log(chalk.blue("=".repeat(80)));

  // 6. 检索 (Retrieve)
  // 拿着问题去向量数据库里找相关的文档片段
  const retrievedDocs = await retriever.invoke(question);

  // 补充：计算相似度分数
  // 看看找出来的文档和你的问题到底有多像（分数越低越相似，这里做了 1-score 的转换）
  // API 使用方式：调用向量库的 similaritySearchWithScore
  // - 第一个参数 question 是查询问题（会被内部转换成向量）
  // - 第二个参数 3 表示返回最相似的 3 个文档
  // 返回结果类型：Promise<[Document, number][]>
  // - 数组中的每一项是一个二元组 [doc, score]
  // - doc：检索到的 Document 对象（包含 pageContent 和 metadata）
  // - score：相似度距离分数，数值越小表示越相似
  const scoredResults = await vectorStore.similaritySearchWithScore(
    question,
    3
  );

  // 遍历检索器返回的文档列表 retrievedDocs，
  // 为每个文档补充相似度分数和元数据说明
  retrievedDocs.forEach((doc, index) => {
    // scoredResult：从 scoredResults 中找到与当前 doc 匹配的那一项
    // - scoredResult 类型为 [Document, number] | undefined
    // - scoredResult[0] 是 Document，包含 pageContent 和 metadata
    // - scoredResult[1] 是距离分数 score
    const scoredResult = scoredResults.find((scoredDoc) => {
      // 这里通过 pageContent 比较来匹配文档
      return scoredDoc[0].pageContent === doc.pageContent;
    });

    // score：原始距离分数（number），表示“离查询有多远”
    // - 数值越小越好（越相似）
    // - 如果没找到匹配的 scoredResult，则为 null
    const score = scoredResult ? scoredResult[1] : null;

    // similarity：将距离分数转成直观的“相似度”分数
    // - 这里简单用 1 - score 做转换，得到一个 0~1 之间的数
    // - 数值越大表示越相似，并保留 4 位小数方便阅读
    // - 如果没有 score，则显示为 "N/A"
    const similarity = score !== null ? (1 - score).toFixed(4) : "N/A";

    console.log(`\n[文档 ${index + 1}] 相似度: ${similarity}`);
    console.log(`内容: ${doc.pageContent}`);
    // 元数据字段含义说明：
    // - metadata.chapter：章节编号，用来标记故事进度（1、2、3...）
    // - metadata.character：本段故事主要涉及的角色（如“艾拉”“瑞克斯”）
    // - metadata.type：剧情类型或情节标签（如“相遇”“危机”“羁绊”）
    // - metadata.mood：这一段故事的情绪氛围（如“紧张”“感人”“充满希望”）
    console.log(
      `元数据: 章节=${doc.metadata.chapter}, 角色=${doc.metadata.character}, 类型=${doc.metadata.type}, 心情=${doc.metadata.mood}`
    );
  });

  // 7. 构建上下文 (Augment)
  // 把找出来的相关片段拼接起来，作为给 AI 的参考资料
  const context = retrievedDocs
    .map((doc, i) => `[片段${i + 1}]\n${doc.pageContent}`)
    .join("\n\n━━━━━\n\n");

  // 8. 构建 Prompt (提示词)
  // 告诉 AI：你是老师，要根据这些[故事片段]来回答[问题]
  const prompt = `你是一个讲友情故事的老师。基于以下故事片段回答问题，用温暖生动的语言。如果故事中没有提到，就说"这个故事里还没有提到这个细节"。

    故事片段:
    ${context}

    问题: ${question}

    老师的回答:`;

  // 9. 生成回答 (Generate)
  // AI 读了你给的资料，回答你的问题
  console.log("\n【AI 回答】");
  const response = await model.invoke(prompt);
  console.log(response.content);
  console.log("\n");
}
