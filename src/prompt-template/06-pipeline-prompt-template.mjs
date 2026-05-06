// ============================================
// 06-pipeline-prompt-template.mjs
// ============================================
// 职责：学习 PipelinePromptTemplate —— 模块化组合 Prompt
//
// 关键流程：
// 1. 把一个大 Prompt 拆成多个小模块（人设、背景、任务、格式）
// 2. 每个模块用 PromptTemplate.fromTemplate() 独立定义
// 3. 用 PipelinePromptTemplate 把这些模块组合成一个最终 Prompt
// 4. 调用 .format() 时，所有模块的变量一起传入
//
// 知识扩展（小白能懂）：
// - Pipeline = "流水线"，就是把复杂任务拆成几个可复用的"积木"
// - 为什么拆分？因为不同场景可以复用相同模块：
//   * 人设模块 → 周报用、OKR回顾用、项目总结用，都一样
//   * 背景模块 → 公司和团队信息，所有文档都需要
//   * 任务模块 → 不同场景有不同的任务描述
//   * 格式模块 → Markdown、JSON、邮件格式，按需切换
// - 好处：改一处（如公司名），所有场景同步更新，不用每个文件都改
// - 和代码的"组件化"思想一样：小模块好维护、好测试、好复用
// ============================================

import "dotenv/config"
import { ChatOpenAI } from "@langchain/openai"
import { PipelinePromptTemplate, PromptTemplate } from "@langchain/core/prompts"

const model = new ChatOpenAI({
    modelName: process.env.MODEL_NAME,
    apiKey: process.env.API_KEY,
    temperature: 0,
    configuration: { baseURL: process.env.BASE_URL }
})

// 步骤 1：定义可复用的小模块

// 模块 A：人设（告诉 AI 它是谁、什么风格）
const personaPrompt = PromptTemplate.fromTemplate(
    `你是一名资深工程团队负责人，写作风格：{tone}。\n你擅长把技术细节写得既专业又有温度。\n`
)

// 模块 B：背景（公司和团队信息）
const contextPrompt = PromptTemplate.fromTemplate(
    `公司：{company}\n部门：{team}\n汇报对象：{manager}\n时间：{week}\n核心目标：{goal}\n`
)

// 模块 C：任务（本周具体工作）
const taskPrompt = PromptTemplate.fromTemplate(
    `以下是本周开发活动：\n{activities}\n\n请提炼：1.成就亮点 2.潜在风险 3.下周计划\n`
)

// 模块 D：格式（输出要求）
const formatPrompt = PromptTemplate.fromTemplate(
    `请用 Markdown 输出，结构包含：\n1. 本周概览（2-3句话 Summary）\n2. 详细拆分（按模块分段）\n3. 关键指标表格：模块 | 亮点 | 风险 | 下周计划\n语气专业但轻松，符合 {company_values}。`
)

// 步骤 2：定义最终模板（把模块拼在一起）
const finalPrompt = PromptTemplate.fromTemplate(
    `{persona_block}\n{context_block}\n{task_block}\n{format_block}\n\n现在请生成本周最终周报：`
)

// 步骤 3：用 PipelinePromptTemplate 组合
const pipeline = new PipelinePromptTemplate({
    pipelinePrompts: [
        { name: "persona_block", prompt: personaPrompt },
        { name: "context_block", prompt: contextPrompt },
        { name: "task_block", prompt: taskPrompt },
        { name: "format_block", prompt: formatPrompt }
    ],
    finalPrompt
})

// 步骤 4：传入所有变量，生成最终 Prompt
const formatted = await pipeline.format({
    tone: "专业、清晰、略带幽默",
    company: "星航科技",
    team: "AI 平台组",
    manager: "王总",
    week: "2025-02-03 ~ 2025-02-09",
    goal: "完成智能周报 Agent 的 MVP 版本",
    activities:
        "- Git: 58 次提交，3 个分支合并\n" +
        "- Jira: 完成 12 个 Story，关闭 7 个 Bug\n" +
        "- 关键：完成 Pipeline 设计、Prompt 拆分、接入 ExampleSelector",
    company_values: "「极致、开放、靠谱」"
})

console.log("=== Pipeline 组合后的 Prompt ===")
console.log(formatted)

// 步骤 5：发给 LLM
console.log("\n=== AI 生成的周报 ===")
const response = await model.invoke(formatted)
console.log(response.content)
