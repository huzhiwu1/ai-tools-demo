import "dotenv/config";
import { MilvusClient, MetricType } from "@zilliz/milvus2-sdk-node";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import chalk from "chalk";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

// ======================================
// 📋 配置与初始化
// ======================================

const COLLECTION_NAME = "ebook_collection";
const VECTOR_DIM = 1024;
const TOP_K = 5; // 默认返回前5个最相关结果

/**
 * 初始化Chat模型
 * temperature=0.7：平衡创造性与准确性
 * 对于事实性问答，可以适当降低（如0.3）
 */
const chatModel = new ChatOpenAI({
  temperature: 0.7,
  model: process.env.MODEL_NAME || "gpt-3.5-turbo",
  apiKey: process.env.API_KEY,
  configuration: {
    baseURL: process.env.BASE_URL,
  },
});

/**
 * 初始化Embedding模型
 * 使用与索引时相同的模型确保一致性
 */
const embeddings = new OpenAIEmbeddings({
  apiKey: process.env.API_KEY,
  model: process.env.EMBEDDINGS_MODEL_NAME || "text-embedding-3-large",
  configuration: {
    baseURL: process.env.BASE_URL,
  },
  dimensions: VECTOR_DIM,
});

/**
 * Milvus客户端
 * timeout: 防止长时间等待
 */
const client = new MilvusClient({
  address: "localhost:19530",
  timeout: 30000,
});

// ======================================
// 🔧 核心工具函数
// ======================================

/**
 * 生成文本向量
 * 包含重试机制处理API临时失败
 */
