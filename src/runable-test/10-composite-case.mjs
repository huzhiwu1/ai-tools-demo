// ============================================
// 10-composite-case.mjs
// ============================================
// 职责：综合实战 —— 组合多个 Runnable 组件构建智能客服 Agent
//
// 关键流程：
// 1. 用 RunnableBranch 做意图识别路由（问候/咨询/投诉/其他）
// 2. 用 RunnableSequence 构建每个意图的处理链
// 3. 用 RunnableMap 并行提取用户情绪和关键词
// 4. 用 RunnablePassthrough 保留原始输入供后续使用
// 5. 用 RunnableLambda 做数据转换和日志记录
// 6. 最终输出包含：回复内容、意图分类、情绪分析、处理耗时
//
// 知识扩展（小白能懂）：
// - 这个案例展示了 Runnable 的"组合拳"思想：没有单一组件能解决所有问题
// - 每个 Runnable 负责一小块，拼起来解决大问题
// - 这种"模块化 + 组合"的思维方式，是构建复杂 AI Agent 的核心
// - 类比：乐高积木 —— 每个积木都很简单，组合起来可以搭出复杂的建筑
// ============================================

import "dotenv/config"
import {
    RunnableBranch,
    RunnableLambda,
    RunnableMap,
    RunnablePassthrough,
    RunnableSequence,
    RunnablePick
} from "@langchain/core/runnables"
import { ChatOpenAI } from "@langchain/openai"
import { PromptTemplate } from "@langchain/core/prompts"
import { StringOutputParser } from "@langchain/core/output_parsers"

const model = new ChatOpenAI({
    modelName: process.env.MODEL_NAME,
    apiKey: process.env.API_KEY,
    temperature: 0,
    configuration: { baseURL: process.env.BASE_URL }
})

const parser = new StringOutputParser()

// ============================================
// 模块1：意图识别（用简单规则模拟，实际可用 LLM 分类）
// ============================================
const isGreeting = RunnableLambda.from((input) =>
    /你好|您好|嗨|hello|hi/i.test(input.userMessage)
)

const isComplaint = RunnableLambda.from((input) =>
    /投诉|差评|退款|赔偿|垃圾|太差|不满/i.test(input.userMessage)
)

const isProductQuery = RunnableLambda.from((input) =>
    /价格|多少钱|怎么样|推荐|适合|有吗/i.test(input.userMessage)
)

// ============================================
// 模块2：各意图的处理链
// ============================================

// 2.1 问候处理链
const greetingChain = RunnableSequence.from([
    PromptTemplate.fromTemplate(`
你是友好的客服助手。用户发来问候："{userMessage}"
请用热情、亲切的语气回复，适当询问用户需要什么帮助。
    `),
    model,
    parser,
    RunnableLambda.from((text) => ({
        intent: "greeting",
        reply: text,
        priority: "low"
    }))
])

// 2.2 投诉处理链（高优先级）
const complaintChain = RunnableSequence.from([
    PromptTemplate.fromTemplate(`
你是专业的客服主管。用户发来投诉："{userMessage}"
请用诚恳、安抚的语气回复，表示理解用户不满，承诺会尽快处理。
回复要包含：1.道歉 2.理解 3.解决方案 4.后续跟进方式
    `),
    model,
    parser,
    RunnableLambda.from((text) => ({
        intent: "complaint",
        reply: text,
        priority: "high"
    }))
])

// 2.3 产品咨询处理链
const productChain = RunnableSequence.from([
    PromptTemplate.fromTemplate(`
你是专业的产品顾问。用户咨询："{userMessage}"
请给出专业、详细的回答，包含产品特点和购买建议。
    `),
    model,
    parser,
    RunnableLambda.from((text) => ({
        intent: "product_query",
        reply: text,
        priority: "normal"
    }))
])

// 2.4 默认处理链
const defaultChain = RunnableSequence.from([
    PromptTemplate.fromTemplate(`
你是智能客服助手。用户说："{userMessage}"
请给出 helpful 的回复，如果不确定就建议转人工客服。
    `),
    model,
    parser,
    RunnableLambda.from((text) => ({
        intent: "general",
        reply: text,
        priority: "normal"
    }))
])

// ============================================
// 模块3：意图路由 Branch
// ============================================
const intentRouter = RunnableBranch.from([
    [isGreeting, greetingChain],
    [isComplaint, complaintChain],
    [isProductQuery, productChain],
    defaultChain
])

