import "dotenv/config";
import { existsSync } from "fs";
import { dirname, join, parse } from "path";
import { fileURLToPath } from "url";
import {
  MilvusClient,
  DataType,
  MetricType,
  IndexType,
} from "@zilliz/milvus2-sdk-node";
import { OpenAIEmbeddings } from "@langchain/openai";
import { EPubLoader } from "@langchain/community/document_loaders/fs/epub";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import chalk from "chalk";

// ======================================
// 📋 配置参数详解
// ======================================
const COLLECTION_NAME = "ebook_collection";
const VECTOR_DIM = 1024; // 向量维度：平衡精度与性能
const CHUNK_SIZE = 500; // 分块大小：保持语义完整性
const CHUNK_OVERLAP = 50; // 重叠：防止上下文断裂
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EPUB_FILE = process.env.EPUB_FILE || join(SCRIPT_DIR, "天龙八部.epub");
const BOOK_NAME = parse(EPUB_FILE).name;

// 性能调优参数
const BATCH_SIZE = 50; // 批量处理大小
const MAX_CONCURRENT_EMBEDDINGS = 10; // 并发限制

// ======================================
// 🎯 核心组件初始化
// ======================================

/**
 * 初始化Embedding模型
 * 为什么选择text-embedding-3-large：
 * - 1024维向量在大多数场景下足够表达语义
 * - 相比1536维，存储和计算成本降低33%
 * - 支持多语言，适合中文小说
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
 * 为什么是Milvus：
 * - 专为向量检索优化，性能比传统数据库高10-100倍
 * - 支持十亿级向量，水平扩展能力强
 * - 丰富的索引类型（IVF、HNSW、DiskANN等）
 */
const client = new MilvusClient({
  address: "localhost:19530",
  timeout: 30000, // 30秒超时
});

// ======================================
// 🔧 工具函数
// ======================================

/**
 * 获取文本向量
 * 包含重试机制和错误处理
 */
async function getEmbedding(text, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await embeddings.embedQuery(text);
      return result;
    } catch (error) {
      console.error(
        chalk.red(`Embedding失败 (尝试 ${i + 1}/${retries}): ${error.message}`),
      );
      if (i === retries - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1))); // 指数退避
    }
  }
}

/**
 * 智能集合管理
 * 包含存在性检查、索引创建、加载状态管理
 */
async function ensureCollection(bookId) {
  try {
    console.log(chalk.blue("🔍 检查集合状态..."));

    // 检查集合是否存在
    const hasCollection = await client.hasCollection({
      collection_name: COLLECTION_NAME,
    });

    if (!hasCollection.value) {
      console.log(chalk.yellow("📦 创建新集合..."));

      /**
       * 集合Schema设计原理：
       * - id: 主键，格式 book_chapter_chunk，保证全局唯一
       * - book_id: 书籍标识，支持多本书籍管理
       * - chapter_num: 章节号，支持章节级过滤
       * - index: 块序号，支持精确定位
       * - content: 文本内容，限制10k字符防止超大块
       * - vector: 向量字段，使用COSINE相似度
       */
      await client.createCollection({
        collection_name: COLLECTION_NAME,
        fields: [
          {
            name: "id",
            data_type: DataType.VarChar,
            max_length: 100,
            is_primary_key: true,
            description: "主键：book_chapter_chunk",
          },
          {
            name: "book_id",
            data_type: DataType.VarChar,
            max_length: 100,
            description: "书籍ID",
          },
          {
            name: "book_name",
            data_type: DataType.VarChar,
            max_length: 200,
            description: "书籍名称",
          },
          {
            name: "chapter_num",
            data_type: DataType.Int32,
            description: "章节号",
          },
          {
            name: "index",
            data_type: DataType.Int32,
            description: "块序号",
          },
          {
            name: "content",
            data_type: DataType.VarChar,
            max_length: 10000,
            description: "文本内容",
          },
          {
            name: "vector",
            data_type: DataType.FloatVector,
            dim: VECTOR_DIM,
            description: "文本向量",
          },
        ],
      });

      console.log(chalk.green("✅ 集合创建成功"));

      /**
       * 索引策略：
       * - IVF_FLAT: 平衡精度和召回率
       * - nlist=1024: 基于天龙八部约1000个分块，每个聚类中心约1个块
       * - COSINE: 适合文本语义相似度
       *
       * 其他选择：
       * - HNSW: 内存占用大，但搜索更快
       * - DiskANN: 超大数据集，支持磁盘存储
       */
      console.log(chalk.yellow("🔍 创建向量索引..."));
      await client.createIndex({
        collection_name: COLLECTION_NAME,
        field_name: "vector",
        index_type: IndexType.IVF_FLAT,
        metric_type: MetricType.COSINE,
        params: { nlist: 1024 },
      });
      console.log(chalk.green("✅ 索引创建成功"));
    } else {
      console.log(chalk.green("✅ 集合已存在"));
    }

    // 集合加载策略
    console.log(chalk.blue("📂 加载集合..."));
    try {
      await client.loadCollection({ collection_name: COLLECTION_NAME });
      console.log(chalk.green("✅ 集合加载成功"));
    } catch (error) {
      // 处理已加载的情况
      if (
        error.message.includes("already loaded") ||
        error.message.includes("AlreadyLoaded")
      ) {
        console.log(chalk.green("✅ 集合已处于加载状态"));
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error(chalk.red("❌ 集合管理失败:"), error.message);
    throw error;
  }
}

// ======================================
// 📖 文本处理与向量化
// ======================================

/**
 * 智能文本分块
 * 为什么选择RecursiveCharacterTextSplitter：
 * - 递归分割：优先按段落→句子→词语边界
 * - 保持语义完整性：避免在句子中间切断
 * - 重叠设计：防止关键信息丢失
 */
function createTextSplitter() {
  return new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
    separators: ["\n\n", "\n", "。", "！", "？", "，", " ", ""], // 中文优化
  });
}