async function generateEmbedding(text, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await embeddings.embedQuery(text);
    } catch (error) {
      console.error(
        chalk.red(`Embedding失败 (尝试 ${i + 1}/${retries}): ${error.message}`),
      );
      if (i === retries - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
}

/**
 * 多路召回策略
 * 结合向量相似度与关键词匹配
 */
async function multiWayRetrieval(query, options = {}) {
  const {
    topK = TOP_K,
    filter = null,
    minScore = 0.5, // 最小相似度阈值
  } = options;

  try {
    console.log(chalk.blue("🔍 开始多路召回..."));

    // 1. 向量检索（语义相似度）
    console.log(chalk.gray("向量检索中..."));
    const queryVector = await generateEmbedding(query);

    const vectorResults = await client.search({
      collection_name: COLLECTION_NAME,
      vector: queryVector,
      limit: topK * 2, // 多召回一些用于重排序
      metric_type: MetricType.COSINE,
      output_fields: [
        "id",
        "book_id",
        "book_name",
        "chapter_num",
        "index",
        "content",
      ],
      params: { nprobe: 16 }, // 探测更多聚类中心
      ...(filter && { filter }),
    });

    // 2. 关键词检索（精确匹配）
    console.log(chalk.gray("关键词检索中..."));
    const keywordResults = await keywordSearch(query, filter);

    // 3. 结果融合与重排序
    const fusedResults = await fuseAndRerankResults(
      vectorResults.results || [],
      keywordResults,
      query,
    );

    // 4. 应用相似度阈值过滤
    const filteredResults = fusedResults.filter(
      (result) => result.score >= minScore,
    );

    console.log(
      chalk.green(`✅ 召回完成，找到 ${filteredResults.length} 个相关片段`),
    );
    return filteredResults.slice(0, topK);
  } catch (error) {
    console.error(chalk.red("❌ 多路召回失败:"), error.message);
    throw error;
  }
}

/**
 * 关键词检索
 * 使用Milvus的标量过滤功能
 */
async function keywordSearch(query, filter = null) {
  try {
    // 提取关键词（简单实现，实际可用jieba等分词工具）
    const keywords = extractKeywords(query);

    if (keywords.length === 0) {
      return [];
    }

    // 构建过滤表达式
    const keywordFilters = keywords
      .map((keyword) => `content like "%${keyword}%"`)
      .join(" or ");

    const finalFilter =
      filter ? `(${filter}) and (${keywordFilters})` : keywordFilters;

    // 使用query接口进行关键词搜索
    const results = await client.query({
      collection_name: COLLECTION_NAME,
      filter: finalFilter,
      output_fields: [
        "id",
        "book_id",
        "book_name",
        "chapter_num",
        "index",
        "content",
      ],
      limit: TOP_K * 2,
    });

    // 为关键词搜索结果添加评分（简单按匹配词数）
    return results.data.map((item) => ({
      ...item,
      score: calculateKeywordScore(item.content, keywords),
      source: "keyword",
    }));
  } catch (error) {
    console.warn(chalk.yellow("关键词检索失败，使用向量结果:"), error.message);
    return [];
  }
}

/**
 * 关键词提取
 * 简单实现，实际项目中建议使用专业NLP工具
 */
function extractKeywords(text) {
  // 移除标点符号，提取长度大于2的词
  const words = text
    .replace(/[，。！？；：""''（）【】]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !isStopWord(word));

  // 返回不重复的关键词
  return [...new Set(words)].slice(0, 5); // 最多5个关键词
}

/**
 * 停用词判断
 */
function isStopWord(word) {
  const stopWords = [
    "什么",
    "怎么",
    "为什么",
    "哪里",
    "谁",
    "什么时候",
    "多少",
  ];
  return stopWords.includes(word);
}

/**
 * 计算关键词匹配分数
 */
function calculateKeywordScore(content, keywords) {
  let score = 0;
  keywords.forEach((keyword) => {
    const matches = (content.match(new RegExp(keyword, "g")) || []).length;
    score += matches * (1 / keywords.length); // 归一化
  });
  return Math.min(score, 1.0); // 限制最大分数为1
}

/**
 * 结果融合与重排序
 * 结合向量相似度和关键词匹配度
 */
async function fuseAndRerankResults(vectorResults, keywordResults, query) {
  // 创建结果映射，避免重复
  const resultMap = new Map();

  // 处理向量结果
  vectorResults.forEach((item, index) => {
    const normalizedScore = normalizeScore(item.score, "vector");
    resultMap.set(item.id, {
      ...item,
      score: normalizedScore,
      rank: index,
      source: "vector",
    });
  });

  // 处理关键词结果
  keywordResults.forEach((item) => {
    if (resultMap.has(item.id)) {
      // 如果已存在，提升分数（混合策略）
      const existing = resultMap.get(item.id);
      existing.score = Math.max(existing.score, item.score * 0.8); // 关键词权重稍低
      existing.source = "hybrid";
    } else {
      resultMap.set(item.id, item);
    }
  });

  // 按分数排序
  const fusedResults = Array.from(resultMap.values()).sort(
    (a, b) => b.score - a.score,
  );

  return fusedResults;
}

/**
 * 分数归一化
 * 不同来源的分数统一到0-1范围
 */
function normalizeScore(score, source) {
  switch (source) {
    case "vector":
      // 余弦相似度已经是0-1范围
      return Math.max(0, score);
    case "keyword":
      // 关键词分数已经是0-1范围
      return score;
    default:
      return score;
  }
}

// ======================================
// 💬 RAG问答系统
// ======================================

/**
 * 生成RAG提示词
 * 包含角色设定、任务说明、约束条件
 */
function buildRagPrompt(query, context, metadata) {
  const { totalChunks, avgScore } = metadata;

  return `你是一个专业的《天龙八部》小说知识助手，对小说内容了如指掌。

任务：基于提供的《天龙八部》小说片段，准确、详细地回答用户的问题。

检索信息：
- 检索到 ${totalChunks} 个相关片段
- 平均相似度: ${(avgScore * 100).toFixed(1)}%

参考内容：
${context}

用户问题：${query}

回答要求：
1. **准确性**：只基于提供的片段内容回答，不添加外部知识
2. **完整性**：如果片段信息不完整，请明确说明
3. **引用**：在回答中标注参考的片段编号，如[片段1]
4. **详细性**：尽可能提供具体的情节、人物、时间等细节
5. **诚实性**：如果片段中没有相关信息，请明确告知

请用自然、流畅的语言回答问题，并在回答末尾总结参考了哪些片段。

AI助手回答：`;
}

/**
 * 格式化检索结果
 * 为LLM提供结构化的上下文
 */
function formatContext(results) {
  return results
    .map(
      (item, index) =>
        `[片段${index + 1}] (相似度: ${(item.score * 100).toFixed(1)}%)
章节：第${item.chapter_num}章
内容：${item.content.substring(0, 300)}${item.content.length > 300 ? "..." : ""}`,
    )
    .join("\n\n---\n\n");
}

/**
 * 主RAG问答函数
 */
async function answerQuestion(question, options = {}) {
  const startTime = Date.now();

  try {
    console.log(chalk.blue("\n🎯 开始RAG问答..."));
    console.log(chalk.gray(`问题: ${question}`));

    // 1. 多路召回
    const relevantChunks = await multiWayRetrieval(question, options);

    if (relevantChunks.length === 0) {
      const response =
        "抱歉，我没有找到相关的《天龙八部》内容。这可能是因为：\n" +
        "1. 问题与小说内容无关\n" +
        "2. 相关章节尚未被索引\n" +
        "3. 问题表述需要更具体";

      console.log(chalk.yellow("⚠️ 未找到相关内容"));
      return response;
    }

    // 2. 构建上下文
    const context = formatContext(relevantChunks);
    const metadata = {
      totalChunks: relevantChunks.length,
      avgScore:
        relevantChunks.reduce((sum, item) => sum + item.score, 0) /
        relevantChunks.length,
    };

    // 3. 生成提示词
    const prompt = buildRagPrompt(question, context, metadata);

    // 4. 调用LLM生成回答
    console.log(chalk.gray("生成回答中..."));
    const response = await chatModel.invoke(prompt);

    // 5. 记录性能指标
    const latency = Date.now() - startTime;
    console.log(chalk.green(`✅ 回答生成完成 (${latency}ms)`));

    // 6. 添加引用信息
    const finalAnswer =
      `${response.content}\n\n---\n` +
      `参考片段: ${relevantChunks.map((_, i) => `片段${i + 1}`).join(", ")}\n` +
      `平均相似度: ${(metadata.avgScore * 100).toFixed(1)}%`;

    return finalAnswer;
  } catch (error) {
    console.error(chalk.red("❌ RAG问答失败:"), error.message);
    return "抱歉，处理您的问题时出现错误。请稍后重试或尝试不同的问题。";
  }
}

// ======================================
// 🧪 测试与演示
// ======================================

/**
 * 运行测试用例
 */
async function runTestCases() {
  const testCases = [
    "鸠摩智会什么武功？",
    "段誉的六脉神剑是怎么学会的？",
    "乔峰的身世是什么？",
    "虚竹在灵鹫宫发生了什么？",
    "天龙八部中有哪些主要门派？",
    "王语嫣和慕容复是什么关系？",
  ];

  console.log(chalk.blue("=".repeat(60)));
  console.log(chalk.blue("📚 天龙八部RAG问答系统测试"));
  console.log(chalk.blue("=".repeat(60)));

  for (const [index, question] of testCases.entries()) {
    console.log(chalk.blue(`\n[测试${index + 1}]`));
    const answer = await answerQuestion(question);
    console.log(chalk.green("\n回答:"));
    console.log(answer);
    console.log(chalk.gray("-".repeat(60)));
  }
}

/**
 * 交互式问答模式
 */
async function interactiveMode() {
  console.log(chalk.blue("\n🎤 进入交互式问答模式"));
  console.log(chalk.gray("输入您的问题（输入'quit'退出）:"));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const askQuestion = () => {
    rl.question(chalk.blue("\n您的问题: "), async (question) => {
      if (question.toLowerCase() === "quit") {
        console.log(chalk.green("👋 感谢使用！"));
        rl.close();
        return;
      }

      try {
        const answer = await answerQuestion(question);
        console.log(chalk.green("\n回答:"));
        console.log(answer);
      } catch (error) {
        console.error(chalk.red("错误:"), error.message);
      }

      askQuestion(); // 继续提问
    });
  };

  askQuestion();
}

// ======================================
// 🚀 主函数
// ======================================

async function main() {
  try {
    // 1. 连接Milvus
    console.log(chalk.blue("🔗 连接Milvus..."));
    await client.connectPromise;
    console.log(chalk.green("✅ 连接成功"));

    // 2. 确保集合已加载
    console.log(chalk.blue("📂 检查集合状态..."));
    try {
      await client.loadCollection({ collection_name: COLLECTION_NAME });
      console.log(chalk.green("✅ 集合已加载"));
    } catch (error) {
      if (error.message.includes("already loaded")) {
        console.log(chalk.green("✅ 集合已处于加载状态"));
      } else {
        throw error;
      }
    }

    // 3. 获取运行模式
    const mode = process.env.MODE || "test";

    switch (mode) {
      case "test":
        await runTestCases();
        break;
      case "interactive":
        await interactiveMode();
        break;
      case "single":
        const question = process.env.QUESTION || "鸠摩智会什么武功？";
        const answer = await answerQuestion(question);
        console.log(chalk.green("\n回答:"));
        console.log(answer);
        break;
      default:
        console.log(chalk.yellow(`未知模式: ${mode}, 使用测试模式`));
        await runTestCases();
    }
  } catch (error) {
    console.error(chalk.red("❌ 系统启动失败:"), error.message);
    process.exit(1);
  }
}

// 全局错误处理
process.on("unhandledRejection", (reason, promise) => {
  console.error(chalk.red("未处理的Promise拒绝:"), reason);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  console.error(chalk.red("未捕获的异常:"), error);
  process.exit(1);
});

// 启动
const isEntry =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntry) {
  main().catch(console.error);
}

export { answerQuestion, multiWayRetrieval };
