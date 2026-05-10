// ============================================
// 08-runnable-with-message-history.mjs
// ============================================
// 职责：学习 RunnableWithMessageHistory —— 给 Chain 添加多轮对话记忆
//
// 关键流程：
// 1. 定义基础 chain（包含 MessagesPlaceholder 来插入历史消息）
// 2. 创建消息历史存储（InMemoryChatMessageHistory 或自定义存储）
// 3. 用 RunnableWithMessageHistory 包装基础 chain
// 4. 指定 inputMessagesKey（用户输入的字段名）和 historyMessagesKey（占位符名）
// 5. 调用时传入 configurable.sessionId 区分不同会话
//
// 知识扩展（小白能懂）：
// - RunnableWithMessageHistory 是"记忆外壳"，套在 chain 外面，让 chain 有记忆能力
// - 底层原理：每次调用前从历史中取出消息，插入到 MessagesPlaceholder 位置
// - InMemoryChatMessageHistory 是"内存存储"，重启后数据丢失，适合演示
// - 生产环境应换成：RedisChatMessageHistory、MongoDBChatMessageHistory 等持久化存储
// - sessionId 是"会话身份证号"，不同 sessionId 之间的历史互不干扰
// - 为什么不用全局变量存历史？因为并发时多个用户的历史会混在一起
// ============================================

import "dotenv/config"
import { RunnableWithMessageHistory } from "@langchain/core/runnables"
import { InMemoryChatMessageHistory } from "@langchain/core/chat_history"
import { ChatOpenAI } from "@langchain/openai"
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts"
import { StringOutputParser } from "@langchain/core/output_parsers"

const model = new ChatOpenAI({
    modelName: process.env.MODEL_NAME,
    apiKey: process.env.API_KEY,
    temperature: 0.3,
    configuration: { baseURL: process.env.BASE_URL }
})

// ============================================
// 步骤1：定义带 MessagesPlaceholder 的 Prompt
// ============================================
const prompt = ChatPromptTemplate.fromMessages([
    [
        "system",
        "你是一个简洁、有帮助的中文助手，会用 1-2 句话回答用户问题，重点给出明确、有用的信息。"
    ],
    // MessagesPlaceholder：历史消息会动态插入到这里
    new MessagesPlaceholder("history"),
    // 用户当前的问题
    ["human", "{question}"]
])

// ============================================
// 步骤2：定义基础 chain
// ============================================
const simpleChain = prompt
    .pipe(model)
    .pipe(new StringOutputParser())

// ============================================
// 步骤3：创建消息历史存储（内存版）
// ============================================
// 用 Map 存储多个会话的历史，key 是 sessionId
const messageHistories = new Map()

const getMessageHistory = (sessionId) => {
    if (!messageHistories.has(sessionId)) {
        messageHistories.set(sessionId, new InMemoryChatMessageHistory())
    }
    return messageHistories.get(sessionId)
}

// ============================================
// 步骤4：用 RunnableWithMessageHistory 包装 chain
// ============================================
const chainWithHistory = new RunnableWithMessageHistory({
    runnable: simpleChain,          // 基础 chain
    getMessageHistory,              // 获取历史消息的函数
    inputMessagesKey: "question",   // 用户输入的字段名
    historyMessagesKey: "history"   // MessagesPlaceholder 的占位符名
})

// ============================================
// 步骤5：测试多轮对话
// ============================================
console.log("=".repeat(60))
console.log("【多轮对话测试】同一个 sessionId 的记忆保持")
console.log("=".repeat(60))

const sessionId = "user-demo-001"

// 第一轮：自我介绍
console.log("\n--- 第一轮 ---")
const result1 = await chainWithHistory.invoke(
    { question: "我的名字是张三，我来自北京，我喜欢编程和爬山。" },
    { configurable: { sessionId } }
)
console.log(`用户: 我的名字是张三，我来自北京，我喜欢编程和爬山。`)
console.log(`AI: ${result1}`)

// 第二轮：询问之前的信息（测试记忆）
console.log("\n--- 第二轮 ---")
const result2 = await chainWithHistory.invoke(
    { question: "我刚才说我来自哪里？" },
    { configurable: { sessionId } }
)
console.log(`用户: 我刚才说我来自哪里？`)
console.log(`AI: ${result2}`)

