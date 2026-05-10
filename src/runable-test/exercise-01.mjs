// ============================================
// 01-why-runnable.mjs
// ============================================
// 职责：理解什么是 Runnable，以及为什么需要它
//
// 关键流程：
// 1. 先看 "传统方式"：手动一步一步调用（format → invoke → parse）
// 2. 再看 "Runnable 方式"：用 .pipe() 把步骤串成链，一次 invoke
// 3. 对比两种方式，理解 Runnable 带来的好处
//
// 知识扩展（小白能懂）：
// - Runnable 是 LangChain 的"乐高积木"，任何能执行的东西都是 Runnable
//   * PromptTemplate 是 Runnable（输入变量 → 输出字符串）
//   * ChatOpenAI 是 Runnable（输入消息 → 输出回复）
//   * OutputParser 是 Runnable（输入文本 → 输出结构化数据）
// - 传统方式像"手工组装"，每一步都要手动调用、手动传参
// - Runnable 方式像"流水线"，组装好后只调用一次，中间数据自动传递
// - 好处1：代码更简洁，不用写中间变量
// - 好处2：可以复用 chain，像函数一样传入不同参数
// - 好处3：可以叠加能力（重试、降级、历史消息等），像给手机套壳
// ============================================

import "dotenv/config"
import { ChatOpenAI } from "@langchain/openai"
import { RunnableSequence } from "@langchain/core/runnables"
import { PromptTemplate } from "@langchain/core/prompts"

import { z } from "zod"

const model = new ChatOpenAI({
    apiKey: process.env.API_KEY,
    modelName: process.env.MODEL_NAME,
    temperature: 0,
    configuration: {
        baseURL: process.env.BASE_URL,
    },
})

const schema = z.object({
    summary: z.string().describe("文章摘要"),
    sentiment: z.string().describe("文章情感倾向"),
    wordCount: z.number().describe("文章字数"),
})

const article = `人工智能正在以前所未有的速度改变着我们的生活。从自动驾驶汽车到智能语音助手，AI技术已经渗透到了日常生活的方方面面。特别是在自然语言处理领域，大语言模型的出现让机器能够更好地理解和生成人类语言，这不仅提高了工作效率，也为创意产业带来了无限可能。面对这样的技术变革，我们应当保持乐观积极的态度，拥抱变化，共同创造更加美好的未来。`
const modelWithSchema = model.withStructuredOutput(schema)

const promptTemplate = PromptTemplate.fromTemplate("请对以下文章进行摘要，并指出文章的情感倾向和字数。\n\n{article}")

const runnable1 = RunnableSequence.from([
    promptTemplate,
    modelWithSchema,
])

console.log("===== RunnableSequence =====")
const result1 = await runnable1.invoke({ article })
console.log("===== 结果 =====")
console.log(result1)

const chain = promptTemplate.pipe(modelWithSchema)
console.log("===== chain =====")

const result2 = await chain.invoke({ article })
console.log("===== 结果 =====")
console.log(result2)
