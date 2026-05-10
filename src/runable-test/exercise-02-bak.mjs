import "dotenv/config"
import { ChatOpenAI } from "@langchain/openai"
import { RunnableLambda, RunnableSequence } from "@langchain/core/runnables"
import { PromptTemplate } from "@langchain/core/prompts"
import { z } from "zod"
import { StructuredOutputParser, StringOutputParser } from "@langchain/core/output_parsers"
const model = new ChatOpenAI({
    apiKey: process.env.API_KEY,
    modelName: process.env.MODEL_NAME,
    temperature: 0,
    configuration: {
        baseURL: process.env.BASE_URL
    }
})

const addCommitTag = RunnableLambda.from((input) => {
    return input.map((commit) => {
        const tag = commit.message.split(": ")[0]
        return {
            ...commit,
            tag
        }
    })
})

const groupByAuthor = RunnableLambda.from((input) => {
    const grouped = input.reduce((acc, commit) => {
        acc[commit.author] = acc[commit.author] || []
        acc[commit.author].push(commit)
        return acc
    }, {})
    return {
        ...input,
        grouped,
    }
})

const countStats = RunnableLambda.from((input, config) => {
    const teamName = config?.configurable?.teamName
    const stats = Object.fromEntries(
        Object.entries(input.grouped).map(([author, commits]) => [
            author,
            commits.reduce((stats, { tag }) => {
                stats[tag] = (stats[tag] || 0) + 1
                stats.total++
                return stats
            }, { total: 0 })
        ])
    )

    return {
        ...input,
        teamName,
        stats
    }
})
// 1. 定义生成 highlight 的子链（每个作者调一次）
const highlightPrompt = PromptTemplate.fromTemplate(
    "请根据以下开发者本周的 commit 数据，用一句话（30字左右）总结他的贡献亮点：\n" +
    "作者：{author}\n" +
    "commit 列表：\n{commits}\n" +
    "只返回一句话描述，不要其他内容。"
)

const highlightChain = highlightPrompt
    .pipe(model)
    .pipe(new StringOutputParser())

// 2. 第4步：遍历每个作者调用子链（注意是 async！）
const generateHighlights = RunnableLambda.from(async (input) => {
    console.log(`[步骤4] 为 ${Object.keys(input.grouped).length} 位作者生成 highlight`)
    const contributors = []
    for (const [author, commits] of Object.entries(input.grouped)) {
        const commitsText = commits.map(c => `  - ${c.message}`).join("\n")
        const highlight = await highlightChain.invoke({
            author,
            commits: commitsText
        })
        contributors.push({
            name: author,
            stats: input.stats[author],
            highlight: highlight.trim()
        })
    }
    return { ...input, contributors }
})

// 3. 第5步：纯 JS 组装最终报告（不用 LLM）
const assembleReport = RunnableLambda.from((input) => {
    console.log(`[步骤5] 组装最终报告`)
    return {
        weekRange: "2026-05-01 ~ 2026-05-07",
        teamName: input.teamName,
        totalCommits: input.contributors.reduce((sum, c) => sum + c.stats.total, 0),
        contributors: input.contributors
    }
})

// 4. 组装主链（去掉 outputParser 和 StringOutputParser）
const chain = RunnableSequence.from([
    addCommitTag,
    groupByAuthor,
    countStats,
    generateHighlights,
    assembleReport
])

const commits = [
    { hash: "a1b2c3d", author: "张三", message: "feat: 新增用户登录接口，支持手机号+验证码" },
    { hash: "e4f5g6h", author: "张三", message: "fix: 修复订单页面在iOS下的样式错位问题" },
    { hash: "i7j8k9l", author: "李四", message: "refactor: 重构支付模块，提取公共校验逻辑" },
    { hash: "m1n2o3p", author: "李四", message: "docs: 补充支付接口的API文档" },
    { hash: "q4r5s6t", author: "张三", message: "chore: 升级依赖版本" },
    { hash: "u7v8w9x", author: "王五", message: "feat: 实现订单导出Excel功能" },
    { hash: "y1z2a3b", author: "王五", message: "test: 补充订单模块单元测试，覆盖率提升到85%" },
    { hash: "c4d5e6f", author: "李四", message: "perf: 优化首页接口响应时间，从800ms降到200ms" }
]


// 5. 调用时 config 必须套 configurable
const result = await chain.invoke(commits, {
    configurable: { teamName: "前端团队" }
})

console.log(result)
