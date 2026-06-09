import "dotenv/config";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { Annotation, START, END, StateGraph } from "@langchain/langgraph";
import chalk from "chalk";
import { Milvus } from "@langchain/community/vectorstores/milvus";
import { COLLECTION_NAME, MILVUS_ADDRESS } from "./constants.mjs";
import { IndexType, MetricType } from "@zilliz/milvus2-sdk-node";
import { z } from "zod";

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
  gradeResult: Annotation,
  strategy: Annotation,
  routeReason: Annotation,
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

const GradeSchema = z.object({
  passed: z
    .boolean()
    .describe("回答质量是否过关，是否有据可依,true表示过关,false表示不过关"),
  reason: z.string().describe("评估理由，说明通过或不通过的原因"),
});

async function grade(state) {
  const { documents, generation, strategy } = state;
  const modelWithSchema = model.withStructuredOutput(GradeSchema);
  let result = "";

  if (strategy === "simple") {
    result = await modelWithSchema.invoke(
      `你是回答质量评估器。请判断回答是否合理、准确。

评估标准：
- passed=true: 回答内容是合理的常识，没有明显错误
- passed=false: 回答有明显错误或胡说八道

用户问题: ${state.question}

生成的回答: ${generation}
`,
    );
  } else {
    result = await modelWithSchema.invoke(
      `你是回答质量评估器。请判断生成的回答是否基于检索到的文档内容，是否存在编造。

评估标准：
- passed=true: 回答内容能在检索文档中找到依据，没有编造
- passed=false: 回答包含检索文档中找不到的内容，或与文档矛盾

【引用片段：】${documents?.map?.((doc) => doc.content).join("\n\n--------\n\n")}

【用户问题】: ${state.question}

【回答】: ${generation}
`,
    );
  }

  return {
    gradeResult: result,
  };
}

const RouteSchema = z.object({
  strategy: z
    .enum(["simple", "complex"])

    .describe("判断是走检索流程还是直接回答"),
  reason: z.string().describe("判断理由"),
});

const routeNode = async (state) => {
  const { question } = state;
  const prompt = `你是问答路由器。请判断用户问题是否需要检索小说内容。

规则：
- simple: 常识问答、简短定义、无需小说细节即可回答（如"1+1等于几"）
- complex: 需要《天龙八部》具体情节、人物关系、章节事实等小说细节才能回答（如"阿朱的结局"）

用户问题: ${question}
`;
  const modelWithSchema = model.withStructuredOutput(RouteSchema);

  const result = await modelWithSchema.invoke(prompt);
  console.log(chalk.blue("【路由判断】", result));
  return {
    strategy: result.strategy,
    routeReason: result.reason,
  };
};

const directAnswerNode = async (state) => {
  console.log(chalk.blue("【AI直接回答】"));
  const { question } = state;
  const prompt = `你是一个专业的助手。请根据用户问题，直接回答问题。
  用户问题: ${question}
`;
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
    generation: generation,
  };
};

const graph = new StateGraph(GraphState)
  .addNode("generate", generateNode)
  .addNode("retrieve", retrieveNode)
  .addNode("directAnswer", directAnswerNode)
  .addNode("grade", grade)
  .addNode("route", routeNode)
  .addEdge(START, "route")
  .addConditionalEdges("route", (state) => state.strategy, {
    simple: "directAnswer",
    complex: "retrieve",
  })

  .addEdge("retrieve", "generate")
  .addEdge("generate", "grade")
  .addEdge("directAnswer", "grade")
  .addEdge("grade", END)
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
      question: "1+1等于几",
      k: 3,
    });

    console.log(
      chalk.blue(
        `【回答质量评估】: 是否过关 ：${result.gradeResult.passed}，理由：${result.gradeResult.reason}`,
      ),
    );

    const result2 = await graph.invoke({
      question: "《天龙八部》的作者是谁？",
      k: 3,
    });
    console.log(
      chalk.blue(
        `【回答质量评估】: 是否过关 ：${result2.gradeResult.passed}，理由：${result2.gradeResult.reason}`,
      ),
    );
  } catch (err) {
    console.error(err);
  }
}

main();
