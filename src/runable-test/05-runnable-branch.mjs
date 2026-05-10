// ============================================
// 05-runnable-branch.mjs
// ============================================
// 职责：学习 RunnableBranch 条件分支 + RunnableEach 批量处理
//
// 关键流程：
// 1. RunnableBranch.from([ [条件, 分支], [条件2, 分支2], 默认分支 ])
// 2. 条件是一个返回 boolean 的 Runnable（或普通函数）
// 3. 从上到下匹配第一个为 true 的条件，执行对应分支
// 4. RunnableEach 对数组的每个元素应用同一个 Runnable
//
// 知识扩展（小白能懂）：
// - RunnableBranch 就是"智能路由器"，根据输入特征走不同路径
// - 执行顺序：从上到下匹配，第一个符合条件的分支被执行，其他被忽略
// - 如果没有条件匹配，执行最后一个"默认分支"
// - 类比：快递分拣机器人，根据包裹目的地选择不同的传送带
// - RunnableEach 就像"批量处理机"，把同一个工序应用到一堆物品上
// ============================================

import "dotenv/config"
import { RunnableBranch, RunnableLambda, RunnableEach, RunnableSequence } from "@langchain/core/runnables"

// ============================================
// 示例1：RunnableBranch —— 根据数字特征走不同分支
// ============================================
console.log("=".repeat(60))
console.log("【示例1】RunnableBranch —— 条件分支路由")
console.log("=".repeat(60))

// 条件判断函数
const isPositive = RunnableLambda.from((input) => input > 0)
const isNegative = RunnableLambda.from((input) => input < 0)
const isZero = RunnableLambda.from((input) => input === 0)

// 分支处理函数
const handlePositive = RunnableLambda.from((input) => {
    const result = input + 10
    return `正数处理: ${input} + 10 = ${result}`
})

const handleNegative = RunnableLambda.from((input) => {
    const result = input - 10
    return `负数处理: ${input} - 10 = ${result}`
})

const handleZero = RunnableLambda.from((input) => {
    return `零处理: ${input} 是零，无需计算`
})

const handleDefault = RunnableLambda.from((input) => {
    return `默认处理: 无法识别的输入 ${input}`
})

// 创建分支路由：正数 → 负数 → 零 → 默认
const numberRouter = RunnableBranch.from([
    [isPositive, handlePositive],
    [isNegative, handleNegative],
    [isZero, handleZero],
    handleDefault  // 最后一个必须是默认分支（不需要条件）
])

// 测试不同输入
const testCases = [5, -3, 0, 999]
console.log("测试不同数字:\n")
for (const num of testCases) {
    const result = await numberRouter.invoke(num)
    console.log(`  输入: ${num} => ${result}`)
}

// ============================================
// 示例2：RunnableBranch —— 文本分类路由
// ============================================
console.log("\n" + "=".repeat(60))
console.log("【示例2】文本分类路由 —— 根据内容类型选择不同处理")
console.log("=".repeat(60))

// 模拟：根据用户请求类型，路由到不同的处理链
const isCodeRequest = RunnableLambda.from((input) =>
    input.query.toLowerCase().includes("代码") ||
    input.query.toLowerCase().includes("编程")
)

const isWeatherRequest = RunnableLambda.from((input) =>
    input.query.toLowerCase().includes("天气") ||
    input.query.toLowerCase().includes("温度")
)

const isGreeting = RunnableLambda.from((input) =>
    input.query.toLowerCase().includes("你好") ||
    input.query.toLowerCase().includes("hello")
)

const handleCode = RunnableLambda.from((input) => {
    return { type: "code", answer: `正在为你生成 "${input.query}" 的代码示例...` }
})

const handleWeather = RunnableLambda.from((input) => {
    return { type: "weather", answer: `正在查询 "${input.query}" 的天气信息...` }
})

const handleGreeting = RunnableLambda.from((input) => {
    return { type: "greeting", answer: "你好！有什么可以帮你的吗？" }
})

const handleGeneral = RunnableLambda.from((input) => {
    return { type: "general", answer: `收到问题: "${input.query}"，正在处理中...` }
})

