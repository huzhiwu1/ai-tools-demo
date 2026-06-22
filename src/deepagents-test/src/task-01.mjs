import { createAgent, HumanMessage } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import "dotenv/config";

const agent = createAgent({
  model: new ChatOpenAI({
    apiKey: process.env.API_KEY,
    modelName: process.env.MODEL_NAME,
    temperature: 0,
    configuration: {
      baseURL: process.env.BASE_URL,
    },
  }),
  tools: [],
  systemPrompt: "你是一个编程知识问答助手，用中文回答，回答要简洁",
  middleware: [],
});

console.log("用户: 什么是Middleware模式");
const response = await agent.invoke({
  messages: [new HumanMessage("什么是Middleware模式")],
});
console.log("回复:", response.messages?.at(-1)?.content);
