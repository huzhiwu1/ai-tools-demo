import "dotenv/config"
import { ChatOpenAI } from "@langchain/openai"
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts"
import { StringOutputParser } from "@langchain/core/output_parsers"
import { RunnableLambda, RunnableWithMessageHistory } from "@langchain/core/runnables"
import { InMemoryChatMessageHistory } from "@langchain/core/chat_history"

const model = new ChatOpenAI({
    modelName: process.env.MODEL_NAME,
    apiKey: process.env.API_KEY,
    temperature: 0,
    configuration: {
        baseURL: process.env.BASE_URL,
    },
})

const systemPrompt = `你是"向量圆桌"客服小圆，专门解答关于向量数据库、RAG、Milvus 的技术咨询。
要求：
1. 回答必须基于用户之前的问题上下文（理解"它"、"那个"等代词指向）
2. 如果用户的问题超出向量数据库/RAG/Milvus 范围，礼貌拒绝并引导回来
3. 回答简洁，每次不超过 80 字`


const chatPrompt = ChatPromptTemplate.fromMessages([
    ["system", systemPrompt],
    new MessagesPlaceholder("history"),
    ["human", "{input}"],
])


const mainChain = chatPrompt.pipe(model.withRetry({
    stopAfterAttempt: 2,
})).pipe(new StringOutputParser())

const fallbackChain = RunnableLambda.from((input) => {
    console.log("⚠️ 触发了 fallback，原始输入：", input)
    console.error("⚠️ 这说明 mainChain 抛错了，请检查上面的报错")
    return "抱歉，小圆现在状态不太好..."
})

const robustChain = mainChain.withFallbacks([fallbackChain])

const messageHistories = new Map()

const getMessageHistory = (sessionId) => {
    if (!messageHistories.has(sessionId)) {
        messageHistories.set(sessionId, new InMemoryChatMessageHistory())
    }
    return messageHistories.get(sessionId)
}

const chainWithHistory = new RunnableWithMessageHistory({
    runnable: robustChain,
    getMessageHistory,
    inputMessagesKey: "input",
    historyMessagesKey: "history",
})

// 第1轮
const result1 = await chainWithHistory.invoke(
    { input: "我想了解一下 Milvus 向量数据库" },
    { configurable: { sessionId: "user_a" } }
)
console.log("用户：我想了解一下 Milvus 向量数据库")
console.log("小圆：" + result1 + '\n')

// 第2轮（用"它"指代 Milvus，验证记忆）
const result2 = await chainWithHistory.invoke(
    { input: "它的性能怎么样？" },
    { configurable: { sessionId: "user_a" } }
)

console.log("用户：它的性能怎么样？")
console.log("小圆：" + result2 + '\n')
// 第3轮（用"那"对比，继续验证）
const result3 = await chainWithHistory.invoke(
    { input: "那和 Chroma 比呢？" },
    { configurable: { sessionId: "user_a" } }
)
console.log("用户：那和 Chroma 比呢？")
console.log("小圆：" + result3 + '\n')


// 问一个指代词，应该"听不懂"，因为 user_b 没有上文
const result4 = await chainWithHistory.invoke(
    { input: "它怎么样？" },
    { configurable: { sessionId: "user_b" } }
)
console.log("用户B：它怎么样？")
console.log("小圆：" + result4 + '\n')

const result5 = await chainWithHistory.invoke(
    { input: "给我推荐个北京的火锅店" },
    { configurable: { sessionId: "user_a" } }
)
console.log("用户_a：给我推荐个北京的火锅店")
console.log("小圆：" + result5 + '\n')


console.log("\n===== user_a 的完整历史 =====")
const history_a = await getMessageHistory("user_a").getMessages()
history_a.forEach(msg => console.log(`[${msg._getType()}] ${msg.content}`))