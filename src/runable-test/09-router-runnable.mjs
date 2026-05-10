// ============================================
// 09-router-runnable.mjs
// ============================================
// 职责：学习 RouterRunnable —— 根据 key 路由到不同的处理逻辑
//
// 关键流程：
// 1. 定义多个独立的 Runnable（不同处理逻辑）
// 2. 用 RouterRunnable 把这些 Runnable 注册到不同的 key 下
// 3. 调用时传入 { key: "xxx", input: "..." }，Router 自动分发
// 4. 适合"一个入口，多种处理"的场景
//
// 知识扩展（小白能懂）：
// - RouterRunnable 就像"智能交换机"，根据来电号码转接到不同部门
// - 和 RunnableBranch 的区别：
//   * RunnableBranch：根据"条件判断"自动路由（if/else 逻辑）
//   * RouterRunnable：根据"显式 key"路由（用户指定走哪条路）
// - 适用场景：多模型网关（用户选 GPT-4 还是 Claude）、多工具调度、多技能 Agent
// - RouterRunnable 是"显式路由"，调用方决定走哪条路
// - 与之对比，RunnableBranch 是"隐式路由"，chain 自己判断走哪条路
// ============================================

import "dotenv/config"
import { RouterRunnable, RunnableLambda, RunnableSequence } from "@langchain/core/runnables"
import { ChatOpenAI } from "@langchain/openai"
import { PromptTemplate } from "@langchain/core/prompts"
import { StringOutputParser } from "@langchain/core/output_parsers"

// ============================================
// 示例1：基础路由 —— 根据 key 选择不同文本处理
// ============================================
console.log("=".repeat(60))
console.log("【示例1】基础路由 —— 文本处理路由")
console.log("=".repeat(60))

const toUpperCase = RunnableLambda.from((text) => text.toUpperCase())
const toLowerCase = RunnableLambda.from((text) => text.toLowerCase())
const reverseText = RunnableLambda.from((text) => text.split("").reverse().join(""))
const countChars = RunnableLambda.from((text) => ({ text, length: text.length }))

// 创建路由器：把多个处理函数注册到不同 key
const textRouter = new RouterRunnable({
    runnables: {
        upper: toUpperCase,
        lower: toLowerCase,
        reverse: reverseText,
        count: countChars
    }
})

// 测试不同路由
const testInputs = [
    { key: "upper", input: "Hello World" },
    { key: "lower", input: "Hello World" },
    { key: "reverse", input: "Hello World" },
    { key: "count", input: "Hello World" }
]

console.log("测试不同路由:\n")
for (const test of testInputs) {
    const result = await textRouter.invoke(test)
    console.log(`  路由: ${test.key}, 输入: "${test.input}"`)
    console.log(`  输出: ${JSON.stringify(result)}\n`)
}

// ============================================
// 示例2：多模型路由 —— 根据 key 选择不同模型/参数
// ============================================
console.log("\n" + "=".repeat(60))
console.log("【示例2】多模型路由 —— 选择不同模型处理")
console.log("=".repeat(60))

const model = new ChatOpenAI({
    modelName: process.env.MODEL_NAME,
    apiKey: process.env.API_KEY,
    temperature: 0,
    configuration: { baseURL: process.env.BASE_URL }
})

// 创意写作链（高 temperature）
const creativeChain = RunnableSequence.from([
    PromptTemplate.fromTemplate("请用富有创意的方式改写以下句子：{text}"),
    model.bind({ temperature: 0.9 }),
    new StringOutputParser()
])

// 精准翻译链（低 temperature）
const preciseChain = RunnableSequence.from([
    PromptTemplate.fromTemplate("请准确翻译以下句子：{text}"),
    model.bind({ temperature: 0 }),
    new StringOutputParser()
])

// 简洁摘要链
const summaryChain = RunnableSequence.from([
    PromptTemplate.fromTemplate("请用一句话概括：{text}"),
    model.bind({ temperature: 0 }),
    new StringOutputParser()
])

