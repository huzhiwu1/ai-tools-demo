// ============================================
// 03-runnable-map.mjs
// ============================================
// 职责：学习 RunnableMap —— 并行执行多个任务
//
// 关键流程：
// 1. 定义多个独立的 Runnable（可以是函数、PromptTemplate 等）
// 2. 用 RunnableMap.from({ key1: runnable1, key2: runnable2 }) 并行组装
// 3. 调用 invoke()，同一个输入会同时传给所有分支
// 4. 输出是一个对象，每个 key 对应一个分支的结果
//
// 知识扩展（小白能懂）：
// - RunnableMap 就像"多开窗口"，同一个输入同时走多个处理路径
// - 并行意味着：分支之间互不干扰，同时执行，总耗时 = 最慢的分支
// - 适用场景：
//   * 同时提取不同维度的信息（摘要 + 关键词 + 情感分析）
//   * 同时生成不同风格的文案（正式版 + 口语版 + 英文版）
//   * 同时调用不同工具（查天气 + 查路线 + 查餐厅）
// - 注意：RunnableMap 是"并行"不是"并发"（在单线程中），
//   真正的并行需要结合其他机制
// ============================================

import "dotenv/config"
import { RunnableMap, RunnableLambda, RunnableSequence } from "@langchain/core/runnables"
import { ChatOpenAI } from "@langchain/openai"
import { PromptTemplate } from "@langchain/core/prompts"
import { StringOutputParser } from "@langchain/core/output_parsers"

// ============================================
// 示例1：纯函数并行 —— 同时做多种数学运算
// ============================================
console.log("=".repeat(60))
console.log("【示例1】纯函数并行 —— 同时做多种运算")
console.log("=".repeat(60))

const addOne = RunnableLambda.from((input) => {
    const result = input.num + 1
    console.log(`  [addOne] ${input.num} + 1 = ${result}`)
    return result
})

const multiplyTwo = RunnableLambda.from((input) => {
    const result = input.num * 2
    console.log(`  [multiplyTwo] ${input.num} * 2 = ${result}`)
    return result
})

const square = RunnableLambda.from((input) => {
    const result = input.num * input.num
    console.log(`  [square] ${input.num} ^ 2 = ${result}`)
    return result
})

// RunnableMap：同一个输入 {num: 5} 同时传给 add、multiply、square
const mathMap = RunnableMap.from({
    add: addOne,
    multiply: multiplyTwo,
    square: square
})

const result1 = await mathMap.invoke({ num: 5 })
console.log("\n并行计算结果:")
console.log(result1)
// { add: 6, multiply: 10, square: 25 }

// ============================================
// 示例2：PromptTemplate 并行 —— 同时生成不同风格的文案
// ============================================
console.log("\n" + "=".repeat(60))
console.log("【示例2】PromptTemplate 并行 —— 同时生成不同风格")
console.log("=".repeat(60))

const model = new ChatOpenAI({
    modelName: process.env.MODEL_NAME,
    apiKey: process.env.API_KEY,
    temperature: 0.7,
    configuration: { baseURL: process.env.BASE_URL }
})

const parser = new StringOutputParser()

// 定义三种不同风格的 prompt
const formalPrompt = PromptTemplate.fromTemplate(
    "请用正式的商务语气，为以下产品写一句宣传语：{product}"
)
const casualPrompt = PromptTemplate.fromTemplate(
    "请用轻松随意的口语，为以下产品写一句宣传语：{product}"
)
const poeticPrompt = PromptTemplate.fromTemplate(
    "请用诗意的语言，为以下产品写一句宣传语：{product}"
)

// 每个风格都是一个 chain：prompt → model → parser
const formalChain = RunnableSequence.from([formalPrompt, model, parser])
const casualChain = RunnableSequence.from([casualPrompt, model, parser])
const poeticChain = RunnableSequence.from([poeticPrompt, model, parser])

// RunnableMap：同时生成三种风格
const multiStyleMap = RunnableMap.from({
    formal: formalChain,
    casual: casualChain,
    poetic: poeticChain
})

const result2 = await multiStyleMap.invoke({ product: "智能咖啡机" })
console.log("\n三种风格的宣传语:")
console.log("【正式版】:", result2.formal)
console.log("【口语版】:", result2.casual)
console.log("【诗意版】:", result2.poetic)

// ============================================
// 示例3：RunnableMap + RunnableSequence 组合 —— 先并行再串行
// ============================================
console.log("\n" + "=".repeat(60))
console.log("【示例3】组合使用 —— RunnableMap 嵌套在 RunnableSequence 中")
console.log("=".repeat(60))

// 步骤1：并行提取多个维度的信息
const extractMap = RunnableMap.from({
    summary: RunnableSequence.from([
        PromptTemplate.fromTemplate("请用一句话总结：{text}"),
        model,
        parser
    ]),
    keywords: RunnableSequence.from([
        PromptTemplate.fromTemplate("请从以下文本中提取3个关键词，用逗号分隔：{text}"),
        model,
        parser
    ]),
    sentiment: RunnableSequence.from([
        PromptTemplate.fromTemplate("请判断以下文本的情感倾向（正面/负面/中性）：{text}"),
        model,
        parser
    ])
})

// 步骤2：把并行的结果合并成最终报告
const mergeReport = RunnableLambda.from((input) => {
    console.log("  [mergeReport] 收到并行结果，合并成报告")
    return {
        originalText: input.text,
        summary: input.summary,
        keywords: input.keywords,
        sentiment: input.sentiment,
        reportGeneratedAt: new Date().toISOString()
    }
})

// 组装：先并行提取（extractMap），再合并报告（mergeReport）
const analysisChain = RunnableSequence.from([
    // 先并行提取多个维度
    extractMap,
    // 再合并成报告（注意：extractMap 的输出不会自动带上原始 text，
    // 这里为了演示简化，实际项目中可以用 RunnablePassthrough 保留原始输入）
    mergeReport
])

const result3 = await analysisChain.invoke({
    text: "LangChain 是一个非常优秀的 AI 开发框架，文档清晰，社区活跃，强烈推荐！"
})
console.log("\n分析报告:")
console.log(JSON.stringify(result3, null, 2))

// ============================================
// 【知识点总结】
// ============================================
console.log("\n" + "=".repeat(60))
console.log("【知识点总结】")
console.log("=".repeat(60))
console.log(`
1. RunnableMap.from({ key: runnable }) —— 并行执行多个分支
   - 输入：同一个对象同时传给所有分支
   - 输出：{ key1: result1, key2: result2, ... }

2. 适用场景
   - 多维度分析（摘要 + 关键词 + 情感）
   - 多风格生成（正式 + 口语 + 诗意）
   - 多源查询（同时调多个 API/工具）

3. 常见组合模式
   - RunnableSequence.from([ RunnableMap, 后处理 ]) —— 先并行再串行
   - RunnableMap.from({ a: chain1, b: chain2 }) —— 纯并行

4. 注意事项
   - 各分支是"逻辑并行"，JS 单线程中实际是顺序执行
   - 如果分支之间需要共享状态，不能用 RunnableMap
   - 输出是对象，下一个 Runnable 要能处理对象类型输入
`)