const queryRouter = RunnableBranch.from([
    [isGreeting, handleGreeting],
    [isCodeRequest, handleCode],
    [isWeatherRequest, handleWeather],
    handleGeneral
])

const queries = [
    { query: "你好，请问在吗？" },
    { query: "给我写一段快速排序的代码" },
    { query: "北京明天天气怎么样？" },
    { query: "什么是量子计算？" }
]

console.log("测试不同查询:\n")
for (const q of queries) {
    const result = await queryRouter.invoke(q)
    console.log(`  查询: "${q.query}"`)
    console.log(`  => 类型: ${result.type}, 回复: ${result.answer}\n`)
}

// ============================================
// 示例3：RunnableEach —— 批量处理数组
// ============================================
console.log("\n" + "=".repeat(60))
console.log("【示例3】RunnableEach —— 对数组每个元素应用同一处理")
console.log("=".repeat(60))

// 定义单元素处理链：转大写 → 加问候语
const toUpperCase = RunnableLambda.from((input) => input.toUpperCase())
const addGreeting = RunnableLambda.from((input) => `你好，${input}！`)

const processOne = RunnableSequence.from([
    toUpperCase,
    addGreeting
])

// RunnableEach：对数组中的每个元素应用 processOne
const batchProcess = new RunnableEach({
    bound: processOne  // 绑定要重复执行的处理链
})

const names = ["alice", "bob", "carol"]
const resultEach = await batchProcess.invoke(names)

console.log("输入:", names)
console.log("输出:", resultEach)

// ============================================
// 示例4：组合 —— Branch + Each 批量分类处理
// ============================================
console.log("\n" + "=".repeat(60))
console.log("【示例4】组合 —— RunnableEach 包裹 RunnableBranch")
console.log("=".repeat(60))

// 对数组中的每个元素，先分类再处理
const classifyAndProcess = RunnableSequence.from([
    // 先判断正负
    RunnableBranch.from([
        [isPositive, RunnableLambda.from((n) => ({ value: n, category: "positive", processed: n * 2 }))],
        [isNegative, RunnableLambda.from((n) => ({ value: n, category: "negative", processed: Math.abs(n) }))],
        RunnableLambda.from((n) => ({ value: n, category: "zero", processed: 0 }))
    ])
])

const batchClassify = new RunnableEach({
    bound: classifyAndProcess
})

const numbers = [3, -5, 0, 7, -2]
const resultBatch = await batchClassify.invoke(numbers)

console.log("输入数字:", numbers)
console.log("批量分类结果:")
resultBatch.forEach((item) => {
    console.log(`  ${item.value} => ${item.category}, 处理后: ${item.processed}`)
})

// ============================================
// 【知识点总结】
// ============================================
console.log("\n" + "=".repeat(60))
console.log("【知识点总结】")
console.log("=".repeat(60))
console.log(`
1. RunnableBranch.from([ [条件1, 分支1], [条件2, 分支2], 默认分支 ])
   - 条件：返回 boolean 的函数或 Runnable
   - 匹配规则：从上到下，第一个为 true 的条件被执行
   - 默认分支：最后一个元素，不需要条件

2. 适用场景
   - 根据输入类型路由到不同处理（代码/天气/问候）
   - 根据内容长度选择不同模型（长文本 → GPT-4，短文本 → GPT-3.5）
   - 根据用户权限选择不同响应策略

3. RunnableEach({ bound: runnable }) —— 批量处理
   - 输入：数组
   - 输出：数组（每个元素经过 runnable 处理后的结果）
   - 适用：批量翻译、批量分类、批量格式化

4. 组合技巧
   - RunnableEach 的 bound 可以是任何 Runnable，包括 RunnableBranch
   - 先做 Branch 分类，再对每类用 Each 批量处理

5. 注意事项
   - Branch 的条件顺序很重要，排在前面的优先匹配
   - 如果没有默认分支，且所有条件都不匹配，会报错
   - RunnableEach 是顺序处理数组，不是真正的并行
`)
