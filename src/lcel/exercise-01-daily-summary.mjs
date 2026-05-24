// ============================================
// exercise-01-daily-summary.mjs
// ============================================
// 职责：用 LCEL 链做"日报 → markdown 卡片"的智能摘要器
//
// 关键流程：
// 1. PromptTemplate 把 {text} 灌进模板，给 LLM 明确的提取任务
// 2. model.withStructuredOutput(schema) 让 LLM 直接吐 {summary, keywords, mood}
// 3. 后处理 RunnableLambda 把结构化对象拼成 markdown 卡片（纯 JS，不再调 LLM）
// 4. 同时演示 .invoke() 一次性返回 与 .stream() 流式调用
//
// 知识扩展（小白能懂）：
// - 为什么后处理用纯 JS Lambda，而不是再调一次 LLM？
//   字符串拼接是 100% 确定性逻辑，用代码做又快又免费，省 50% token
//   而且格式完全可控，不会因为模型"今天心情不好"给你输出歪七扭八的 markdown
// - withStructuredOutput 帮我们干了什么？
//   它会把 zod schema 翻译成 JSON Schema 指令塞进 prompt，并自动 parse + 校验
//   对比手写 "请用 JSON 格式输出" 这种土办法，可靠性提升 10 倍
// - .invoke() vs .stream() 的差异
//   invoke 一次性拿完整结果；stream 一边生成一边返回（更接近 ChatGPT 体验）
//   注意：当链末端是同步 Lambda 时，stream 视觉上会"一次性涌出"，这是正常现象
// ============================================

import "dotenv/config"
import chalk from "chalk"
import { ChatOpenAI } from "@langchain/openai"
import { PromptTemplate } from "@langchain/core/prompts"
import { RunnableLambda } from "@langchain/core/runnables"
import { z } from "zod"

// ============================================
// 1. 模型配置
// ============================================
const model = new ChatOpenAI({
    modelName: process.env.MODEL_NAME,
    apiKey: process.env.API_KEY,
    temperature: 0.3,  // 摘要类任务温度低一点，结果更稳定
    configuration: { baseURL: process.env.BASE_URL },
})

// ============================================
// 2. 结构化输出 schema —— 每个字段都要 .describe()
// ============================================
// 【评审注释】原版 mood: z.number() 没写范围，LLM 可能给你 0~100 任意数字
//             加上明确范围后，LLM 会自动按 1-10 整数打分
const summarySchema = z.object({
    summary: z.string().describe("一句话总结，不超过 30 个汉字"),
    keywords: z.array(z.string()).describe("3 个最能代表当天工作的关键词，每个不超过 6 字"),
    mood: z.number().describe("心情评分，1-10 的整数（10 表示最开心）"),
})

// ============================================
// 3. PromptTemplate —— 给 LLM 清晰的角色和任务
// ============================================
// 【评审注释】原版 prompt 太简陋（一行字），LLM 提取效果不稳定
//             改成多行模板，分清"角色 / 输入 / 任务"
const promptTpl = PromptTemplate.fromTemplate(`你是一个专业的日报分析助手。
请仔细阅读下面的日报，按要求提取关键信息。

【日报内容】
{text}
`)

// ============================================
// 4. 后处理 Lambda —— 纯 JS 拼接 markdown 卡片（不调 LLM！）
// ============================================
// 【评审注释】这是本次评审改动最大的地方
//   原版做法：在 Lambda 里调 mdPrompt + model.invoke 二次格式化（多花一次 API 费用）
//   改后做法：拿到结构化对象后，纯 JS 字符串拼接，0 token 0 延迟
//   这才是任务 1 想考的"后处理 Lambda"的本意
const formatToCard = RunnableLambda.from(({ summary, keywords, mood }) => {
    // 心情 emoji 分三档
    const moodEmoji = mood >= 8 ? "😄" : mood >= 5 ? "🙂" : "😟"

    return `
# 📅 今日日报摘要
---
📝 **总结**：${summary}
🏷️ **关键词**：${keywords.join("、")}
${moodEmoji} **心情**：${mood} / 10
---
`.trim()
})

// ============================================
// 5. 组装 LCEL 链 —— 标准三节式
// ============================================
//   promptTpl                              : {text} → 格式化好的 PromptValue
//   model.withStructuredOutput(schema)     : PromptValue → {summary, keywords, mood}
//   formatToCard                           : 结构化对象 → markdown 卡片字符串
const dailySummaryChain = promptTpl
    .pipe(model.withStructuredOutput(summarySchema))
    .pipe(formatToCard)

