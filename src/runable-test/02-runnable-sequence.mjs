// ============================================
// 02-runnable-sequence.mjs
// ============================================
// 职责：学习 RunnableSequence 链式调用 + RunnableLambda 自定义函数
//
// 关键流程：
// 1. 用 RunnableLambda.from() 把普通函数包装成 Runnable
// 2. 用 RunnableSequence.from() 将多个 Runnable 串成链
// 3. 数据在链中自动传递：前一环节的输出 = 后一环节的输入
// 4. 调用 chain.invoke() 一次性执行整条链
//
// 知识扩展（小白能懂）：
// - RunnableSequence 就是"流水线"，每个工位处理完后传给下一个工位
// - RunnableLambda 是"万能转换器"，任何函数都能包装成 Runnable 参与流水线
// - 链中的数据传递规则：
//   * 如果前一个输出是字符串/数字 → 直接传给下一个作为输入
//   * 如果前一个输出是对象 → 尝试匹配下一个的输入字段名
// - 为什么需要 RunnableLambda？因为普通函数没有 .pipe() 方法，不能参与链式组装
// - 实际开发中，RunnableLambda 常用于：数据清洗、格式转换、日志打印、条件判断
// ============================================

import "dotenv/config"
import { RunnableLambda, RunnableSequence } from "@langchain/core/runnables"
import { ChatOpenAI } from "@langchain/openai"
import { PromptTemplate } from "@langchain/core/prompts"
import { StringOutputParser } from "@langchain/core/output_parsers"

// ============================================
// 示例1：纯函数链（不用 LLM，理解数据流转）
// ============================================
console.log("=".repeat(60))
console.log("【示例1】纯函数链 —— 理解数据如何在链中流转")
console.log("=".repeat(60))

// 用 RunnableLambda.from() 把普通函数包装成 Runnable
const addOne = RunnableLambda.from((input) => {
    console.log(`  [addOne] 收到: ${input}, 输出: ${input + 1}`)
    return input + 1
})

const multiplyTwo = RunnableLambda.from((input) => {
    console.log(`  [multiplyTwo] 收到: ${input}, 输出: ${input * 2}`)
    return input * 2
})

const toString = RunnableLambda.from((input) => {
    console.log(`  [toString] 收到: ${input}, 输出: "结果: ${input}"`)
    return `结果: ${input}`
})

// 组装链：输入 → addOne → multiplyTwo → toString
const mathChain = RunnableSequence.from([
    addOne,        // 输入 5 → 输出 6
    multiplyTwo,   // 输入 6 → 输出 12
    toString       // 输入 12 → 输出 "结果: 12"
])

const result1 = await mathChain.invoke(5)
console.log(`\n最终输出: ${result1}`)
// 计算过程: 5 + 1 = 6 → 6 * 2 = 12 → "结果: 12"

// ============================================
// 示例2：混合链（PromptTemplate + LLM + 后处理）
// ============================================
console.log("\n" + "=".repeat(60))
console.log("【示例2】混合链 —— PromptTemplate + LLM + RunnableLambda 后处理")
console.log("=".repeat(60))

const model = new ChatOpenAI({
    modelName: process.env.MODEL_NAME,
    apiKey: process.env.API_KEY,
    temperature: 0,
    configuration: { baseURL: process.env.BASE_URL }
})

const prompt = PromptTemplate.fromTemplate(
    "请用一句话总结以下技术概念：{concept}"
)

// 后处理：给 LLM 输出加上 emoji 和格式化
const addEmoji = RunnableLambda.from((text) => {
    console.log(`  [addEmoji] 收到原文: ${text}`)
    return `✨ ${text} ✨`
})

// 组装链：输入变量 → 格式化 Prompt → LLM 生成 → 添加 emoji
const summaryChain = RunnableSequence.from([
    prompt,              // 输入 {concept: "..."} → 输出格式化字符串
    model,               // 输入字符串 → 输出 AIMessage
    new StringOutputParser(), // 输入 AIMessage → 输出纯字符串
    addEmoji             // 输入字符串 → 输出带 emoji 的字符串
])

const result2 = await summaryChain.invoke({ concept: "RunnableSequence" })
console.log(`\n最终输出: ${result2}`)

// ============================================
// 示例3：RunnableLambda 的第二个参数 config
// ============================================
console.log("\n" + "=".repeat(60))
console.log("【示例3】RunnableLambda 的 config 参数 —— 获取运行时配置")
console.log("=".repeat(60))

const logWithConfig = RunnableLambda.from((input, config) => {
    // config 包含了当前 chain 的运行时配置
    const runId = config?.runId ?? "unknown"
    const tags = config?.tags ?? []
    console.log(`  [logWithConfig] 输入: ${input}`)
    console.log(`  [logWithConfig] runId: ${runId}`)
    console.log(`  [logWithConfig] tags: ${JSON.stringify(tags)}`)
    return input
})

const configChain = RunnableSequence.from([
    addOne,
    logWithConfig,
    multiplyTwo
])

const result3 = await configChain.invoke(10, {
    tags: ["demo", "math"],
    metadata: { userId: "123" }
})
console.log(`\n最终输出: ${result3}`)

// ============================================
// 【知识点总结】
// ============================================
console.log("\n" + "=".repeat(60))
console.log("【知识点总结】")
console.log("=".repeat(60))
console.log(`
1. RunnableLambda.from(fn) —— 把普通函数变成 Runnable
   - fn 可以是同步函数或异步函数
   - fn 接收两个参数：(input, config)

2. RunnableSequence.from([r1, r2, r3]) —— 串行执行
   - r1 的输出 → r2 的输入 → r3 的输入
   - 任何一个环节报错，整个 chain 中断

3. .pipe() 是 RunnableSequence 的语法糖
   - prompt.pipe(model).pipe(parser) === RunnableSequence.from([prompt, model, parser])

4. 数据传递的适配规则
   - 如果下一个 Runnable 期望对象（如 PromptTemplate），
     但上一个输出是字符串，LangChain 会尝试自动适配
   - 最佳实践：用 RunnableLambda 做显式转换，避免隐式行为
`)