// ============================================
// 模块4：并行分析（情绪 + 关键词）
// ============================================
const analysisMap = RunnableMap.from({
    sentiment: RunnableSequence.from([
        PromptTemplate.fromTemplate(`
判断以下用户消息的情感倾向，只回复一个字：正/负/中
消息："{userMessage}"
        `),
        model,
        parser,
        RunnableLambda.from((text) => text.trim().charAt(0))
    ]),
    keywords: RunnableSequence.from([
        PromptTemplate.fromTemplate(`
从以下消息中提取3个关键词，用逗号分隔：
消息："{userMessage}"
        `),
        model,
        parser,
        RunnableLambda.from((text) => text.split(",").map((s) => s.trim()))
    ])
})

// ============================================
// 模块5：组装完整的客服 Agent Chain
// ============================================

const customerServiceAgent = RunnableSequence.from([
    // 步骤1：保留原始输入
    RunnablePassthrough.assign({
        timestamp: RunnableLambda.from(() => new Date().toISOString()),
        requestId: RunnableLambda.from(() => `req_${Date.now()}`)
    }),

    // 步骤2：并行处理 —— 意图路由 + 情绪分析
    RunnableLambda.from(async (input) => {
        console.log(`\n${"=".repeat(60)}`)
        console.log(`[Agent] 收到消息: "${input.userMessage}"`)
        console.log(`[Agent] RequestId: ${input.requestId}`)
        console.log(`${"=".repeat(60)}`)

        // 2.1 路由到对应的处理链
        console.log("\n[步骤1] 意图路由...")
        const routeResult = await intentRouter.invoke(input)
        console.log(`[步骤1] 意图识别: ${routeResult.intent}, 优先级: ${routeResult.priority}`)

        // 2.2 并行分析情绪和关键词
        console.log("\n[步骤2] 并行分析（情绪 + 关键词）...")
        const analysis = await analysisMap.invoke(input)
        console.log(`[步骤2] 情绪: ${analysis.sentiment}, 关键词: ${analysis.keywords.join(", ")}`)

        return {
            ...input,
            ...routeResult,
            sentiment: analysis.sentiment,
            keywords: analysis.keywords
        }
    }),

    // 步骤3：整理最终输出
    RunnableLambda.from((input) => ({
        requestId: input.requestId,
        timestamp: input.timestamp,
        userMessage: input.userMessage,
        response: {
            reply: input.reply,
            intent: input.intent,
            priority: input.priority,
            sentiment: input.sentiment,
            keywords: input.keywords
        },
        meta: {
            handledBy: "AI-Agent",
            version: "1.0.0"
        }
    }))
])

// ============================================
// 测试不同场景
// ============================================

const testMessages = [
    "你好，请问有人吗？",
    "你们的产品质量太差了，我要投诉！",
    "这款智能手表多少钱？适合跑步用吗？",
    "我想了解一下你们的售后服务政策"
]

console.log("\n" + "#".repeat(60))
console.log("# 智能客服 Agent 综合测试")
console.log("#".repeat(60))

for (const msg of testMessages) {
    const result = await customerServiceAgent.invoke({ userMessage: msg })

    console.log(`\n${"-".repeat(60)}`)
    console.log("【最终输出】")
    console.log(JSON.stringify(result, null, 2))
}

// ============================================
// 【知识点总结】
// ============================================
console.log("\n" + "=".repeat(60))
console.log("【综合案例知识点总结】")
console.log("=".repeat(60))
console.log(`
这个综合案例演示了 Runnable 组件的组合能力：

1. RunnableBranch —— 意图路由
   - 根据用户输入特征，自动选择处理链
   -  greeting / complaint / product_query / general

2. RunnableSequence —— 组装处理链
   - 每个意图都有独立的 Prompt → LLM → Parser 链
   - 链的输出统一为 { intent, reply, priority }

3. RunnableMap —— 并行分析
   - 同时提取情绪倾向和关键词
   - 节省时间，不阻塞主流程

4. RunnablePassthrough —— 保留原始数据
   - 保留 userMessage，同时添加 timestamp、requestId
   - 供后续步骤使用

5. RunnableLambda —— 数据转换
   - 格式化输出、提取首字符、拆分关键词数组
   - 连接不同组件的数据格式

6. 整体架构
   用户输入 → 保留元数据 → 意图路由 → 并行分析 → 整理输出

这种"模块化组合"的思想是构建复杂 Agent 的核心：
- 每个组件职责单一、可测试
- 组件之间通过标准接口连接
- 可以灵活替换、重组、扩展
`)
