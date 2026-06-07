import { MemorySaver } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent, tool } from "langchain";
import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod"
import { getWeatherByCity } from "./weather-mock.mjs"
import "dotenv/config"


const llm = new ChatOpenAI({
    modelName: process.env.MODEL_NAME,
    temperature: 0,
    apiKey: process.env.API_KEY,
    configuration: {
        baseURL: process.env.BASE_URL,
    }
});

const get_weather = tool(
    getWeatherByCity,
    {
        name: "get_weather",
        description: "输入城市名的拼音(如Beijing)，返回该城市天气的json字符串",
        schema: z.object({
            city: z.string().describe("城市名"),
        }),
    }

);

const agent = createAgent({
    model: llm,
    tools: [get_weather],
    systemPrompt: "你是一个天气查询助手，可以使用get_weather工具来查询天气",
    checkpointer: new MemorySaver(),
})

const result = await agent.invoke({
    messages: [new HumanMessage("帮我查询下北京的天气")]
}, {
    configurable: {
        thread_id: 'userA'
    }
});

console.log('result', result.messages[result.messages.length - 1].content)

const result2 = await agent.invoke({
    messages: [new HumanMessage("上海呢")]
}, {
    configurable: {
        thread_id: 'userA'
    }
});

console.log('result2', result2.messages[result2.messages.length - 1].content)
