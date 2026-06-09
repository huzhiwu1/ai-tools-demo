import "dotenv/config";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { Annotation, START, END, StateGraph } from "@langchain/langgraph";
import chalk from "chalk";
import { Milvus } from "@langchain/community/vectorstores/milvus";
import { COLLECTION_NAME, MILVUS_ADDRESS } from "./constants.mjs";
import { IndexType, MetricType } from "@zilliz/milvus2-sdk-node";

const model = new ChatOpenAI({
  modelName: process.env.MODEL_NAME,
  temperature: 0,
  apiKey: process.env.API_KEY,
  configuration: { baseURL: process.env.BASE_URL },
});

const embeddings = new OpenAIEmbeddings({
  modelName: process.env.EMBEDDINGS_MODEL_NAME,
  temperature: 0,
  apiKey: process.env.API_KEY,
  configuration: {
    baseURL: process.env.BASE_URL,
  },
});

const generateNode = async (state) => {
  const context = state.documents
    .map(
      (item, i) =>
        `【片段${i + 1}】. 章节：第${item.chapter_num}章，内容：${item.content}`,
    )
    .join("\n\n--------\n\n");

  const prompt = `你是一个专业的《天龙八部》小说助手。基于小说内容回答问题，用准确、详细的语言。

请根据以下《天龙八部》小说片段内容回答问题：
${context}

用户问题: ${state.question}

回答要求：
1. 如果片段中有相关信息，请结合小说内容给出详细、准确的回答
2. 可以综合多个片段的内容，提供完整的答案
3. 如果片段中没有相关信息，请如实告知用户
4. 回答要准确，符合小说的情节和人物设定
5. 可以引用原文内容来支持你的回答

AI 助手的回答:`;

  process.stdout.write("\n 【AI回答（流式）】\n");

  let generation = "";
  const stream = await model.stream(prompt);

  for await (const chunk of stream) {
    const text = typeof chunk?.content === "string" ? chunk.content : "";
    if (!text) {
      continue;
    }
    process.stdout.write(text);
    generation += text;
  }
  return {
    generation,
  };
};
const GraphState = Annotation.Root({
  question: Annotation,
  k: Annotation,
  documents: Annotation,
  generation: Annotation,
});

let vectorStore;

async function retrieveRelevantContent(question, k) {
  try {
    const docWithScore = await vectorStore.similaritySearchWithScore(
      question,
      k,
    );
    return docWithScore.map(([doc, score]) => {
      return {
        score,
        content: doc.pageContent,
        id: doc.metadata?.id ?? "unknown",
        book_id: doc.metadata?.book_id ?? "未知",
        chapter_num: doc.metadata?.chapter_num ?? "未知",
        index: doc.metadata?.index ?? "未知",
      };
    });
  } catch (error) {
    console.error(`Error retrieving relevant content: ${error}`);
    return [];
  }
}

async function retrieveNode(state) {
  const documents = await retrieveRelevantContent(state.question, state.k);
  return { documents: documents };
}

const graph = new StateGraph(GraphState)
  .addNode("generate", generateNode)
  .addNode("retrieve", retrieveNode)
  .addEdge(START, "retrieve")
  .addEdge("retrieve", "generate")
  .addEdge("generate", END)
  .compile();

async function main() {
  try {
    vectorStore = await Milvus.fromExistingCollection(embeddings, {
      collectionName: COLLECTION_NAME,
      url: MILVUS_ADDRESS,
      textField: "content",
      primaryField: "id",
      vectorField: "vector",
      indexCreateOptions: {
        metric_type: MetricType.COSINE,
        index_type: IndexType.HNSW,
        params: { M: 16, efConstruction: 200 },
        search_params: { ef: 64 },
      },
    });

    vectorStore.indexSearchParams = {
      metric_type: MetricType.COSINE,
      params: JSON.stringify({ ef: 64 }),
    };
    console.log(chalk.blue("✓ 已连接 Milvus\n"));
    try {
      await vectorStore.client.loadCollection({
        collection_name: COLLECTION_NAME,
      });
      console.log(`✓ 集合 ${COLLECTION_NAME} 已加载\n`);
    } catch (error) {
      if (!error.message.includes("already loaded")) {
        throw error;
      }
      console.log(`✓ 集合 ${COLLECTION_NAME} 已处于加载状态\n`);
    }

    const result = await graph.invoke({
      question: "啊朱的结局是什么？",
      k: 3,
    });
  } catch (err) {}
}

main();
