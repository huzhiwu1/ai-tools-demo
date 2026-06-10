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
  subQuestions: Annotation,
  retrievalCount: Annotation,
  nextSubIdx: Annotation,
  maxRetrievals: Annotation({ defaultValue: 10 }),
  nextAction: Annotation,
});

let vectorStore;

const DecomposeQuestionSchema = z.object({
  subQuestions: z
    .array(z.string())
    .min(1)
    .max(10)
    .describe("有序子问题列表，每条必须是可独立检索的完整问句，禁止代词"),
  reason: z.string().describe("分解子问题的理由"),
});

const decomposeQuestionNode = async (state) => {
  const { question } = state;
  const prompt = `你是《天龙八部》多跳问答的「子问题拆解器」。

用户原始问题：
${question}

任务：将问题拆成有序子问题列表 subQuestions，用于依次向量检索。要求：
1. 链式推理、多层关系、因果先后的问题，必须拆成多条；单跳即可答的也可只输出 1 条。
2. 每条子问题必须是可独立检索的完整中文问句，禁止使用「他/她/此人/上文」等指代；可写全人物名与事件名。
3. 顺序必须符合推理链：先搞清前置实体/事实，再查后续结论。
4. 不要把整句原题原样复制成唯一一条（除非确实无法拆分）；不要拆成过碎的关键词列表。
5. 输出 1～8 条即可。

请输出 subQuestions 与简短 reason。`;

  const modelWithSchema = model.withStructuredOutput(DecomposeQuestionSchema);
  const result = await modelWithSchema.invoke(prompt);

  const subQuestions = result.subQuestions
    .map((subQuestion) => subQuestion.trim())
    .filter(Boolean);

  if (subQuestions.length === 0) {
    throw new Error("子问题列表不能为空");
  }
  subQuestions.forEach((subQuestion, i) => {
    console.log(`子问题 ${i + 1}: ${subQuestion}`);
  });

  return {
    subQuestions: subQuestions,
    nextSubIdx: 0,
    retrievalCount: 0,
    documents: [],
  };
};

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

function mergeUnique(existingDocs, newDocs) {
  const map = new Map();
  for (const doc of [...existingDocs, ...newDocs]) {
    const key = String(doc.id);
    const pre = map.get(key);

    if (!pre || Number(doc.score) > Number(pre.score)) {
      map.set(key, doc);
    }
  }
  return Array.from(map.values()).sort(
    (a, b) => Number(b.score) - Number(a.score),
  );
}

const PlanNextSchema = z.object({
  nextAction: z.enum(["retrieve", "generate"]).describe("下一步动作"),
  reason: z.string().describe("下一步动作的理由"),
});

const planNextNode = async (state) => {
  const {
    nextSubIdx,
    retrievalCount,
    question,
    subQuestions,
    maxRetrievals,
    documents,
  } = state;

  const remaining = subQuestions.length - nextSubIdx;

  const prompt = `你是多跳 RAG 规划器。

用户原始问题：${question}

子问题序列：
${subQuestions.map((s, i) => `${i + 1}. ${s}${i < nextSubIdx ? " （已检索）" : i === nextSubIdx ? " （下一轮将检索）" : " （未检索）"}`).join("\n")}

已检索轮数：${retrievalCount}；剩余未检索：${remaining}；上限：${maxRetrievals}

已召回文档数：${documents.length}

请判断下一步：retrieve（继续检索）还是 generate（开始生成）？`;

  const modelWithSchema = model.withStructuredOutput(PlanNextSchema);
  const { nextAction, reason } = await modelWithSchema.invoke(prompt);

  let finalNext = nextAction;
  if (retrievalCount >= maxRetrievals) finalNext = "generate";
  if (remaining <= 0) finalNext = "generate";

  console.log(chalk.blue(`【规划下一步】: ${finalNext}，理由：${reason}`));
  return {
    nextAction: finalNext,
  };
};

async function retrieveNode(state) {
  const { nextSubIdx, retrievalCount, subQuestions } = state;
  const question = subQuestions[nextSubIdx];

  if (!question) {
    throw new Error(`子问题下标:${nextSubIdx}，子问题不存在`);
  }
  console.log(chalk.blue(`【检索问题】: ${question}`));

  const newDocuments = await retrieveRelevantContent(question, state.k);

  const mergedDocuments = mergeUnique(state.documents, newDocuments);

  console.log(
    chalk.blue(
      `【检索结果】: ${newDocuments.length}条文档 合并去重后${mergedDocuments.length}条文档`,
    ),
  );

  return {
    documents: mergedDocuments,
    nextSubIdx: nextSubIdx + 1,
    retrievalCount: retrievalCount + 1,
  };
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
  console.log(chalk.blue("【路由判断】", JSON.stringify(result)));
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

function afterRoute(state) {
  return state.strategy === "simple" ? "directAnswer" : "decomposeQuestion";
}

function afterPlanNext(state) {
  return state.nextAction === "retrieve" ? "retrieve" : "generate";
}
const graph = new StateGraph(GraphState)
  .addNode("generate", generateNode)
  .addNode("retrieve", retrieveNode)
  .addNode("directAnswer", directAnswerNode)
  .addNode("grade", grade)
  .addNode("route", routeNode)
  .addNode("planNext", planNextNode)
  .addNode("decomposeQuestion", decomposeQuestionNode)
  .addEdge(START, "route")
  .addConditionalEdges("route", afterRoute, {
    directAnswer: "directAnswer",
    decomposeQuestion: "decomposeQuestion",
  })
  .addEdge("decomposeQuestion", "retrieve")
  .addEdge("retrieve", "planNext")
  .addConditionalEdges("planNext", afterPlanNext, {
    retrieve: "retrieve",
    generate: "generate",
  })
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
      question:
        "《天龙八部》中「四大恶人」排行第二的是谁？此人之子在身世揭晓前，其生父在武林中的公开身份是什么？",
      k: 5,
      strategy: "",
      routeReason: "",
      subQuestions: [],
      nextSubIdx: 0,
      documents: [],
      retrievalCount: 0,
      maxRetrievals: 8,
      nextAction: "",
      generation: "",
      gradeResult: null,
    });
    console.log(
      chalk.blue(
        `【回答质量评估】: 是否过关 ：${result.gradeResult.passed}，理由：${result.gradeResult.reason}`,
      ),
    );
  } catch (err) {
    console.error(err);
  }
}

main();
