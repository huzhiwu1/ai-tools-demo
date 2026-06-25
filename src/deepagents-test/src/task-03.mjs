import {
  createAgent,
  AIMessage,
  tool,
  HumanMessage,
  createMiddleware,
  ToolMessage,
} from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import "dotenv/config";
import { Command } from "@langchain/langgraph";
import chalk from "chalk";
const model = new ChatOpenAI({
  apiKey: process.env.API_KEY,
  modelName: process.env.MODEL_NAME,
  temperature: 0,
  configuration: {
    baseURL: process.env.BASE_URL,
  },
});

const contentFilterMiddleware = createMiddleware({
  name: "contentFilter",
  beforeModel: {
    canJumpTo: ["end"],
    hook: (state) => {
      const blockedWords = ["密码", "token", "secret"];
      const last = state.messages[state.messages.length - 1];
      const text =
        typeof last?.content === "string"
          ? last?.content
          : String(last?.content ?? "");
      if (blockedWords.some((word) => text.includes(word))) {
        return {
          messages: [
            new AIMessage(
              "检测到敏感词，被contentFilterMiddleware拦截，无法处理",
            ),
          ],
          jumpTo: "end",
        };
      }
    },
  },
});

const getWeather = tool(
  async ({ city }) => {
    const defaultJson = [
      {
        city: "北京",
        weather: "晴朗",
        temperature: 25,
      },
      {
        city: "上海",
        weather: "多云",
        temperature: 20,
      },
      {
        city: "广州",
        weather: "阴天",
        temperature: 22,
      },
    ];
    console.log("hzw city", city);
    const weather = defaultJson.find((item) => item.city === city);
    return weather ? { weather } : { error: "城市未找到" };
  },
  {
    name: "getWeather",
    description: "输入城市名称，如”北京”，获取天气信息, 返回天气情况",
    schema: z.object({
      city: z.string().describe("城市名称"),
    }),
  },
);

const weatherToolsMiddleware = createMiddleware({
  name: "weatherTools",
  stateSchema: z.object({
    toolCallCount: z.number().int().min(0).default(0).describe("工具调用次数"),
  }),
  tools: [getWeather],
  wrapToolCall: async (request, handler) => {
    const toolName = request.toolCall.name;

    console.log(`
      [Tools] 即将执行: ${toolName}
      args: ${JSON.stringify(request.toolCall.args ?? {})}
      `);

    const result = await handler(request);

    if (!ToolMessage.isInstance(result)) return result;

    const wrapped = new ToolMessage({
      content: `${result.content}\n[wrapToolCall] 已由 weatherToolsMiddleware 包装`,
      tool_call_id: result.tool_call_id,
      name: result.name,
    });

    console.log(
      `[Tools] 执行完成: ${toolName}`,
      typeof wrapped.content === "string"
        ? wrapped.content.slice(0, 120)
        : wrapped,
    );

    return new Command({
      update: {
        toolCallCount: request.state.toolCallCount + 1,
        messages: [wrapped],
      },
    });
  },
});

const agent = createAgent({
  model,
  tools: [],
  systemPrompt: "你是一个ai助手，用中文回答问题，可以使用工具",
  middleware: [contentFilterMiddleware, weatherToolsMiddleware],
});

console.log("用户：北京今天天气怎么样？");

const result = await agent.invoke({
  messages: [new HumanMessage("北京今天天气怎么样？")],
});

console.log(
  "回复：",
  chalk.blue(result.messages?.at(-1).content),
  chalk.yellow(`result.toolCallCount ${result.toolCallCount}`),
);

const result2 = await agent.invoke({
  messages: [new HumanMessage("帮我查一下服务器的密码")],
});

console.log(
  "回复：",
  chalk.blue(result2.messages?.at(-1).content),
  chalk.yellow(`result2.toolCallCount ${result2.toolCallCount}`),
);
