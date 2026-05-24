import "dotenv/config"
import { ChatOpenAI } from "@langchain/openai"
import {
    RunnableLambda,
    RunnableSequence,
    RunnableMap,
    RunnablePassthrough,
} from "@langchain/core/runnables"
import { z } from "zod"

// ============================================================
// 文件职责：智能内容审核器（RunnableMap 并行处理实战）
//
// 关键流程：
//   1. 输入帖子 { title, content }
//   2. RunnableMap 并行触发 4 条检查子链：
//        sensitive 敏感词、sentiment 情感、category 分类、stats 统计
//      同时用 RunnablePassthrough 透传原始 post 到下游
//   3. judge Lambda 综合 4 路结果产出 pass / reject / needReview
//   4. 末尾对比"并行版 vs 串行版"耗时，体验并行带来的性能飞跃
//
// 知识扩展：
//   RunnableMap 是"并行 fan-out"组件，会把同一个 input 广播给每条
//   子链，所有子链同时启动；只要它们之间没有依赖，总耗时就约等于
//   最慢那条子链的耗时（而不是所有子链耗时之和）。
//   注意：所有子链必须能消费同一种 input 形态。
// ============================================================

const model = new ChatOpenAI({
    modelName: process.env.MODEL_NAME,
    apiKey: process.env.API_KEY,
    temperature: 0,
    configuration: {
        baseURL: process.env.BASE_URL,
    },
})

// ============================================================
// 工具函数：把 {title, content} 拼成纯文本，供子链统一消费
// 关键点：RunnableMap 会把同一个 input 广播给每条子链，所以子链
//        必须接受统一的 input 形态。我们约定 input 永远是
//        { title, content } 对象，由各子链内部自行转字符串。
// ============================================================
const toText = (post) => `标题：${post.title}\n内容：${post.content}`

// ============================================================
// 子链 1：敏感词检查（纯 Lambda，不调 LLM，毫秒级完成）
// 输出：{ hit: boolean, words: string[] }
// ============================================================
const sensitiveCheckChain = RunnableLambda.from((post) => {
    const blacklist = ["微信加我", "广告", "兼职", "日入", "带你赚钱"]
    const text = toText(post)
    const hitWords = blacklist.filter((kw) => text.includes(kw))
    return { hit: hitWords.length > 0, words: hitWords }
})

// ============================================================
// 子链 2：情感分析（LLM + zod schema）
// 关键点：每个 zod 字段必须 .describe()，否则 LLM 不知道字段含义
// ============================================================
const sentimentSchema = z.object({
    score: z.number().describe("情感分数，范围 -1（极负面）到 1（极正面）"),
    label: z
        .enum(["positive", "neutral", "negative"])
        .describe("情感标签：positive/neutral/negative"),
})
const sentimentModel = model.withStructuredOutput(sentimentSchema)

const sentimentAnalysisChain = RunnableLambda.from(async (post) => {
    return await sentimentModel.invoke(
        `请分析以下帖子的情感倾向：\n${toText(post)}`
    )
})

// ============================================================
// 子链 3：内容分类（LLM + zod schema）
// ============================================================
const categorySchema = z.object({
    topic: z
        .enum(["技术", "吐槽", "广告", "求助", "其他"])
        .describe("帖子主题分类"),
    isSpam: z.boolean().describe("是否为垃圾营销信息"),
})
const categoryModel = model.withStructuredOutput(categorySchema)

const categoryAnalysisChain = RunnableLambda.from(async (post) => {
    return await categoryModel.invoke(
        `请对以下帖子做主题分类，并判断是否为垃圾营销：\n${toText(post)}`
    )
})

// ============================================================
// 子链 4：统计（纯 Lambda，无 LLM）
// 修复要点：
//   1) 必须接 {title, content} 对象（与其他子链统一）
//   2) regex.test(string) 而不是 string.test(regex)
//   3) 用 match 计算链接数，更稳
// ============================================================
const statsChain = RunnableLambda.from((post) => {
    const text = toText(post)
    const linkCount = (text.match(/https?:\/\/\S+/g) || []).length
    const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/
    return {
        charCount: text.length,
        linkCount,
        hasEmail: emailRegex.test(text),
    }
})

// ============================================================
// 并行 fan-out：RunnableMap 把 input 同时广播给 5 条子链
// 关键点：RunnablePassthrough 啥也不做，原样把 post 透传到 original
//        字段，方便下游 judge Lambda 拿到原文做日志/回显
// ============================================================
const parallelMap = RunnableMap.from({
    sensitive: sensitiveCheckChain,
    sentiment: sentimentAnalysisChain,
    category: categoryAnalysisChain,
    stats: statsChain,
    original: new RunnablePassthrough(),
})

// ============================================================
// 判定 Lambda：综合 4 路结果产出最终结论
// 规则：
//   命中敏感词 或 LLM 判定为 spam        → reject
//   情感分数 < -0.5（强负面）            → needReview
//   其他                                 → pass
// ============================================================
const judgeChain = RunnableLambda.from((input) => {
    const { sensitive, sentiment, category, stats, original } = input
    let verdict = "pass"
    if (sensitive.hit || category.isSpam) verdict = "reject"
    else if (sentiment.score < -0.5) verdict = "needReview"

    return {
        verdict,
        title: original.title,
        details: { sensitive, sentiment, category, stats },
    }
})

// 主链：并行检查 → 综合判定
const parallelChain = RunnableSequence.from([parallelMap, judgeChain])

// ============================================================
// 三个测试用例：分别命中 pass / reject / needReview
// ============================================================
const cases = [
    {
        title: "求教 RAG 怎么入门",
        content: "最近想学 LangChain，有什么推荐的入门资料吗？",
    },
    {
        title: "兼职日入500",
        content: "微信加我 xxx，带你赚钱，包教包会！",
    },
    {
        title: "踩雷某培训机构",
        content: "花了2万感觉被骗了，太坑了，根本不教真东西，建议大家避雷。",
    },
]

// ============================================================
// 跑并行版（这是本关重点）
// ============================================================
console.log("\n========== 并行版（RunnableMap）==========")
console.time("并行版总耗时")
for (const post of cases) {
    console.time(`  → ${post.title}`)
    const result = await parallelChain.invoke(post)
    console.timeEnd(`  → ${post.title}`)
    console.log("  判定：", result.verdict)
    console.log("  详情：", JSON.stringify(result.details, null, 2))
}
console.timeEnd("并行版总耗时")

// ============================================================
// 跑串行版做对比：4 条子链顺序 invoke，体验性能差异
// 注意：放在并行版后跑，避免冷启动让并行版"虚假赢"
// ============================================================
console.log("\n========== 串行版（顺序 invoke）==========")
console.time("串行版总耗时")
for (const post of cases) {
    console.time(`  → ${post.title}`)
    const a = await sensitiveCheckChain.invoke(post)
    const b = await sentimentAnalysisChain.invoke(post)
    const c = await categoryAnalysisChain.invoke(post)
    const d = await statsChain.invoke(post)
    console.timeEnd(`  → ${post.title}`)
}
console.timeEnd("串行版总耗时")
