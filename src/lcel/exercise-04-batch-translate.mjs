import "dotenv/config"
import { ChatOpenAI } from "@langchain/openai"
import { PromptTemplate } from "@langchain/core/prompts"
import { StringOutputParser } from "@langchain/core/output_parsers"
import { RunnableSequence, RunnablePassthrough, RunnableLambda } from "@langchain/core/runnables"
import chalk from "chalk"
import { z } from "zod"


const baseModelConfig = {
    modelName: process.env.MODEL_NAME,
    apiKey: process.env.API_KEY,
    configuration: {
        baseURL: process.env.BASE_URL,
    }
}
const translatorPrompt = PromptTemplate.fromTemplate(`
    请把下面的英文准确流畅地翻译成中文，只输出译文，不要任何前缀或解释。
    英文：{original}
`)

const translatorModel = new ChatOpenAI({ ...baseModelConfig, temperature: 0.3 })
const translatorChain = translatorPrompt.pipe(translatorModel).pipe(new StringOutputParser())


const scorePrompt = PromptTemplate.fromTemplate(`
    你是资深翻译评审。请给下面的翻译质量打分（1-10 整数），并说明理由。
    【原文】{original}
    【译文】{translation}
    评分维度：准确性、流畅度、地道程度。
`)

const scoreModel = new ChatOpenAI({ ...baseModelConfig, temperature: 0 })
const scoreSchema = z.object({
    score: z.number().describe("翻译质量评分,范围是 1-10"),
    reason: z.string().describe("翻译质量评分理由"),
})


const scoreChain = scorePrompt.pipe(scoreModel.withStructuredOutput(scoreSchema))

const unitChain = RunnableSequence.from([
    RunnablePassthrough.assign({ translation: translatorChain }),
    RunnablePassthrough.assign({ evaluation: scoreChain }),
    RunnableLambda.from((input) => {
        return {
            original: input.original,
            translation: input.translation,
            score: input.evaluation.score,
            reason: input.evaluation.reason,
        }
    })
])

const sentences = [
    "Deep learning has revolutionized natural language processing.",
    "It rains cats and dogs today.",  // 习语，难翻
    "The early bird catches the worm.",  // 习语
    "I love programming.",
    "The model achieves state-of-the-art performance on benchmarks.",
]
const inputs = sentences.map((s) => ({ original: s }))

// ============================================
// 6. 串行 vs 并发性能对比（亮点演示）
// ============================================
console.log(chalk.bgCyan("\n=== 【串行：for + invoke】==="))
const t1 = Date.now()
const serialResults = []
for (const input of inputs) {
    serialResults.push(await unitChain.invoke(input))
}
console.log(chalk.gray(`串行耗时: ${Date.now() - t1}ms`))

console.log(chalk.bgCyan("\n=== 【并发：batch】==="))
const t2 = Date.now()
// TODO 5: 用 .batch() + maxConcurrency 跑同样的数据
const batchResults = await unitChain.batch(inputs, { maxConcurrency: 5 })
console.log(chalk.gray(`并发耗时: ${Date.now() - t2}ms`))

// ============================================
// 7. 输出结果（按分数倒序便于挑问题）
// ============================================
console.log(chalk.bgYellow("\n=== 【最终评分（按分数升序，差的在前）】==="))
const sorted = [...batchResults].sort((a, b) => a.score - b.score)
for (const r of sorted) {
    const color = r.score >= 8 ? chalk.green : r.score >= 5 ? chalk.yellow : chalk.red
    console.log(color(`[${r.score}/10] ${r.original}`))
    console.log(chalk.gray(`  → ${r.translation}`))
    console.log(chalk.gray(`  💬 ${r.reason}\n`))
}

// ============================================
// 【评审区 · 最佳实践参考】（不改原代码）
// ============================================
//
// 【✅ 你做得出色的点】
//   1. .batch() + maxConcurrency 写法标准，可直接上生产
//   2. 双 Passthrough.assign 连拍，状态对象逐步丰富的范式面走得很顺
//   3. flatten Lambda 把嵌套的 evaluation 展平为 4 字段，下游消费友好
//   4. 按分数升序 + 颜色分级输出，这是生产环境加分项
//   5. 串行 vs 并发对比场面十分丝滑，一眼可看出 batch 威力
//
// 【⚠️ 可以改进的 4 个点】
//
// 改进点 1：score 用 zod 强约束，不依赖 describe
//   现状：z.number().describe("范围 1-10")
//        靠描述说服 LLM，但 LLM 可能返 7.5 、 0、1、 11 这种
//   优化：z.number().int().min(1).max(10).describe("...")
//        zod 会自动校验，越界直接报错，安全很多
//
// 改进点 2：prompt 模板的不必要缩进
//   现状：fromTemplate 模板里每行都有 4 个空格缩进
//   问题：这些空格会一起传给 LLM，浪费 token，还可能让 LLM 误以为是代码块
//   优化：去掉多余缩进，顶格写
//
// 改进点 3：batch 容错：单条失败不该拖垮全部
//   现状：batch 默认一条报错整个 Promise.all reject、所有结果丢失
//   优化：传 returnExceptions: true
//   await unitChain.batch(inputs, {
//       maxConcurrency: 5,
//       returnExceptions: true,    ← 失败的位置返回 Error 对象而不是报错
//   })
//   然后过滤：results.filter(r => !(r instanceof Error))
//
// 改进点 4：补三段式头部注释（项目规则 ai-agent.md §4.1）
//   职责：批量并发翻译 + 质量评分流水线
//   关键流程：translatorChain → scoreChain → unitChain.batch()
//   知识扩展：.batch 如何实现并发 / 为什么需要 maxConcurrency
//
// 【🎯 一句话核心心法】
//   生产环境用 LCEL 跑批量任务的三件套：
//   ┌─ .batch() 代替 for+invoke   → 性能 N 倍
//   ├─ maxConcurrency 限并发     → 不打爆 API 速率
//   └─ returnExceptions 心需忍忍 → 单条失败不拖垮所有结果
//   这三样全备，才能叫生产可用
//
// ============================================