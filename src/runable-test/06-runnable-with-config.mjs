// ============================================
// 06-runnable-with-config.mjs
// ============================================
// 职责：学习 RunnableWithConfig —— 运行时配置 + Callbacks 观测
//
// 关键流程：
// 1. chain.withConfig({ configurable: {...} }) 为整条链绑定配置
// 2. 在 RunnableLambda 中通过第二个参数 config 读取配置
// 3. config.configurable 中存放自定义配置（userId、role、locale 等）
// 4. 通过 callbacks 观测 chain 的执行过程（开始、结束、错误）
//
// 知识扩展（小白能懂）：
// - withConfig 就像"给流水线贴上标签"，每个产品批次可以有不同的加工要求
// - configurable 是"用户自定义配置区"，可以传任何你需要的数据
// - 为什么不用全局变量？因为全局变量在并发时会互相干扰，config 是线程安全的
// - callbacks 就像"车间监控摄像头"，让你看到每个工位的实时状态
// - 在生产环境中，callbacks 常用于：日志记录、性能监控、链路追踪
// ============================================

import "dotenv/config"
import { RunnableLambda, RunnableSequence } from "@langchain/core/runnables"

// ============================================
// 示例1：withConfig —— 为 chain 绑定运行时配置
// ============================================
console.log("=".repeat(60))
console.log("【示例1】withConfig —— 运行时配置")
console.log("=".repeat(60))

// 模拟用户数据库
const mockUsers = new Map([
    ["user-123", { id: "user-123", name: "张三", level: "VIP" }],
    ["user-456", { id: "user-456", name: "李四", level: "普通" }]
])

// 节点1：根据 config 中的 userId 查询用户信息
const fetchUser = RunnableLambda.from(async (input, config) => {
    const userId = config?.configurable?.userId
    console.log(`  [fetchUser] 从 config 拿到 userId: ${userId}`)

    const user = userId ? mockUsers.get(userId) : null
    if (!user) {
        throw new Error(`未找到用户: ${userId}`)
    }
    return { ...input, user }
})

// 节点2：根据 config 中的 locale 生成不同语言的回复
const formatByLocale = RunnableLambda.from(async (input, config) => {
    const locale = config?.configurable?.locale ?? "zh-CN"
    const tone = config?.configurable?.tone ?? "正式"

    console.log(`  [formatByLocale] locale: ${locale}, tone: ${tone}`)

    let greeting
    if (locale === "en-US") {
        greeting = tone === "casual" ? "Hey" : "Dear"
    } else if (locale === "ja-JP") {
        greeting = "様"
    } else {
        greeting = tone === "casual" ? "嗨" : "尊敬的"
    }

    return {
        ...input,
        locale,
        tone,
        greeting,
        message: `${greeting} ${input.user.name}，欢迎使用我们的服务！`
    }
})

// 节点3：根据用户等级调整回复内容
const applyVIPBonus = RunnableLambda.from(async (input, config) => {
    const isVIP = input.user.level === "VIP"
    console.log(`  [applyVIPBonus] 用户等级: ${input.user.level}, VIP: ${isVIP}`)

    return {
        ...input,
        vipMessage: isVIP ? "作为 VIP 用户，您享有专属客服通道。" : "",
        finalMessage: isVIP
            ? `${input.message} ${input.vipMessage}`
            : input.message
    }
})

// 组装基础链
const baseChain = RunnableSequence.from([
    fetchUser,
    formatByLocale,
    applyVIPBonus
])

// 用 withConfig 创建两个不同配置的链
const chainForZhangsan = baseChain.withConfig({
    configurable: {
        userId: "user-123",
        locale: "zh-CN",
        tone: "正式"
    }
})

const chainForLisiEnglish = baseChain.withConfig({
    configurable: {
        userId: "user-456",
        locale: "en-US",
        tone: "casual"
    }
})

// 调用不同的配置链
console.log("\n--- 张三（中文正式版）---")
const result1 = await chainForZhangsan.invoke({ action: "login" })
console.log(`最终消息: ${result1.finalMessage}`)

console.log("\n--- 李四（英文随意版）---")
const result2 = await chainForLisiEnglish.invoke({ action: "login" })
console.log(`最终消息: ${result2.finalMessage}`)

