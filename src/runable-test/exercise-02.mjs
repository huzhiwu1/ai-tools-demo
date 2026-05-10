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


const promptTemplate = PromptTemplate.fromTemplate("根据作者贡献数据，为每个人生成一段周报描述（30字左右):{stats}")

const schema = z.object({
    weekRange: z.string().describe("本周的日期范围"),
    teamName: z.string().describe("团队名称"),
    totalCommits: z.number().describe("本周总提交数"),
    contributors: z.array(z.object({
        name: z.string().describe("贡献者名称"),
        stats: z.object({
            feat: z.number().describe("新增功能提交数"),
            fix: z.number().describe("修复问题提交数"),
            refactor: z.number().describe("代码重构提交数"),
            docs: z.number().describe("文档编写提交数"),
            chore: z.number().describe("项目管理提交数"),
            test: z.number().describe("测试代码提交数"),
            perf: z.number().describe("性能优化提交数"),
            total: z.number().describe("总提交数")
        }),
        highlight: z.string().describe("本周高亮事件"),
    }))
})

const outputParser = StructuredOutputParser.fromZodSchema(schema)

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


const chainA = RunnableSequence.from([
    addCommitTag,
    groupByAuthor,
    countStats,
    promptTemplate,
    model,
    outputParser,
    new StringOutputParser()
])


const result = await chainA.invoke(commits, { teamName: "前端团队" })

console.log('hzw result', result)