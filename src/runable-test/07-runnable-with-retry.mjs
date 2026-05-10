// ============================================
// 07-runnable-with-retry.mjs
// ============================================
// 职责：学习 RunnableWithRetry + RunnableWithFallbacks —— 容错降级
//
// 关键流程：
// 1. runnable.withRetry({ stopAfterAttempt: N }) —— 失败时自动重试
// 2. runnable.withFallbacks({ fallbacks: [r2, r3] }) —— 主服务失败时降级到备用
// 3. 重试和降级可以组合使用，构建健壮的 chain
//
// 知识扩展（小白能懂）：
// - withRetry 就像"反复敲门"：第一次没人开，等一会再敲，最多敲 N 次
// - withFallbacks 就像"Plan B"：主厨请假了，副厨顶上；副厨也不在，外卖顶上
// - 为什么要容错？因为 LLM 调用可能会：网络超时、服务限流、模型不可用
// - 重试适合"临时故障"（网络抖动），降级适合"持续故障"（服务宕机）
// - 生产环境中，retry + fallback 是标配，不能裸调外部服务
// ============================================

import "dotenv/config"
import { RunnableLambda } from "@langchain/core/runnables"

// ============================================
// 示例1：withRetry —— 自动重试机制
// ============================================
console.log("=".repeat(60))
console.log("【示例1】withRetry —— 自动重试")
console.log("=".repeat(60))

let attemptCount = 0

// 模拟一个"不稳定"的服务：前几次调用会失败
const unstableService = RunnableLambda.from(async (input) => {
    attemptCount += 1
    console.log(`  [不稳定服务] 第 ${attemptCount} 次尝试，输入: ${input}`)

    // 模拟：前 2 次都失败，第 3 次成功
    if (attemptCount < 3) {
        console.log(`  [不稳定服务] 本次失败（模拟错误）`)
        throw new Error(`服务暂时不可用（第 ${attemptCount} 次）`)
    }

    console.log(`  [不稳定服务] 本次成功！`)
    return `成功处理: ${input}`
})

// 给不稳定服务加上重试机制：最多尝试 5 次
const reliableService = unstableService.withRetry({
    stopAfterAttempt: 5
})

console.log("\n开始调用（预期：失败2次，第3次成功）：")
const result1 = await reliableService.invoke("测试数据")
console.log(`\n最终结果: ${result1}`)
console.log(`总共尝试了 ${attemptCount} 次`)

// 重置计数器，演示"重试也失败"的情况
console.log("\n--- 演示：重试耗尽仍然失败 ---")
attemptCount = 0

const alwaysFailService = RunnableLambda.from(async (input) => {
    attemptCount += 1
    console.log(`  [必败服务] 第 ${attemptCount} 次尝试`)
    throw new Error("服务完全不可用")
})

const retryExhausted = alwaysFailService.withRetry({
    stopAfterAttempt: 3
})

try {
    await retryExhausted.invoke("测试数据")
} catch (e) {
    console.log(`\n最终失败: ${e.message}`)
    console.log(`总共尝试了 ${attemptCount} 次（达到上限）`)
}

// ============================================
// 示例2：withFallbacks —— 降级策略
// ============================================
console.log("\n" + "=".repeat(60))
console.log("【示例2】withFallbacks —— 服务降级")
console.log("=".repeat(60))

// 模拟三层翻译服务：高级 → 标准 → 本地词典
const premiumTranslator = RunnableLambda.from(async (text) => {
    console.log("  [Premium翻译] 尝试调用...")
    throw new Error("Premium 服务超时")
})

const standardTranslator = RunnableLambda.from(async (text) => {
    console.log("  [Standard翻译] 尝试调用...")
    throw new Error("Standard 服务限流")
})

const localTranslator = RunnableLambda.from(async (text) => {
    console.log("  [Local翻译] 使用本地词典...")
    const dict = {
        hello: "你好",
        world: "世界",
        goodbye: "再见",
        love: "爱"
    }
    const words = text.toLowerCase().split(" ")
    return words.map((w) => dict[w] ?? w).join(" ")
})

// withFallbacks：依次尝试 premium → standard → local
const translator = premiumTranslator.withFallbacks({
    fallbacks: [standardTranslator, localTranslator]
})

console.log("\n翻译 'hello world'：")
const result2 = await translator.invoke("hello world")
console.log(`\n最终翻译结果: ${result2}`)

// ============================================
// 示例3：Retry + Fallback 组合 —— 双重保险
// ============================================
console.log("\n" + "=".repeat(60))
console.log("【示例3】组合使用 —— Retry + Fallback 双重保险")
console.log("=".repeat(60))

