// ============================================
// 02-rag-chain.mjs
// ============================================
// 职责：手把手用 LCEL 搭一条 RAG（检索增强生成）链
//        ——基于源代码 runnable-test/src/cases/ebook-reader-rag.mjs 改写
//        为了让小白能直接跑通，我们把 Milvus 检索换成「内置的小说片段数组」做模拟检索，
//        但链的结构和 RunnableSequence 组合方式与原版完全一致。
//
// 关键流程（这就是几乎所有 RAG 系统的通用骨架）：
// 1. 检索（Retrieve）   : 把用户问题向量化 → 在向量库里找 topK 相关片段
// 2. 组装上下文（Augment）: 把检索到的片段拼成 context 字符串
// 3. 提示模板（Prompt）  : 把 question + context 灌到 PromptTemplate
// 4. 模型生成（Generate） : LLM 根据 prompt 生成回答
// 5. 输出解析（Parse）   : StringOutputParser 把 AIMessage 转成纯文本
// 6. 流式输出（Stream）  : .stream() 让用户像打字机一样看到生成过程
//
// 知识扩展（小白能懂）：
//   什么是 RAG？
//   - 全称 Retrieval-Augmented Generation，"先检索再生成"
//   - 解决的问题：LLM 没看过你的私有数据（公司文档、小说、笔记）
//   - 核心思路：用户问问题 → 先去你的资料库里找相关片段 → 把片段塞进 Prompt → 让 LLM 基于这些片段回答
//
//   为什么用 LCEL 写 RAG？
//   - RAG 是天然的"流水线"：检索 → 拼 prompt → 调模型 → 解析 → 输出
//   - 用 LCEL 一条链表达，节点之间的数据流向清清楚楚
//   - 链天然支持 .stream()，对话式应用直接拿来用
//
//   原版与本教学版的区别
//   - 原版：用 OpenAIEmbeddings + Milvus 真实向量检索
//   - 本版：用一个「关键词命中」的假检索器（mockRetriever），重点放在 LCEL 链结构本身
//   - 你看懂了链结构，把假检索器换成真 Milvus 调用就是原版代码
// ============================================

import "dotenv/config"
import chalk from "chalk"
import { ChatOpenAI } from "@langchain/openai"
import {
    RunnableSequence,
    RunnableLambda,
} from "@langchain/core/runnables"
import { PromptTemplate } from "@langchain/core/prompts"
import { StringOutputParser } from "@langchain/core/output_parsers"

// ============================================
// 0. 模拟知识库 —— 假装这是从 Milvus 检索出来的小说片段
// ============================================
// 真实场景：这里应该是向量数据库返回的 topK 个 chunk
// 教学场景：我们写死一组《天龙八部》风格的片段，按关键词命中
const KNOWLEDGE_BASE = [
    {
        book_id: "天龙八部",
        chapter_num: 10,
        index: 0,
        content: "鸠摩智号称大轮明王，自称精通少林七十二绝技，其实是用小无相功催动出来的，并非真的修炼了七十二绝技。",
    },
    {
        book_id: "天龙八部",
        chapter_num: 42,
        index: 1,
        content: "段誉学会了北冥神功，可以吸取他人内力，又得到了凌波微步和六脉神剑，是大理段氏的少主。",
    },
    {
        book_id: "天龙八部",
        chapter_num: 18,
        index: 2,
        content: "乔峰一掌降龙十八掌击退聚贤庄群雄，刚猛无俦，是丐帮前任帮主，后来发现自己其实是契丹人萧远山之子。",
    },
    {
        book_id: "天龙八部",
        chapter_num: 21,
        index: 3,
        content: "虚竹原本是少林寺小和尚，意外破解珍珑棋局，得到无崖子七十年内力，后又成为灵鹫宫主。",
    },
]

