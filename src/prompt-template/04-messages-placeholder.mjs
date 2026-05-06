// ============================================
// 04-messages-placeholder.mjs
// ============================================
// 职责：学习 MessagesPlaceholder —— 在模板中动态插入对话历史
//
// 关键流程：
// 1. 用 ChatPromptTemplate.fromMessages() 定义模板
// 2. 在模板中用 new MessagesPlaceholder('history') 预留一个"插槽"
// 3. 调用 .formatMessages() 时传入 history 数组，自动插入到插槽位置
// 4. LLM 看到完整上下文（历史 + 新问题），给出连贯回复
//
// 知识扩展（小白能懂）：
// - MessagesPlaceholder 是"动态内容插槽"，专门用来放"不确定数量"的消息
// - 为什么不用固定模板？因为对话历史长度不固定（2轮、5轮、10轮都可能）
// - 它解决了多轮对话的核心问题：让 LLM "记得"之前聊过什么
// - 位置很重要：system → history → human（新问题），这样 LLM 先读人设，再读历史，最后看新问题
// - 和短期记忆的关系：MessagesPlaceholder 是"容器"，短期记忆是"数据来源"
// ============================================

import "dotenv/config"
import { ChatOpenAI } from "@langchain/openai"
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts"
import { HumanMessage, AIMessage } from "@langchain/core/messages"

const model = new ChatOpenAI({
    modelName: process.env.MODEL_NAME,
    apiKey: process.env.API_KEY,
    temperature: 0,
    configuration: { baseURL: process.env.BASE_URL }
})

// 步骤 1：定义带 MessagesPlaceholder 的模板
const chatPromptWithHistory = ChatPromptTemplate.fromMessages([
    ["system", "你是一名资深工程效率顾问，善于结合历史对话给出具体建议。"],

    // 这里用 MessagesPlaceholder 预留一个插槽，名字叫 'history'
    new MessagesPlaceholder("history"),

    ["human", "这是用户本轮的新问题：{current_input}\n请结合历史对话给出建议。"]
])

// 步骤 2：构造模拟的对话历史
const history = [
    new HumanMessage("我们团队在做周报自动生成工具。"),
    new AIMessage("先把数据源（Git / Jira）梳理清楚，再考虑 Prompt 模块化设计。"),
    new HumanMessage("已经把 Prompt 拆成了人设、背景、任务、格式四块。"),
    new AIMessage("接下来可以做成 PipelinePromptTemplate，方便不同场景复用。")
]

// 步骤 3：传入历史 + 新问题，生成消息数组
const messages = await chatPromptWithHistory.formatMessages({
    history,  // 动态插入到这里
    current_input: "现在想优化多人协同编辑周报的流程，有什么建议？"
})

console.log("=== 包含历史对话的消息数组 ===")
for (const msg of messages) {
    console.log(`[${msg.constructor.name}] ${msg.content.slice(0, 60)}...`)
}

// 步骤 4：传给 LLM
console.log("\n=== AI 回复（结合历史上下文）===")
const response = await model.invoke(messages)
console.log(response.content)
