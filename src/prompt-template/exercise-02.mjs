import "dotenv/config"
import { ChatOpenAI } from "@langchain/openai"
import { ChatPromptTemplate } from "@langchain/core/prompts"


const model = new ChatOpenAI({
    modelName: process.env.MODEL_NAME,
    apiKey: process.env.API_KEY,
    temperature: 0,
    configuration: {
        baseURL: process.env.BASE_URL,
    }
})


const chatPrompt = ChatPromptTemplate.fromMessages([
    ["system", "你是一名「资深工程团队负责人。写作风格{tone}"],
    ["human", `公司：{company}\n团队：{team}\n时间：{week}\n目标：{goal}\n开发活动：{activities}`],
])

async function generateText(tone, company, team, week, goal, activities) {
    const prompt = await chatPrompt.format({
        tone,
        company,
        team,
        week,
        goal,
        activities
    })
    console.log("====格式化后的 prompt====")
    console.log(prompt)
    const res = await model.invoke(prompt)
    console.log("====AI生成的内容====")
    console.log(res.content)
    return res.content
}

await generateText("正式风格", "ABC公司", "工程团队", "2023-04-01", "完成项目A的开发", "需求分析、设计、编码、测试")

await generateText("口语化风格", "ABC公司", "工程团队", "2023-04-01", "完成项目A的开发", "需求分析、设计、编码、测试")