// ============================================
// 1. 检索 Runnable —— 对应原版的 milvusSearch
// ============================================
// 输入: { question: string, k?: number }
// 输出: { question, retrievedContent: [...] }
const retrieve = new RunnableLambda({
    func: async (input) => {
        const { question, k = 3 } = input

        // 真实场景：调用 embeddings.embedQuery(question) 拿到向量，
        //          然后用 milvusClient.search() 做相似度检索
        // 教学场景：用关键词包含做命中，简单直观
        const hits = KNOWLEDGE_BASE
            .map((doc) => {
                let score = 0
                // 简单打分：question 中每出现一个文档关键词就 +1
                for (const ch of question) {
                    if (doc.content.includes(ch)) score++
                }
                return { ...doc, score }
            })
            .filter((doc) => doc.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, k)

        return { question, retrievedContent: hits }
    },
})

// ============================================
// 2. 组装上下文 Runnable —— 对应原版的 buildPromptInput
// ============================================
// 关键点：保留 question，新增 context 字符串字段；同时打印调试日志
const buildContext = new RunnableLambda({
    func: async (input) => {
        const { question, retrievedContent } = input

        // 没检索到任何内容时，返回 hasContext: false，让下游兜底
        if (!retrievedContent.length) {
            return { hasContext: false, question, context: "" }
        }

        // 友好打印检索结果（对应原版的 console.log 部分）
        console.log(chalk.bgBlue(`\n【检索到 ${retrievedContent.length} 条相关片段】`))
        retrievedContent.forEach((item, i) => {
            console.log(chalk.cyan(
                `  [片段${i + 1}] 第${item.chapter_num}章  得分:${item.score}`
            ))
            console.log(`         ${item.content.slice(0, 60)}...`)
        })

        // 把片段拼成给 LLM 看的 context（注意分隔符要醒目，便于 LLM 区分）
        const context = retrievedContent
            .map((item, i) => `[片段${i + 1}] 第${item.chapter_num}章\n${item.content}`)
            .join("\n\n━━━━━\n\n")

        return { hasContext: true, question, context }
    },
})

// ============================================
// 3. 提示模板 —— 告诉 LLM 怎么用 context 回答 question
// ============================================
// 重点：明确告诉模型"基于片段回答"，避免它瞎编（幻觉）
const promptTemplate = PromptTemplate.fromTemplate(
    `你是一个专业的《天龙八部》小说助手，请仅基于以下小说片段回答用户问题。

【小说片段】
{context}

【用户问题】
{question}

【回答要求】
1. 只能使用片段中的信息，不要编造
2. 可以综合多个片段
3. 如果片段不足以回答，请明确说"片段中未提及"
4. 回答尽量准确、详细

AI 助手的回答：`
)

// ============================================
// 4. LLM 模型
// ============================================
const model = new ChatOpenAI({
    modelName: process.env.MODEL_NAME,
    apiKey: process.env.API_KEY,
    temperature: 0.3,
    configuration: { baseURL: process.env.BASE_URL },
})

// ============================================
// 5. 兜底分支 —— 没检索到内容直接返回，不浪费 LLM tokens
// ============================================
// 这一节是原版里"如果 hasContext 为 false 就返回 fallback"的逻辑
// 注意：这里返回的对象还要被下游 promptTemplate 接收，所以即使兜底也要保持字段一致
const guardEmptyContext = new RunnableLambda({
    func: async (input) => {
        if (!input.hasContext) {
            const fallback = "片段中未找到相关内容，请换个问题试试～"
            console.log(chalk.red("\n[兜底分支] " + fallback))
            // 抛出特殊错误标记，让外层捕获后直接打印，跳过 LLM 调用
            throw new Error("__NO_CONTEXT__:" + fallback)
        }
        // 注意：PromptTemplate 只需要 { question, context } 两个字段
        return { question: input.question, context: input.context }
    },
})