// ============================================
// 6. 测试日报
// ============================================
const todayReport = `今天上午开了 2 小时项目评审会，下午把用户登录模块的 bug 修完了，
还顺手优化了首页的加载速度，从 3s 降到 1.2s。晚上和团队聚餐庆祝里程碑达成，心情很好。`

// ============================================
// 7. 演示 .invoke() —— 一次性返回完整卡片
// ============================================
console.log(chalk.bgCyan("\n=== 【invoke 方式】一次性返回完整结果 ==="))
const card = await dailySummaryChain.invoke({ text: todayReport })
console.log(chalk.green(card))

// ============================================
// 8. 演示 .stream() —— 流式调用
// ============================================
// 【小白注意】因为链的最后一节是同步 Lambda，整张卡片会在 LLM 全部生成完后
//             一次性涌出。这是 LCEL stream 在"末端是同步函数"时的正常表现，
//             不是 bug。要看真正的打字机效果，可以单独 stream 前两节（不接 Lambda）
console.log(chalk.bgCyan("\n=== 【stream 方式】流式输出 ==="))
const stream = await dailySummaryChain.stream({ text: todayReport })
for await (const chunk of stream) {
    process.stdout.write(chalk.green(chunk))
}
console.log("\n")

// ============================================
// 9. 【对照演示】真·打字机效果（不接 withStructuredOutput）
// ============================================
// 【为什么 8 没有打字机感？】
//   LCEL 链有"短板效应"：链上任何一个节点必须"等完整结果"，整条链就不流式
//   你的链：prompt → model.withStructuredOutput → formatToCard
//                    ↑                            ↑
//                    必须等完整 JSON 才能 parse     同步函数必须等输入到齐
//   所以视觉上是：等几秒 → 整张卡片"啪"地一次性出现
//
// 【怎么看到真打字机？】
//   把链换成 prompt → model → StringOutputParser，纯文本输出，每个字符增量
//   下面这条链就是为了让你亲眼看到差异
import { StringOutputParser } from "@langchain/core/output_parsers"

const plainPromptTpl = PromptTemplate.fromTemplate(
    `用一句不超过 50 字的话总结下面的日报，结尾加一个表达心情的 emoji：\n\n{text}`
)

// 这条链的每一节都"流式友好"：
//   prompt        : 一次输出 PromptValue（不影响下游 stream）
//   model         : 原生支持 token-by-token 流式输出
//   StringOutputParser : 每个 chunk 取出 .content 直接吐出（不缓存不等待）
const plainStreamChain = plainPromptTpl
    .pipe(model)
    .pipe(new StringOutputParser())

console.log(chalk.bgYellow("\n=== 【对照演示】去掉 withStructuredOutput 后的真打字机效果 ==="))
const trueStream = await plainStreamChain.stream({ text: todayReport })
for await (const chunk of trueStream) {
    // 这里你会看到一个字一个字跳出来（真正的 ChatGPT 体验）
    process.stdout.write(chalk.yellow(chunk))
}
console.log("\n")

// 【进阶提示】想要 "结构化 + 实时流式" 两者兼得？
//   1) 用 model.stream() 拿原始 token 流
//   2) 边拼接边调用 "宽容 JSON 解析器"（允许不完整 JSON）
//   3) 项目里的 parsePartialResult / JsonOutputToolsParser 就是干这件事的
//   4) 参考 src/mini-cursor-outparse/mini-cursor.mjs 里的实现

// ============================================
// 【知识点总结】
// ============================================
console.log(chalk.bgMagenta("\n=== 【知识点总结】==="))
console.log(`
1. LCEL 链的"三节式"经典模式
   PromptTemplate → 模型（可带 withStructuredOutput）→ 后处理 Lambda

2. 后处理 Lambda 的两种用法
   纯 JS 处理：字符串拼接、字段重组（推荐，省 token、可控）
   再调 LLM ：需要二次润色/翻译时才用（会多花一次 API 钱）

3. 何时用 withStructuredOutput
   需要稳定字段就上：自动注入 schema 指令 + 自动校验
   比手写 "请用 JSON 格式" 可靠得多

4. 同一条链 .invoke() 和 .stream() 都支持
   零改造支持两种调用方式，这就是 LCEL 的核心价值

5. 易踩的坑
   zod schema 必须 .describe()，否则 LLM 不知道字段含义
   后处理逻辑能用代码就别再调 LLM，省钱省延迟
   prompt 写清楚"角色 + 任务 + 输入"三段，效果远好过一行字
`)
