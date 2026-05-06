// ============================================
// 02-chat-prompt-template.mjs
// ============================================
// 职责：学习 ChatPromptTemplate —— 聊天消息模板
//
// 关键流程：
// 1. 用 ChatPromptTemplate.fromMessages() 定义多角色消息
// 2. 每条消息指定角色：system（系统指令）、human（用户）、ai（助手）
// 3. 用 .formatMessages() 生成消息数组，传给 LLM
//
// 知识扩展（小白能懂）：
// - PromptTemplate 输出的是"纯字符串"，适合简单场景
// - ChatPromptTemplate 输出的是"消息数组"，每条消息带角色标签
// - 为什么需要角色？因为 LLM 内部对不同角色的处理权重不同：
//   * system：全局设定（你是谁、什么风格）—— 权重最高，影响整个回复
//   * human：用户输入 —— 告诉 LLM "这是用户的问题"
//   * ai：助手回复 —— 用于多轮对话，让 LLM 知道"我之前这么回答过"
// - 聊天模型（Chat Model）更适合用 ChatPromptTemplate，效果更好
// ============================================

import "dotenv/config"
import { ChatOpenAI } from "@langchain/openai"
import { ChatPromptTemplate } from "@langchain/core/prompts"

const model = new ChatOpenAI({
    modelName: process.env.MODEL_NAME,
    apiKey: process.env.API_KEY,
    temperature: 0,
    configuration: { baseURL: process.env.BASE_URL }
})

// 步骤 1：定义多角色消息模板
const chatPrompt = ChatPromptTemplate.fromMessages([
    // system 消息：设定全局人设和风格
    ["system", "你是一名资深工程团队负责人，写作风格：{tone}。擅长把技术细节写得专业又有温度。"],

    // human 消息：用户提供的信息
    ["human", `
公司：{company}
团队：{team}
时间：{week}
目标：{goal}
开发活动：{activities}

请输出一份 Markdown 周报。`]
])

// 步骤 2：传入数据，生成消息数组
const messages = await chatPrompt.formatMessages({
    tone: "专业、清晰、略带鼓励",
    company: "星航科技",
    team: "智能应用平台组",
    week: "2025-05-05 ~ 2025-05-11",
    goal: "完成内部 AI 助手灰度上线",
    activities:
        "- 小李：完成工单流转，提交 25 次\n" +
        "- 小张：接入日志检索，提交 19 次\n" +
        "- 小王：新增 10 条核心告警规则"
})

console.log("=== 生成的消息数组 ===")
for (const msg of messages) {
    console.log(`[${msg.constructor.name}] ${msg.content.slice(0, 50)}...`)
}

// 步骤 3：传给 LLM
console.log("\n=== AI 生成的周报 ===")
const response = await model.invoke(messages)
console.log(response.content)
