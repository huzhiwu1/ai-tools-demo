import { ChatOpenAI } from "@langchain/openai";
import chalk from "chalk";
import { createSubAgentMiddleware } from "deepagents";
import "dotenv/config";
import { createAgent, HumanMessage, tool } from "langchain";
import { z } from "zod";
const model = new ChatOpenAI({
  apiKey: process.env.API_KEY,
  modelName: process.env.MODEL_NAME,
  temperature: 0,
  configuration: {
    baseURL: process.env.BASE_URL,
  },
});
const compareStacks = tool(
  ({ scenario }) => {
    return JSON.stringify({
      websocket: "实时双向，适合高频互动，开发复杂度中等",
      sse: "服务器单向推送，适合广播，实现简单",
      longPolling: "兼容性好，但延迟高，不推荐实时场景",
    });
  },
  {
    name: "compare_stacks",
    description: "对比不同实时通信技术方案",
    schema: z.object({ scenario: z.string().describe("应用场景描述") }),
  },
);
const subagents = [
  {
    name: "requirement-analyst",
    description: "分析用户需求，提取功能点、性能要求、团队约束",
    systemPrompt:
      "你是需求分析师。请详细分析用户需求，提取功能点、性能要求和团队约束。",
    tools: [],
  },
  {
    name: "tech-evaluator",
    description: "对比 WebSocket / SSE / 长轮询 三种方案",
    systemPrompt:
      "你是技术评估专家。请对比 WebSocket / SSE / 长轮询 三种方案，给出优缺点对比。",
    tools: [compareStacks],
  },
  {
    name: "risk-assessor",
    description: "评估项目风险，给出风险点和建议",
    systemPrompt: "你是风险评估专家。请评估项目风险，给出风险点和建议。",
    tools: [],
  },
];

const agent = createAgent({
  model,
  systemPrompt:
    "你是技术方案评估主 Agent。按顺序委派：① requirement-analyst 分析需求 ② tech-evaluator 对比技术方案 ③ risk-assessor 评估风险并给出推荐。最后汇总成一份技术选型建议。",
  tools: [],
  middleware: [
    createSubAgentMiddleware({
      defaultModel: model,
      subagents,
      generalPurposeAgent: false,
    }),
  ],
});

const question = "我想实现一实时聊天室";

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

console.log(chalk.blue("用户问题：", question));
const stream = await agent.streamEvents(
  {
    messages: [new HumanMessage(question)],
  },
  {
    recursionLimit: 20,
  },
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
  throw e;
}