// 第三轮：继续询问（测试记忆连续性）
console.log("\n--- 第三轮 ---")
const result3 = await chainWithHistory.invoke(
    { question: "我的爱好是什么？" },
    { configurable: { sessionId } }
)
console.log(`用户: 我的爱好是什么？`)
console.log(`AI: ${result3}`)

// ============================================
// 示例2：不同 sessionId 互不干扰
// ============================================
console.log("\n" + "=".repeat(60))
console.log("【Session 隔离测试】不同 sessionId 互不干扰")
console.log("=".repeat(60))

// session A：用户张三
console.log("\n--- Session A（张三）---")
const resultA = await chainWithHistory.invoke(
    { question: "我叫什么名字？" },
    { configurable: { sessionId: "session-a" } }
)
console.log(`AI 回复: ${resultA}`)
// 预期：AI 不知道，因为这是新 session

// 先给 session A 设置名字
await chainWithHistory.invoke(
    { question: "我叫张三。" },
    { configurable: { sessionId: "session-a" } }
)
const resultA2 = await chainWithHistory.invoke(
    { question: "我叫什么名字？" },
    { configurable: { sessionId: "session-a" } }
)
console.log(`（已告知名字后）AI 回复: ${resultA2}`)

// session B：用户李四（完全不同的对话）
console.log("\n--- Session B（李四）---")
await chainWithHistory.invoke(
    { question: "我叫李四。" },
    { configurable: { sessionId: "session-b" } }
)
const resultB = await chainWithHistory.invoke(
    { question: "我叫什么名字？" },
    { configurable: { sessionId: "session-b" } }
)
console.log(`AI 回复: ${resultB}`)

// 验证 session A 没有被 session B 污染
console.log("\n--- 再次检查 Session A ---")
const resultA3 = await chainWithHistory.invoke(
    { question: "我叫什么名字？" },
    { configurable: { sessionId: "session-a" } }
)
console.log(`AI 回复: ${resultA3}`)
console.log("（验证：Session A 仍然记得张三，没有被 Session B 污染）")

// ============================================
// 示例3：查看历史消息内容
// ============================================
console.log("\n" + "=".repeat(60))
console.log("【查看历史消息】Session A 的完整对话记录")
console.log("=".repeat(60))

const history = await getMessageHistory("session-a").getMessages()
console.log(`共 ${history.length} 条消息:\n`)
history.forEach((msg, idx) => {
    const role = msg.constructor.name.replace("Message", "").toLowerCase()
    console.log(`  [${idx + 1}] ${role}: ${msg.content.slice(0, 50)}${msg.content.length > 50 ? "..." : ""}`)
})

// ============================================
// 【知识点总结】
// ============================================
console.log("\n" + "=".repeat(60))
console.log("【知识点总结】")
console.log("=".repeat(60))
console.log(`
1. RunnableWithMessageHistory 的核心参数
   - runnable: 基础 chain（必须包含 MessagesPlaceholder）
   - getMessageHistory: 获取历史消息的函数，接收 sessionId 返回 ChatMessageHistory
   - inputMessagesKey: 用户输入在输入对象中的字段名
   - historyMessagesKey: MessagesPlaceholder 的 name

2. 调用方式
   await chainWithHistory.invoke(
       { question: "..." },
       { configurable: { sessionId: "xxx" } }
   )

3. Session 隔离
   - 不同 sessionId 的历史完全隔离
   - 就像每个用户有自己的"聊天记录文件夹"
   - 适合多用户场景（客服、聊天机器人）

4. 存储方式
   - InMemoryChatMessageHistory: 内存存储，重启丢失（演示用）
   - RedisChatMessageHistory: Redis 持久化（生产推荐）
   - MongoDBChatMessageHistory: MongoDB 持久化
   - 自定义：实现 BaseChatMessageHistory 接口

5. 注意事项
   - 基础 chain 的 prompt 必须包含 MessagesPlaceholder
   - 历史消息会消耗 token，建议设置 maxHistoryLength 限制长度
   - 每条消息会自动添加到历史中，无需手动管理
`)
