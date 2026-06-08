import {
  MilvusClient,
  DataType,
  IndexType,
  MetricType,
} from "@zilliz/milvus2-sdk-node";
import chalk from "chalk";
import {
  COLLECTION_NAME,
  MILVUS_ADDRESS,
  VECTOR_DIM,
  EPUB_FILE,
  CHUNK_SIZE,
  CHUNK_OVERLAP,
  BOOKID,
} from "./constants.mjs";
import { EPubLoader } from "@langchain/community/document_loaders/fs/epub";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import "dotenv/config";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";

const embeddings = new OpenAIEmbeddings({
  model: process.env.EMBEDDINGS_MODEL_NAME,
  apiKey: process.env.API_KEY,
  temperature: 0,
  configuration: {
    baseURL: process.env.BASE_URL,
  },
});

const llm = new ChatOpenAI({
  model: process.env.MODEL_NAME,
  apiKey: process.env.API_KEY,
  temperature: 0,
  configuration: {
    baseURL: process.env.BASE_URL,
  },
});

function milvusClient() {
  return new MilvusClient({
    address: MILVUS_ADDRESS,
  });
}

async function ensureCollection(client) {
  try {
    const hasCollection = await client.hasCollection({
      collection_name: COLLECTION_NAME,
    });

    if (!hasCollection.value) {
      console.log(chalk.blue("集合不存在，正在创建集合"));
      await client.createCollection({
        collection_name: COLLECTION_NAME,
        fields: [
          {
            name: "id",
            data_type: DataType.VarChar,
            max_length: 100,
            is_primary_key: true,
            auto_id: false,
          },
          {
            name: "id",
            data_type: DataType.VarChar,
            max_length: 100,
          },
          {
            name: "book_name",
            data_type: DataType.VarChar,
            max_length: 200,
          },
          {
            name: "content",
            data_type: DataType.VarChar,
            max_length: 10000,
          },
          {
            name: "chapter_num",
            data_type: DataType.Int64,
            default_value: 0,
          },
          {
            name: "index",
            data_type: DataType.Int64,
            default_value: 0,
          },
          {
            name: "vector",
            data_type: DataType.FloatVector,
            dim: VECTOR_DIM,
          },
        ],
      });

      console.log(chalk.blue("集合创建成功"));
      console.log(chalk.blue("正在创建索引..."));
      await client.createIndex({
        collection_name: COLLECTION_NAME,
        field_name: "vector",
        index_type: IndexType.IVF_FLAT,
        params: { nlist: VECTOR_DIM },
        metric_type: MetricType.COSINE,
      });
      console.log(chalk.blue("索引创建成功"));
    }

    try {
      await client.loadCollection({ collection_name: COLLECTION_NAME });
      console.log(chalk.blue("集合加载成功"));
    } catch (error) {
      console.log(chalk.blue("集合加载失败"));
    }
  } catch (error) {
    console.log(chalk.blue("集合已存在"));
  }
}

async function loadAndProcessEPUBStreaming(bookId, client) {
  try {
    console.log("开始加载EPUB 文件" + EPUB_FILE);

    const loader = new EPubLoader(EPUB_FILE, {
      splitChapters: true,
    });

    const documents = await loader.load();
    console.log(chalk.blue(`加载完成 共${documents.length}章`));

    const textSplitter = new RecursiveCharacterTextSplitter({
      chunkSize: CHUNK_SIZE,
      chunkOverlap: CHUNK_OVERLAP,
    });

    let totlalInserterd = 0;

    for (
      let chapterIndex = 0;
      chapterIndex < documents.length;
      chapterIndex++
    ) {
      const chapter = documents[chapterIndex];
      console.log(
        chalk.blue(
          `处理第${chapterIndex + 1}/${documents.length}章 ${chapter.metadata}`,
        ),
      );

      const chunks = await textSplitter.splitText(chapter.pageContent);
      console.log(chalk.blue(`拆分为${chunks.length}个片段`));
      if (chunks.length === 0) {
        console.log(chalk.blue("跳过空章节"));
        continue;
      }
      const insertedCount = await insertChunksBatch(
        chunks,
        bookId,
        chapterIndex,
        client,
      );
      totlalInserterd += insertedCount;
      console.log(chalk.blue(`已插入${totlalInserterd}条数据`));
      return totlalInserterd;
    }
  } catch (error) {
    console.log(chalk.blue("加载和处理 EPUB 流式传输失败" + error));
  }
}

async function getEmbedding(chunk) {
  return await embeddings.embedQuery(chunk);
}
async function insertChunksBatch(chunks, bookId, chapterNum, client) {
  try {
    if (chunks.length === 0) {
      return 0;
    }
    const insertData = await Promise.all(
      chunks.map(async (chunk, index) => {
        const vector = await getEmbedding(chunk);
        console.log(chalk.blue(`处理第${index + 1}/${chunks.length}数据块`));
        return {
          id: `${bookId}_${chapterNum}_${index}`,
          book_name: "天龙八部",
          content: chunk,
          chapter_num: chapterNum,
          index: index,
          vector: vector,
        };
      }),
    );

    const insertResult = await client.insert({
      collection_name: COLLECTION_NAME,
      data: insertData,
    });
    console.log(chalk.blue(`插入批次成功 ${insertResult.insert_cnt}`));
    return Number(insertResult.insert_cnt) || 0;
  } catch (error) {
    console.log(chalk.blue("插入批次失败" + error));
  }
}

async function main() {
  console.log(chalk.blue("启动程序，开始写入天龙八部的书籍到数据库"));
  const client = milvusClient();
  await client.connectPromise;
  console.log(chalk.blue("已连接到 Milvus"));
  await ensureCollection(client);

  await loadAndProcessEPUBStreaming(BOOKID, client);
}

main();
