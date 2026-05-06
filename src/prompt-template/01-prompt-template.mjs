// ============================================
// 01-prompt-template.mjs
// ============================================
// 职责：学习最基础的 PromptTemplate —— 字符串模板
//
// 关键流程：
// 1. 用 PromptTemplate.fromTemplate() 定义带占位符的模板
// 2. 用 .format() 传入实际值，替换占位符
// 3. 把格式化后的字符串传给 LLM
//
// 知识扩展（小白能懂）：
// - PromptTemplate 就是一个"填空题模板"，{xxx} 是要填的空
// - 它的作用是把「固定的提示词框架」和「动态的数据」分开
// - 比如周报场景：框架不变（结构、语气），每周数据变（Git提交、Bug数量）
// - 不用模板的话，每次都要手写一大段 prompt，容易遗漏、难维护
// ============================================

import "dotenv/config"
import { ChatOpenAI } from "@langchain/openai"
import { PromptTemplate } from "@langchain/core/prompts"

const model = new ChatOpenAI({
    modelName: process.env.MODEL_NAME,
    apiKey: process.env.API_KEY,
    temperature: 0,
    configuration: { baseURL: process.env.BASE_URL }
})

// 步骤 1：定义模板（带占位符 {xxx}）
const weeklyReportTemplate = PromptTemplate.fromTemplate(`
你是一名工程团队负责人，需要根据本周数据写一份周报。

公司：{company}
团队：{team}
时间：{week}
本周目标：{goal}
开发活动：{activities}

请生成一份 Markdown 周报，包含：
1. 本周概览（2-3句话）
2. 按模块拆分的小结
3. 关键指标表格（模块 | 亮点 | 风险 | 下周计划）
`)

// 步骤 2：传入实际数据，格式化模板
const prompt = await weeklyReportTemplate.format({
    company: "星航科技",
    team: "数据智能平台组",
    week: "2025-03-10 ~ 2025-03-16",
    goal: "完成用户画像服务的灰度上线",
    activities:
        "- 阿兵：完成 Canary 发布，提交 27 次\n" +
        "- 小李：打通埋点全链路，提交 22 次\n" +
        "- 小赵：新增 8 个告警规则，提交 15 次"
})

console.log("=== 格式化后的 Prompt ===")
console.log(prompt)

// 步骤 3：发给 LLM
console.log("\n=== AI 生成的周报 ===")
const response = await model.invoke(prompt)
console.log(response.content)
