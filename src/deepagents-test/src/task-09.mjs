import { ChatOpenAI } from "@langchain/openai";
import { createAgent, HumanMessage, tool } from "langchain";
import "dotenv/config";
import { createSubAgentMiddleware } from "deepagents";
import { z } from "zod";

const model = new ChatOpenAI({
  apiKey: process.env.API_KEY,
  modelName: process.env.MODEL_NAME,
  temperature: 0,
  configuration: {
    baseURL: process.env.BASE_URL,
  },
});

const searchFaq = tool(
  ({ category }) => {
    const faqs = {
      退款: "请提供订单号，我们会在 3 个工作日内原路退回。",
      物流: "快递查询入口：xxx，超 7 天未更新请联系客服。",
      账号: "请在登录页点击「忘记密码」按提示重置。",
    };
    return JSON.stringify({
      answer: faqs[category] ?? "已记录，请等待人工回复。",
    });
  },
  {
    name: "search_faq",
    description: "根据问题分类查询标准 FAQ 回复",
    schema: z.object({ category: z.string().describe("问题分类") }),
  },
);

const subagents = [
  {
    name: "intent-classifier",
    description: "把用户问题分类为：退款、物流、账号、技术支持、投诉",
    systemPrompt:
      "你是一个问题分类器，把用户问题分类为：退款、物流、账号、技术支持、投诉",
    tools: [],
  },
  {
    name: "solution-recommender",
    description: "根据分类搜索 FAQ，给出标准回复",
    systemPrompt: "你是一个 FAQ 搜索器，根据分类搜索 FAQ，给出标准回复",
    tools: [searchFaq],
  },
  {
    name: "escalation-decider",
    description: "判断是否涉及敏感词、高额订单、情绪激烈，决定是否转人工",
    systemPrompt:
      "你是一个升级决策器，判断是否涉及敏感词、高额订单、情绪激烈，决定是否转人工",
    tools: [],
  },
];

const agent = createAgent({
  model,
  systemPrompt:
    "你是客服工单分发主 Agent。按顺序：① intent-classifier 分类问题 ② solution-recommender 查询标准回复 ③ escalation-decider 判断是否升级人工。最后汇总处理结论。",
  tools: [],
  middleware: [
    createSubAgentMiddleware({
      defaultModel: model,
      subagents,
      generalPurposeAgent: false,
    }),
  ],
});

const questions = [
  "我昨天下的订单想申请退款，怎么操作？",
  "我的包裹已经好几天没有物流更新了，怎么回事？",
  "我忘记密码了，登不进账号怎么办？",
  "操，神经病",
];

function chunkText(chunk) {
  if (!chunk?.content) return "";
  if (typeof chunk.content === "string") return chunk.content;
  if (Array.isArray(chunk.content)) {
    return chunk.content
      .map((p) => (typeof p === "string" ? p : (p?.text ?? "")))
      .join("");
  }
  return "";
}
for (const question of questions) {
  console.log(`Question: ${question}\n`);
  const stream = await agent.streamEvents(
    { messages: [new HumanMessage(question)] },
    { recursionLimit: 20 },
  );
  try {
    for await (const event of stream) {
      if (event.event === "on_chat_model_stream") {
        const t = chunkText(event.data?.chunk);
        if (t) process.stdout.write(t);
      }
      if (event.event === "on_tool_start") {
        const name = event.name?.split("/").pop() ?? event.name;
        process.stdout.write(`\n\n→ ${name}\n\n`);
      }
    }
  } catch (e) {
    console.error("\n\n[错误]", e.cause?.message ?? e.message);
  }
  console.log("\n---\n");
}