/**
 * 批量向量生成与插入
 * 包含并发控制、进度显示、错误恢复
 */
async function processBatch(chunks, bookId, chapterNum, startIndex) {
  const results = [];

  // 进度条显示
  const progressBar = {
    total: chunks.length,
    current: 0,
    update() {
      this.current++;
      const percentage = Math.round((this.current / this.total) * 100);
      const bar =
        "█".repeat(Math.round(percentage / 5)) +
        "░".repeat(20 - Math.round(percentage / 5));
      process.stdout.write(
        `\r${bar} ${percentage}% (${this.current}/${this.total})`,
      );
    },
  };

  try {
    // 控制并发数，避免API限流
    const semaphore = new Semaphore(MAX_CONCURRENT_EMBEDDINGS);

    const embeddingPromises = chunks.map(async (chunk, i) => {
      await semaphore.acquire();
      try {
        const vector = await getEmbedding(chunk);
        progressBar.update();

        return {
          id: `${bookId}_${chapterNum}_${startIndex + i}`,
          book_id: String(bookId),
          book_name: BOOK_NAME,
          chapter_num: chapterNum,
          index: startIndex + i,
          content: chunk,
          vector: vector,
        };
      } finally {
        semaphore.release();
      }
    });

    const batchResults = await Promise.allSettled(embeddingPromises);

    // 统计成功与失败
    const successful = batchResults
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value);

    const failed = batchResults
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);

    if (failed.length > 0) {
      console.warn(chalk.yellow(`\n⚠️  ${failed.length}个向量生成失败`));
    }

    return successful;
  } catch (error) {
    console.error(chalk.red(`\n❌ 批处理失败: ${error.message}`));
    throw error;
  } finally {
    process.stdout.write("\n"); // 换行
  }
}

/**
 * 信号量并发控制
 * 防止同时请求过多embedding API
 */
class Semaphore {
  constructor(maxConcurrent) {
    this.maxConcurrent = maxConcurrent;
    this.current = 0;
    this.waiters = [];
  }

