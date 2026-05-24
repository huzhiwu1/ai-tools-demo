import "dotenv/config"
import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { PromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { RunnablePassthrough, RunnableSequence } from "@langchain/core/runnables";
import chalk from "chalk";
const model = new ChatOpenAI({
    modelName: process.env.MODEL_NAME,
    apiKey: process.env.API_KEY,
    temperature: 0,
    configuration: {
        baseURL: process.env.BASE_URL,
    }
});

const resumeSchema = z.object({
    name: z.string().describe("用户的姓名"),
    age: z.number().describe("用户的年龄"),
    skills: z.array(z.string()).describe("用户的技能"),
});

const extractPrompt = PromptTemplate.fromTemplate(`
你是一个简历分析助手。请从下面的简历文本中提取关键信息。

【简历文本】
{resume}
`)

const extractModel = model.withStructuredOutput(resumeSchema)


const extractChain = extractPrompt.pipe(extractModel)

const commentPrompt = PromptTemplate.fromTemplate(`
你是一个资深 HR。请根据以下简历信息，给出一句不超过 40 字的中文评语，要专业、有温度。

姓名：{name}
年龄：{age}
技能：{skills}

直接输出评语，不要任何前缀。
`)

const commentChain = commentPrompt
    .pipe(model)
    .pipe(new StringOutputParser())


const enrichChain = RunnablePassthrough.assign({
    comment: commentChain
});


const fullChain = RunnableSequence.from([
    extractChain,
    enrichChain,
]);

const resumeText = `
张三，今年 28 岁，本科毕业于某 985 大学计算机专业。
有 5 年前端开发经验，精通 JavaScript / TypeScript / React / Vue，
熟悉 Node.js 和 Python，做过若干大型电商项目，主导过性能优化和架构升级。
`

console.log(chalk.bgCyan("\n=== 【输入简历】==="))
console.log(resumeText)

const result = await fullChain.invoke({ resume: resumeText })

console.log(chalk.bgCyan("\n=== 【最终结果】==="))
console.log(chalk.green(JSON.stringify(result, null, 2)))

// 验证：必须有 4 个字段
console.log(chalk.bgYellow("\n=== 【字段校验】==="))
const requiredFields = ["name", "age", "skills", "comment"]
for (const field of requiredFields) {
    const ok = field in result
    console.log(`${ok ? "✅" : "❌"} ${field}: ${ok ? JSON.stringify(result[field]) : "缺失"}`)
}

// ============================================
// 【评审区 · 最佳实践参考】（不改动原代码，仅注释参考）
// ============================================
//
// 【✅ 你做对的地方】
//   1. zod schema 三个字段都 .describe() 了
//   2. 正确使用 withStructuredOutput，没有手写 JSON.parse
//   3. 链路顺序正确：extractChain → enrichChain（commentChain 隐藏在 assign 内）
//   4. Passthrough.assign 用法标准，没有手写 {...prev, comment}
//   5. 末尾加了字段校验逻辑，很专业
//
// 【⚠️ 可以改进的 5 个点】
//
// 改进点 1：补三段式头部注释（项目规则 ai-agent.md §4.1）
//   每个 LCEL 教学文件都应该有「职责 / 关键流程 / 知识扩展」三段
//   方便新人 30 秒看懂整个文件做了啥
//
// 改进点 2：zod .describe() 写得更详细
//   现状：z.number().describe("用户的年龄")
//   优化：z.number().int().min(18).max(80).describe("用户的年龄，整数，18-80")
//        skills 也可以说"3-10 个主要技能关键词"
//   原因：describe 越精确，LLM 抽取越稳定，z.int()/z.min() 还会自动校验
//
// 改进点 3：skills 数组进 prompt 前先 join
//   现状：commentPrompt 里写 {skills}，传进去是数组，自动 toString() 变成
//        "JavaScript,TypeScript,React"（用英文逗号，不太自然）
//   优化：在 enrichChain 前加一节 RunnableLambda，把 skills 拼成 "JS、TS、React"
//        这样评语更自然
//
//   示意写法（不改你的代码，只是给你看一下思路）：
//   const formatSkills = RunnablePassthrough.assign({
//       skills: RunnableLambda.from((s) => s.skills.join("、")),
//   })
//   const fullChain = RunnableSequence.from([extractChain, formatSkills, enrichChain])
//
//   ⚠️ 但注意：这样会让 result.skills 变成字符串，丢失原数组类型
//             更稳的做法是新增一个 skillsText 字段，原 skills 保留
//
// 改进点 4：加 try/catch 容错
//   现状：fullChain.invoke 出错直接崩
//   优化：包一层 try/catch，对 LLM 偶发的 schema 校验失败给出友好提示
//   try {
//       const result = await fullChain.invoke({ resume: resumeText })
//   } catch (err) {
//       console.error(chalk.red("提取失败："), err.message)
//   }
//
// 改进点 5：补一段「知识点总结」，便于复习
//   总结 Passthrough.assign 的核心、子链作为 value 的范式、易踩坑
//
// 【🎯 一句话核心心法】
//   Passthrough.assign({ key: someRunnable }) 的灵魂：
//   ┌─ 上游对象自动透传，原字段一字不丢
//   ├─ someRunnable 自动以「上游对象」作为输入
//   └─ someRunnable 的输出会被挂到 key 字段上
//   这就是 LCEL 「状态对象逐步丰富」最重要的武器，任务 3、5 还会大量用到
//
// ============================================