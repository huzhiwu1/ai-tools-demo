// ============================================
// exercise-02-demo.mjs
// ============================================
// 职责：RunnableSequence + RunnableLambda 综合案例（参考版）
//
// 关键流程：
// 1. 用 RunnableLambda 定义多个自定义处理步骤
// 2. 用 RunnableSequence.from() 将步骤串成流水线
// 3. 数据在链中自动传递，每个步骤打印流转日志
// 4. 其中一个步骤读取 config 中的用户信息
// 5. 同时展示 .pipe() 的等价写法
//
// 知识扩展（小白能懂）：
// - 流水线就像工厂的生产线，每个工位处理一部分，然后传给下一个
// - RunnableLambda 是"万能适配器"，任何函数都能接入流水线
// - 数据传递的关键：上一步的输出格式 = 下一步的输入格式
// - 如果格式不匹配，用 RunnableLambda 做转换（像变压器一样）
// ============================================

import "dotenv/config"
import { RunnableLambda, RunnableSequence } from "@langchain/core/runnables"
import { ChatOpenAI } from "@langchain/openai"
import { PromptTemplate } from "@langchain/core/prompts"
import { StringOutputParser } from "@langchain/core/output_parsers"

const model = new ChatOpenAI({
    modelName: process.env.MODEL_NAME,
    apiKey: process.env.API_KEY,
    temperature: 0,
    configuration: { baseURL: process.env.BASE_URL }
})

// ============================================
// 步骤定义（每个都是一个 Runnable）
// ============================================

// 步骤1：清洗文本
const cleanText = RunnableLambda.from((input) => {
    const cleaned = input.rawText
        .trim()
        .replace(/\n{2,}/g, "\n")  // 连续2个以上换行合并为1个
    console.log(`  [步骤1 cleanText] 原始 ${input.rawText.length} 字 → 清洗后 ${cleaned.length} 字`)
    return { ...input, cleanedText: cleaned }
})

// 步骤2：验证字数
const validateLength = RunnableLambda.from((input) => {
    const len = input.cleanedText.length
    console.log(`  [步骤2 validateLength] 当前字数: ${len}`)
    if (len < 20) {
        throw new Error(`周报内容太短，只有 ${len} 字，要求至少 20 字`)
    }
    return { ...input, isValid: true }
})

// 步骤3：统计信息 + 读取 config
const addStats = RunnableLambda.from((input, config) => {
    const userName = config?.configurable?.userName ?? "未命名用户"
    const wordCount = input.cleanedText.length
    const lineCount = input.cleanedText.split("\n").filter(l => l.trim()).length

    console.log(`  [步骤3 addStats] userName=${userName}, 字数=${wordCount}, 行数=${lineCount}`)

    return {
        ...input,
        userName,
        stats: { wordCount, lineCount }
    }
})

// 步骤4：LLM 生成摘要（用 PromptTemplate + model + parser 组合）
const summaryPrompt = PromptTemplate.fromTemplate(
    "请用一句话总结以下周报内容（不超过30字）：\n\n{cleanedText}"
)

const summaryChain = RunnableSequence.from([
    summaryPrompt,           // 输入 {cleanedText} → 输出格式化字符串
    model,                   // 输入字符串 → 输出 AIMessage
    new StringOutputParser() // 输入 AIMessage → 输出纯字符串
])

// 步骤5：格式化最终输出
const formatOutput = RunnableLambda.from((input) => {
    console.log(`  [步骤5 formatOutput] 组装最终报告`)
    return {
        userName: input.userName,
        summary: input.cleanedText,  // 来自 summaryChain 的输出
        stats: input.stats,
        timestamp: new Date().toLocaleString()
    }
})

// ============================================
// 方式A：RunnableSequence.from() 组装完整链
// ============================================
console.log("=".repeat(60))
console.log("【方式A】RunnableSequence.from() 组装")
console.log("=".repeat(60))

// 注意：summaryChain 的输入和输出需要适配
// summaryChain 接收 {cleanedText}，输出字符串
// 但 formatOutput 需要接收完整对象，所以这里需要用一个 Lambda 做桥接
const chainA = RunnableSequence.from([
    cleanText,
    validateLength,
    addStats,
    // 桥接：先生成摘要，再把摘要塞回对象
    RunnableLambda.from(async (input) => {
        const summary = await summaryChain.invoke(input)
        return { ...input, summary }
    }),
    formatOutput
])

// 测试合法输入
console.log("\n--- 测试合法输入 ---")
try {
    const resultA = await chainA.invoke(
        { rawText: "本周完成了用户登录模块的开发\n修复了3个Bug\n下周计划做支付接口" },
        { configurable: { userName: "张三" } }
    )
    console.log("最终结果:")
    console.log(resultA)
} catch (e) {
    console.log("错误:", e.message)
}

// 测试非法输入（字数太少）
console.log("\n--- 测试非法输入 ---")
try {
    await chainA.invoke(
        { rawText: "太短了" },
        { configurable: { userName: "李四" } }
    )
} catch (e) {
    console.log("捕获到错误:", e.message)
}

// ============================================
// 方式B：.pipe() 语法糖（等价写法，更简洁）
// ============================================
console.log("\n" + "=".repeat(60))
console.log("【方式B】.pipe() 语法糖")
console.log("=".repeat(60))

// 先做前3步（清洗 → 验证 → 统计）
const preprocessingChain = cleanText
    .pipe(validateLength)
    .pipe(addStats)

// 再做后2步（摘要 → 格式化）
const fullChainB = preprocessingChain
    .pipe(RunnableLambda.from(async (input) => {
        const summary = await summaryChain.invoke(input)
        return { ...input, summary }
    }))
    .pipe(formatOutput)

console.log("\n--- 用 .pipe() 版本再跑一遍 ---")
const resultB = await fullChainB.invoke(
    { rawText: "本周完成了订单系统的重构\n优化了数据库查询性能\n新增缓存层设计" },
    { configurable: { userName: "王五" } }
)
console.log("最终结果:")
console.log(resultB)

// ============================================
// 关键对比
// ============================================
console.log("\n" + "=".repeat(60))
console.log("【两种写法对比】")
console.log("=".repeat(60))
console.log(`
RunnableSequence.from([a, b, c])
  优点：一目了然，适合步骤多、逻辑复杂的链
  场景：生产环境的主流程定义

a.pipe(b).pipe(c)
  优点：链式书写，像 jQuery 一样流畅
  场景：快速组装、局部组合、动态拼接

两者完全等价，任选一种即可。

数据传递的关键：
  1. 上一步输出什么，下一步就收到什么
  2. 对象用展开 {...input, newField: xxx} 保留旧数据
  3. 格式不匹配时，用 RunnableLambda 做"变压器"
`)