// 主服务：不稳定，但重试后可能恢复
let primaryAttempts = 0
const flakyPrimary = RunnableLambda.from(async (input) => {
    primaryAttempts += 1
    console.log(`  [主服务] 第 ${primaryAttempts} 次尝试`)
    if (primaryAttempts < 3) {
        throw new Error("网络超时")
    }
    return `【主服务】成功: ${input}`
})

// 备用服务：永远可用
const stableBackup = RunnableLambda.from(async (input) => {
    console.log("  [备用服务] 执行")
    return `【备用服务】${input}`
})

// 组合策略：主服务先重试3次，如果还失败就降级到备用服务
const resilientService = flakyPrimary
    .withRetry({ stopAfterAttempt: 3 })
    .withFallbacks({ fallbacks: [stableBackup] })

console.log("\n场景：主服务前2次失败，第3次成功")
primaryAttempts = 0
const result3a = await resilientService.invoke("重要任务")
console.log(`结果: ${result3a}`)

console.log("\n场景：主服务一直失败，触发降级")
// 创建一个总是失败的主服务
const alwaysDown = RunnableLambda.from(async () => {
    throw new Error("主服务彻底挂了")
})
const resilientWithDeadPrimary = alwaysDown
    .withRetry({ stopAfterAttempt: 2 })
    .withFallbacks({ fallbacks: [stableBackup] })

const result3b = await resilientWithDeadPrimary.invoke("重要任务")
console.log(`结果: ${result3b}`)

// ============================================
// 示例4：实际场景 —— LLM 调用保护
// ============================================
console.log("\n" + "=".repeat(60))
console.log("【示例4】实际场景 —— 保护 LLM 调用")
console.log("=".repeat(60))

// 模拟：主模型（GPT-4，高质量但可能限流）
const primaryLLM = RunnableLambda.from(async (prompt) => {
    console.log("  [GPT-4] 尝试调用...")
    // 模拟 50% 概率失败
    if (Math.random() < 0.5) {
        throw new Error("GPT-4 限流")
    }
    return `[GPT-4 高质量回复] ${prompt.slice(0, 20)}...`
})

// 备用模型（GPT-3.5，稳定但质量稍低）
const backupLLM = RunnableLambda.from(async (prompt) => {
    console.log("  [GPT-3.5] 调用成功")
    return `[GPT-3.5 标准回复] ${prompt.slice(0, 20)}...`
})

// 最终兜底（本地规则回复）
const fallbackResponse = RunnableLambda.from(async (prompt) => {
    console.log("  [本地兜底] 返回固定回复")
    return "[本地回复] 服务繁忙，请稍后再试。"
})

// 构建三层保护链
const protectedLLM = primaryLLM
    .withRetry({ stopAfterAttempt: 2 })
    .withFallbacks({ fallbacks: [backupLLM, fallbackResponse] })

console.log("\n调用受保护的 LLM 服务（随机结果）：")
const result4 = await protectedLLM.invoke("请总结这篇文章的内容...")
console.log(`\n最终回复: ${result4}`)

// ============================================
// 【知识点总结】
// ============================================
console.log("\n" + "=".repeat(60))
console.log("【知识点总结】")
console.log("=".repeat(60))
console.log(`
1. runnable.withRetry({ stopAfterAttempt: N })
   - 作用：失败时自动重试，最多 N 次
   - 适用：临时性故障（网络抖动、偶发超时）
   - 注意：重试间隔默认是固定的，可以配置 retryIf 条件

2. runnable.withFallbacks({ fallbacks: [r2, r3] })
   - 作用：主服务失败时，依次尝试备用服务
   - 适用：持续性故障（服务宕机、限流）
   - 顺序：r1 失败 → r2 → r3，直到有一个成功或全部失败

3. 组合策略
   - 先用 withRetry 处理临时故障
   - 再用 withFallbacks 处理持续故障
   - 组合顺序：runnable.withRetry().withFallbacks()

4. 生产环境最佳实践
   - 所有外部调用（LLM、API、数据库）都必须有重试或降级
   - 备用服务的质量可以递减：高质量模型 → 低质量模型 → 本地规则
   - 记录每次 fallback 的触发，用于后续优化
   - 设置合理的重试次数（一般 2-3 次），避免雪崩

5. 注意事项
   - withRetry 和 withFallbacks 都会增加总耗时
   - 重试时建议加入指数退避（目前 LangChain 默认不支持，需手动实现）
   - fallback 链的最后一个应该是"永远成功"的兜底
`)
