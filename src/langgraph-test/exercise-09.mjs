import { tool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { getWeatherByCity } from "./weather-mock.mjs";
import { getFoodByCity } from "./food-mock.mjs";
import { z } from "zod";
import "dotenv/config";
import { createAgent, HumanMessage } from "langchain";
import { createSupervisor } from "@langchain/langgraph-supervisor";

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
)

const get_food = tool(
    getFoodByCity,
    {
        name: "get_food",
        description: "输入城市名的拼音(如Beijing)，返回该城市美食的json字符串",
        schema: z.object({
            city: z.string().describe("城市名"),
        }),
    }
)

const weatherAgent = createAgent({
    name: 'weatherAgent',
    model: llm,
    description: '一个天气查询助手，可以使用get_weather工具来查询天气',
    tools: [get_weather],
    systemPrompt: "你是一个天气查询助手，可以使用get_weather工具来查询天气",
})

const foodAgent = createAgent({
    name: 'foodAgent',
    description: '一个美食查询助手，可以使用get_food工具来查询美食',
    tools: [get_food],
    model: llm,
    systemPrompt: `你是一个美食查询助手，可以使用get_food工具来查询美食。只返回工具查询到的结果，不要添加任何工具未返回的美食信息，不要编造或补充。
    ## 规则
    - 只返回工具查询到的结果，不要添加任何工具未返回的美食信息
    - 不要编造或补充任何信息
    `,
})

const workflow = createSupervisor({
    llm: llm,
    agents: [weatherAgent.graph, foodAgent.graph],
    prompt: `你是一个任务调度员，自己不回答问题，只负责委派任务给专业agent。

## 可用agent
- weatherAgent：查询天气、气温、湿度
- foodAgent：查询城市特色美食

## 规则
- 每个问题只委派一次对应的agent，拿到结果后直接汇总输出
- 不要自己生成答案，必须委派给对应agent
- 不要重复委派同一个agent
- 所有问题都委派完后，汇总各agent的结果，给出最终回答后立即结束`,
})


const app = workflow.compile()


const input = {
    messages: [
        new HumanMessage("北京天气怎么样？有什么好吃的？")
    ]
}

const nodePath = []
let finalState = null
const stream = await app.stream(input, {
    streamMode: ['updates', 'values'],
    recursionLimit: 50,
})

for await (const chunk of stream) {
    const [mode, payload] = chunk
    if (mode === 'updates' && payload && typeof payload === 'object') {
        nodePath.push(...Object.keys(payload))
    } else if (mode === 'values') {
        finalState = payload
    }
}

console.log('路径', nodePath.join('->'))

console.log('最终状态', finalState?.messages[finalState?.messages.length - 1]?.content)
