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
import { PromptTemplate } from "@langchain/core/prompts"
import { StructuredOutputParser } from "@langchain/core/output_parsers"
import { RunnableSequence } from "@langchain/core/runnables"
import { z } from "zod"

const model = new ChatOpenAI({
    modelName: process.env.MODEL_NAME,
    apiKey: process.env.API_KEY,
    temperature: 0,
    configuration: { baseURL: process.env.BASE_URL }
})

// ========== 定义输出结构（翻译 + 关键词）==========
const schema = z.object({
    translation: z.string().describe("翻译后的英文文本"),
    keywords: z.array(z.string()).length(3).describe("3个关键词")
})

const outputParser = StructuredOutputParser.fromZodSchema(schema)

const promptTemplate = PromptTemplate.fromTemplate(
    "将以下文本翻译成英文，然后总结为3个关键词。\n\n文本：{text}\n\n{format_instructions}"
)

// ============================================
// 【传统方式】手动一步一步执行
// ============================================
console.log("=".repeat(60))
console.log("【传统方式】手动分步执行")
console.log("=".repeat(60))

const input = {
    text: "LangChain 是一个强大的 AI 应用开发框架",
    format_instructions: outputParser.getFormatInstructions()
}

// 步骤1：手动格式化 prompt
const formattedPrompt = await promptTemplate.format(input)
console.log("\n步骤1 - 格式化后的 Prompt：")
console.log(formattedPrompt.slice(0, 100) + "...")

// 步骤2：手动调用模型
const response = await model.invoke(formattedPrompt)
console.log("\n步骤2 - 模型原始输出：")
console.log(response.content.slice(0, 100) + "...")

// 步骤3：手动解析输出
const result = await outputParser.invoke(response)
console.log("\n步骤3 - 解析后的结果：")
console.log(result)

// ============================================
// 【Runnable 方式】链式组装，一次调用
// ============================================
console.log("\n" + "=".repeat(60))
console.log("【Runnable 方式】链式组装，一次调用")
console.log("=".repeat(60))

// 方法1：用 .pipe() 像水管一样串联
const chain1 = promptTemplate
    .pipe(model)
    .pipe(outputParser)

// 方法2：用 RunnableSequence.from() 显式声明（效果完全一样）
const chain2 = RunnableSequence.from([
    promptTemplate,
    model,
    outputParser
])

console.log("\n.chain1 和 chain2 是完全等价的，任选一种即可。")
console.log("现在调用 chain1.invoke()，只需一行代码：\n")

const result2 = await chain1.invoke(input)
console.log("链式调用结果：")
console.log(result2)

// ============================================
// 【对比总结】
// ============================================
console.log("\n" + "=".repeat(60))
console.log("【对比总结】")
console.log("=".repeat(60))
console.log(`
传统方式：
  const step1 = await A.format(input)
  const step2 = await B.invoke(step1)
  const step3 = await C.invoke(step2)
  // 3 行调用 + 2 个中间变量

Runnable 方式：
  const chain = A.pipe(B).pipe(C)
  const result = await chain.invoke(input)
  // 1 行调用 + 0 个中间变量

核心优势：
  1. 组装一次，多次复用 —— chain 可以像函数一样反复调用
  2. 可组合性 —— 小 chain 可以拼成大 chain
  3. 可扩展性 —— 可以叠加 retry、fallback、history 等能力
  4. 类型安全 —— 每个 Runnable 的输入输出类型是明确的
`)
