import { createAgent, createMiddleware, HumanMessage } from "langchain";
import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import chalk from "chalk";

const model = new ChatOpenAI({
  apiKey: process.env.API_KEY,
  modelName: process.env.MODEL_NAME,
  temperature: 0,
  configuration: {
    baseURL: process.env.BASE_URL,
  },
});
let startTime = 0;
const loggingMiddleware = createMiddleware({
  name: "LoggingMiddleware",
  stateSchema: z.object({
    modelCallCount: z.number().int().default(0).describe("模型调用次数"),
    totalDurationMS: z.number().int().default(0).describe("总耗时,单位毫秒"),
  }),
  beforeAgent: (state) => {
    console.log(chalk.blue("Agent 开始", JSON.stringify(state)));
    startTime = Date.now();
    return {
      ...state,
    };
  },
  beforeModel: (state) => {
    console.log(chalk.blue("beforeModel 调用", JSON.stringify(state)));
    console.log(chalk.blue(`即将调用模型，第${state.modelCallCount + 1}次`));
  },
  afterModel: (state) => {
    console.log(chalk.blue("afterModel 调用", JSON.stringify(state)));
    console.log(chalk.blue(`模型调用完成，第${state.modelCallCount + 1}次`));
    return {
      ...state,
      totalDurationMS: Date.now() - startTime,
      modelCallCount: state.modelCallCount + 1,
    };
  },
  afterAgent: (state) => {
    console.log(
      chalk.blue(
        `agent调用结束，总共调用${state.modelCallCount}次，总共耗时${state.totalDurationMS}毫秒`,
      ),
    );
  },
});

const styleMiddleware = createMiddleware({
  name: "StyleMiddleware",

  wrapModelCall: (request, handler) => {
    request = {
      ...request,
      systemPrompt:
        request.systemPrompt + "\n\n请用Markdown 格式回答，包含代码示例。",
    };
    return handler(request);
  },
});

const agent = createAgent({
  model,
  tools: [],
  systemPrompt: "你是一个编程知识问答助手，用中文回答，回答要简洁",
  middleware: [loggingMiddleware, styleMiddleware],
});

console.log(chalk.blue("用户: Node.js 中如何读取文件"));
const response = await agent.invoke({
  messages: [new HumanMessage("Node.js 中如何读取文件")],
});

console.log(
  chalk.blue(
    "AI: " +
      `AI调用 ${response.modelCallCount}次数` +
      ", " +
      `AI调用耗时 ${response.totalDurationMS}毫秒` +
      ", " +
      response.messages?.at(-1)?.content,
  ),
);