// ============================================
// 6. 把所有节点串成一条 RAG 链
// ============================================
// 这就是 LCEL 的精髓：链的每一节职责单一，组装在一起就是完整业务
const ragChain = RunnableSequence.from([
    retrieve,           // { question } → { question, retrievedContent }
    buildContext,       // → { hasContext, question, context }
    guardEmptyContext,  // → { question, context }（或抛错跳出）
    promptTemplate,     // → 格式化好的 PromptValue
    model,              // → AIMessage（带 content）
    new StringOutputParser(), // → 纯字符串
])

// ============================================
// 7. 跑起来 —— 流式 stream 体验
// ============================================
async function main() {
    const question = "鸠摩智会什么武功？他真的会少林七十二绝技吗？"

    console.log(chalk.bgGreen(`\n【用户提问】${question}`))
    console.log(chalk.bgGreen("【AI 流式回答】\n"))

    try {
        // .stream() 是 LCEL 的隐藏福利：链的每个节点不用动，整条链就支持流式
        const stream = await ragChain.stream({ question, k: 2 })

        // 一边生成一边打印，体验类似 ChatGPT
        for await (const chunk of stream) {
            process.stdout.write(chalk.green(chunk))
        }
        console.log("\n")
    } catch (err) {
        // 处理"没检索到内容"的兜底
        if (err.message?.startsWith("__NO_CONTEXT__:")) {
            console.log(chalk.yellow(err.message.replace("__NO_CONTEXT__:", "")))
        } else {
            console.error(chalk.red("RAG 链执行出错："), err)
        }
    }

    // 第二个问题：演示"没命中任何片段"的兜底分支
    console.log(chalk.bgGreen("\n【第二个问题】"))
    const q2 = "葫芦娃和奥特曼谁厉害？"
    console.log(chalk.bgGreen(`【用户提问】${q2}\n`))
    try {
        const r = await ragChain.invoke({ question: q2 })
        console.log(r)
    } catch (err) {
        if (err.message?.startsWith("__NO_CONTEXT__:")) {
            console.log(chalk.yellow(err.message.replace("__NO_CONTEXT__:", "")))
        } else {
            console.error(err)
        }
    }
}

await main()

// ============================================
// 【知识点总结】
// ============================================
console.log(chalk.bgMagenta("\n=== 【知识点总结】==="))
console.log(`
1. RAG 的标准 5 步骨架（背下来！）
   Retrieve → Augment(拼context) → Prompt → Generate → Parse
   每一步都可以独立替换：
   - Retrieve 换成 BM25 / 关键词搜索 / 多路召回
   - Generate 换成不同 LLM
   - Parse 换成 JsonOutputParser / StructuredOutputParser

2. 为什么 RAG 链是 LCEL 的天然范例？
   - 步骤多、串行依赖，正是 RunnableSequence 最擅长的
   - 整条链自动获得 .stream() / .batch()，对话式应用零改造

3. 链中的"小技巧"
   - 用 RunnableLambda 包装检索/拼 context 这种业务函数
   - 上一步输出对象的字段名，要和下一步 PromptTemplate 的占位符匹配
     （例如 promptTemplate 里写了 {question} 和 {context}，
      上一步就必须返回 { question, context }）
   - 用一个"守卫节点"（guardEmptyContext）做兜底逻辑

4. 从这个教学版怎么变成生产版？
   - 把 mockRetriever 换成 OpenAIEmbeddings + MilvusClient.search()
     （参考原版 ebook-reader-rag.mjs 第 30~70 行）
   - 真实 score 来自向量相似度，比关键词命中精确得多
   - 集合需要先用 ebook-writer.mjs 灌数据建好

5. 容易踩的坑
   - 检索到空内容也强行调 LLM → 浪费钱、回答容易胡说
     （所以一定要写 guardEmptyContext 这种兜底节点）
   - PromptTemplate 字段名拼错 → 链直接报错
   - context 拼太长超过模型上下文 → 一定要做 topK 限制
`)