// 创建模型路由器
const modelRouter = new RouterRunnable({
    runnables: {
        creative: creativeChain,
        translate: preciseChain,
        summary: summaryChain
    }
})

const sentence = "春风又绿江南岸，明月何时照我还。"

console.log(`输入文本: "${sentence}"\n`)

const creativeResult = await modelRouter.invoke({ key: "creative", text: sentence })
console.log(`【创意改写】: ${creativeResult}`)

const translateResult = await modelRouter.invoke({ key: "translate", text: sentence })
console.log(`\n【精准翻译】: ${translateResult}`)

const summaryResult = await modelRouter.invoke({ key: "summary", text: sentence })
console.log(`\n【简洁摘要】: ${summaryResult}`)

// ============================================
// 示例3：工具路由 —— 模拟 Agent 的工具选择
// ============================================
console.log("\n" + "=".repeat(60))
console.log("【示例3】工具路由 —— 模拟多工具 Agent")
console.log("=".repeat(60))

// 模拟各种"工具"
const searchTool = RunnableLambda.from(async (input) => {
    return { tool: "search", result: `搜索结果：关于 "${input.query}" 的 10 条相关信息...` }
})

const calculatorTool = RunnableLambda.from(async (input) => {
    // 简单模拟计算
    const result = eval(input.expression) // 注意：生产环境不要直接用 eval
    return { tool: "calculator", expression: input.expression, result }
})

const weatherTool = RunnableLambda.from(async (input) => {
    const mockWeather = { "北京": "晴 25°C", "上海": "多云 22°C", "广州": "雨 28°C" }
    return { tool: "weather", city: input.city, weather: mockWeather[input.city] ?? "未知" }
})

const translateTool = RunnableLambda.from(async (input) => {
    return { tool: "translate", text: input.text, target: input.target, result: `[已翻译为${input.target}]` }
})

// 工具路由器
const toolRouter = new RouterRunnable({
    runnables: {
        search: searchTool,
        calculator: calculatorTool,
        weather: weatherTool,
        translate: translateTool
    }
})

// 模拟 Agent 选择工具并调用
console.log("模拟 Agent 调用不同工具:\n")

const toolCalls = [
    { key: "search", query: "LangChain 最新版本" },
    { key: "calculator", expression: "1024 * 768" },
    { key: "weather", city: "北京" },
    { key: "translate", text: "Hello World", target: "中文" }
]

for (const call of toolCalls) {
    const result = await toolRouter.invoke(call)
    console.log(`  工具: ${result.tool}`)
    console.log(`  结果: ${JSON.stringify(result, null, 2)}\n`)
}

// ============================================
// 【知识点总结】
// ============================================
console.log("\n" + "=".repeat(60))
console.log("【知识点总结】")
console.log("=".repeat(60))
console.log(`
1. new RouterRunnable({ runnables: { key: runnable } })
   - 作用：根据显式 key 路由到对应的 Runnable
   - 输入：{ key: "xxx", input: "..." }（注意：input 会被完整传给对应的 runnable）
   - 输出：对应 runnable 的执行结果

2. RouterRunnable vs RunnableBranch
   +------------------+----------------------+----------------------+
   | 特性             | RouterRunnable       | RunnableBranch       |
   +------------------+----------------------+----------------------+
   | 路由依据         | 显式 key             | 条件判断（boolean）  |
   | 谁决定路由       | 调用方               | chain 自己           |
   | 适用场景         | 多模型、多工具网关   | 条件分支逻辑         |
   | 灵活性           | 低（需指定key）      | 高（自动判断）       |
   +------------------+----------------------+----------------------+

3. 适用场景
   - 多模型网关：用户指定用 GPT-4 还是 Claude
   - 多工具调度：Agent 决定调用搜索、计算还是查天气
   - 多语言处理：根据语言代码路由到对应的翻译模型
   - 多技能 Agent：根据意图路由到不同的技能模块

4. 注意事项
   - key 必须是字符串，且必须在 runnables 中已注册
   - 如果 key 不存在，会抛出错误
   - 输入对象的 key 字段会被消费，其余字段传给目标 runnable
`)