// ============================================
// 示例2：Callbacks —— 观测 chain 执行过程
// ============================================
console.log("\n" + "=".repeat(60))
console.log("【示例2】Callbacks —— 观测执行过程")
console.log("=".repeat(60))

// 定义 callback 处理器
const myCallback = {
    handleChainStart(chain, inputs, runId) {
        const step = chain?.id?.[chain.id.length - 1] ?? "unknown"
        console.log(`  [CALLBACK START] step=${step}, runId=${runId?.slice(0, 8)}...`)
    },
    handleChainEnd(output, runId) {
        console.log(`  [CALLBACK END]   output=${JSON.stringify(output).slice(0, 60)}..., runId=${runId?.slice(0, 8)}...`)
    },
    handleChainError(err, runId) {
        console.log(`  [CALLBACK ERROR] ${err.message}, runId=${runId?.slice(0, 8)}...`)
    }
}

// 定义一个会出错的链，演示错误回调
const safeDivide = RunnableLambda.from((input) => {
    if (input.divisor === 0) {
        throw new Error("除数不能为零")
    }
    return { result: input.dividend / input.divisor }
})

const safeChain = RunnableSequence.from([
    RunnableLambda.from((input) => ({ dividend: input.a, divisor: input.b })),
    safeDivide,
    RunnableLambda.from((input) => `计算结果: ${input.result}`)
])

console.log("\n--- 正常情况 ---")
const result3 = await safeChain.invoke({ a: 10, b: 2 }, {
    callbacks: [myCallback]
})
console.log(`结果: ${result3}`)

console.log("\n--- 错误情况 ---")
try {
    await safeChain.invoke({ a: 10, b: 0 }, {
        callbacks: [myCallback]
    })
} catch (e) {
    console.log(`捕获到错误: ${e.message}`)
}

// ============================================
// 示例3：组合 —— withConfig + callbacks 同时使用
// ============================================
console.log("\n" + "=".repeat(60))
console.log("【示例3】组合使用 —— withConfig + callbacks")
console.log("=".repeat(60))

const loggingCallback = {
    handleChainStart(chain, inputs, runId) {
        console.log(`  [LOG] 步骤开始 | 输入: ${JSON.stringify(inputs).slice(0, 50)}`)
    },
    handleChainEnd(output, runId) {
        console.log(`  [LOG] 步骤结束 | 输出: ${JSON.stringify(output).slice(0, 50)}`)
    }
}

const step1 = RunnableLambda.from((input) => {
    console.log("  [执行] step1: 数据清洗")
    return input.trim().toLowerCase()
})

const step2 = RunnableLambda.from((input) => {
    console.log("  [执行] step2: 数据转换")
    return { original: input, length: input.length, words: input.split(" ") }
})

const step3 = RunnableLambda.from((input) => {
    console.log("  [执行] step3: 数据统计")
    return `文本 "${input.original}" 包含 ${input.words.length} 个单词`
})

const demoChain = RunnableSequence.from([step1, step2, step3])

const finalResult = await demoChain.invoke("  Hello World From LangChain  ", {
    callbacks: [loggingCallback],
    configurable: {
        requestId: "req-2025-001",
        source: "web"
    }
})

console.log(`\n最终结果: ${finalResult}`)

// ============================================
// 【知识点总结】
// ============================================
console.log("\n" + "=".repeat(60))
console.log("【知识点总结】")
console.log("=".repeat(60))
console.log(`
1. chain.withConfig({ configurable: {...} })
   - 作用：为 chain 绑定运行时配置
   - 读取方式：在 RunnableLambda 中通过 (input, config) 的 config 参数
   - 配置路径：config.configurable.xxx

2. 常见配置项
   - userId / role / locale —— 用户上下文
   - requestId / traceId —— 链路追踪
   - model / temperature —— 模型参数

3. Callbacks —— 执行观测
   - handleChainStart(chain, inputs, runId) —— 步骤开始
   - handleChainEnd(output, runId) —— 步骤结束
   - handleChainError(err, runId) —— 步骤出错
   - 用途：日志、监控、调试、性能统计

4. 使用方式
   await chain.invoke(input, { callbacks: [callback], configurable: {...} })

5. 最佳实践
   - 用 configurable 传业务上下文（用户、会话、语言）
   - 用 callbacks 做可观测性（日志、监控）
   - 不要把敏感信息（密码、token）放在 configurable 中
   - callbacks 不要阻塞主流程，只做轻量级记录
`)