  async acquire() {
    if (this.current < this.maxConcurrent) {
      this.current++;
      return;
    }

    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release() {
    this.current--;
    if (this.waiters.length > 0) {
      const resolve = this.waiters.shift();
      this.current++;
      resolve();
    }
  }
}

// ======================================
// 📚 主处理流程
// ======================================

/**
 * 主处理函数
 * 完整的电子书处理管道
 */
async function processEbook(bookId) {
  console.log(chalk.blue("📖 开始处理电子书..."));
  console.log(chalk.gray(`文件: ${EPUB_FILE}`));
  console.log(chalk.gray(`分块大小: ${CHUNK_SIZE}字符`));
  console.log(chalk.gray(`重叠: ${CHUNK_OVERLAP}字符`));
  console.log(chalk.gray(`批量大小: ${BATCH_SIZE}`));
  if (!existsSync(EPUB_FILE)) {
    throw new Error(
      [
        `Invalid/missing file ${EPUB_FILE}`,
        `提示：当前工作目录 cwd=${process.cwd()}`,
        "解决方案：",
        `- 确认文件存在：${join(SCRIPT_DIR, "天龙八部.epub")}`,
        `- 或运行时指定：EPUB_FILE="/绝对路径/天龙八部.epub" node src/ebook-rag/ebook-writer-enhanced.mjs`,
      ].join("\n"),
    );
  }

  try {
    // 1. 加载EPUB文件
    console.log(chalk.blue("\n📥 加载EPUB文件..."));
    const loader = new EPubLoader(EPUB_FILE, {
      splitChapters: true,
    });

    const documents = await loader.load();
    console.log(chalk.green(`✅ 加载完成，共${documents.length}个章节`));

    // 2. 创建文本分块器
    const textSplitter = createTextSplitter();

    let totalChunks = 0;
    let totalInserted = 0;

    // 3. 逐章节处理
    for (
      let chapterIndex = 0;
      chapterIndex < documents.length;
      chapterIndex++
    ) {
      const chapter = documents[chapterIndex];
      const chapterNum = chapterIndex + 1;

      console.log(
        chalk.blue(
          `\n📄 处理第${chapterNum}/${documents.length}章: ${chapter.metadata.title || "未知标题"}`,
        ),
      );

      // 文本分块
      const chunks = await textSplitter.splitText(chapter.pageContent);
      console.log(chalk.gray(`拆分为${chunks.length}个片段`));

      if (chunks.length === 0) {
        console.log(chalk.yellow("跳过空章节"));
        continue;
      }

      // 批量处理
      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batchChunks = chunks.slice(i, i + BATCH_SIZE);
        const batchStartIndex = i;

        console.log(
          chalk.blue(
            `处理批次 ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(chunks.length / BATCH_SIZE)}`,
          ),
        );

        try {
          // 生成向量并构建数据
          const batchData = await processBatch(
            batchChunks,
            bookId,
            chapterNum,
            batchStartIndex,
          );

          if (batchData.length > 0) {
            // 插入Milvus
            const insertResult = await client.insert({
              collection_name: COLLECTION_NAME,
              data: batchData,
            });

            const insertedCount = Number(insertResult.insert_cnt) || 0;
            totalInserted += insertedCount;

            console.log(chalk.green(`✅ 插入${insertedCount}条记录`));
          }
        } catch (error) {
          console.error(chalk.red(`批次处理失败: ${error.message}`));
          // 可以选择继续处理下一个批次，或抛出错误
          // throw error; // 停止整个处理
          console.log(chalk.yellow("继续处理下一个批次..."));
        }
      }

      totalChunks += chunks.length;
    }

    // 4. 数据持久化
    console.log(chalk.blue("\n💾 持久化数据..."));
    await client.flushSync({ collection_names: [COLLECTION_NAME] });
    console.log(chalk.green("✅ 数据持久化完成"));

    // 5. 统计报告
    console.log(chalk.green("\n📊 处理完成统计:"));
    console.log(chalk.gray(`总章节数: ${documents.length}`));
    console.log(chalk.gray(`总分块数: ${totalChunks}`));
    console.log(chalk.gray(`成功插入: ${totalInserted}`));
    console.log(
      chalk.gray(
        `成功率: ${((totalInserted / totalChunks) * 100).toFixed(1)}%`,
      ),
    );

    return {
      totalChapters: documents.length,
      totalChunks: totalChunks,
      insertedChunks: totalInserted,
      successRate: (totalInserted / totalChunks) * 100,
    };
  } catch (error) {
    console.error(chalk.red("\n❌ 电子书处理失败:"), error.message);
    throw error;
  }
}

// ======================================
// 🚀 主函数
// ======================================

/**
 * 主函数
 * 完整的错误处理和状态管理
 */
async function main() {
  const startTime = Date.now();

  console.log(chalk.blue("=".repeat(60)));
  console.log(chalk.blue("📚 天龙八部电子书向量化系统"));
  console.log(chalk.blue("=".repeat(60)));

  try {
    // 1. 连接Milvus
    console.log(chalk.blue("\n🔗 连接Milvus..."));
    await client.connectPromise;
    console.log(chalk.green("✅ Milvus连接成功"));

    // 2. 确保集合就绪
    const bookId = 1; // 天龙八部ID
    await ensureCollection(bookId);

    // 3. 处理电子书
    const stats = await processEbook(bookId);

    // 4. 完成报告
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(chalk.green("\n🎉 处理完成!"));
    console.log(chalk.gray(`总耗时: ${duration}秒`));
    console.log(
      chalk.gray(
        `平均速度: ${(stats.insertedChunks / duration).toFixed(1)}块/秒`,
      ),
    );
  } catch (error) {
    console.error(chalk.red("\n💥 处理失败:"), error.message);
    console.error(chalk.red("错误栈:"), error.stack);
    process.exit(1);
  } finally {
    // 清理资源
    await client.close();
    console.log(chalk.blue("\n👋 资源清理完成"));
  }
}

// ======================================
// 📞 错误处理与监控
// ======================================

/**
 * 全局错误处理
 */
process.on("unhandledRejection", (reason, promise) => {
  console.error(chalk.red("未处理的Promise拒绝:"), reason);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  console.error(chalk.red("未捕获的异常:"), error);
  process.exit(1);
});

// 启动
main().catch(console.error);
