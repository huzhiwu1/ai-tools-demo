import "dotenv/config";
import { StateGraph, START, END, MessagesAnnotation } from "@langchain/langgraph";
import { tool } from "@langchain/core/tools";
import { getWeatherByCity } from "./weather-mock.mjs";
import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt'
import { HumanMessage } from "@langchain/core/messages";

const get_weather = tool(
    getWeatherByCity,
    {
        name: "get_weather",
        description: "输入城市名的拼音(如Beijing)，返回该城市天气的json字符串",
        schema: z.object({
            city: z.string().describe("城市名"),
        })
    }
)
const tools = [get_weather]
const llm = new ChatOpenAI({
    modelName: process.env.MODEL_NAME,
    apiKey: process.env.API_KEY,
    temperature: 0,
    configuration: {
        baseURL: process.env.BASE_URL,
    }
}).bindTools(tools);

const toolNode = new ToolNode(tools);



async function agent(state) {
    const response = await llm.invoke(state.messages);
    return { messages: response }
}


const graph = new StateGraph(MessagesAnnotation)
    .addNode('agent', agent)
    .addNode('tools', toolNode)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', toolsCondition, ['tools', END])
    .addEdge('tools', 'agent')
    .compile()



const result = await graph.invoke({
    messages: [new HumanMessage("帮我查询下北京的天气")]
});
console.log(result.messages[result.messages.length - 1].content);

const result2 = await graph.invoke({
    messages: [new HumanMessage("帮我查询下上海的天气")]
});
console.log(result2.messages[result2.messages.length - 1].content);
