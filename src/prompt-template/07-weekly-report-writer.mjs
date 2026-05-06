// ============================================
// 07-weekly-report-writer.mjs
// ============================================
// 职责：综合实战 —— 用 Pipeline + FewShot + ExampleSelector 写一个智能周报生成器
//
// 关键流程：
// 1. 用 PipelinePromptTemplate 把 Prompt 拆成「人设 + 背景 + 任务 + 格式」四模块
// 2. 用 FewShotPromptTemplate + ExampleSelector 注入最相关的周报示例
// 3. 用 ChatPromptTemplate 组合 system/human 消息，调用 LLM 生成周报
// 4. 打印最终 Prompt 和 AI 输出，观察每个组件的贡献
//
// 知识扩展（小白能懂）：
// - 为什么组合这么多组件？因为单一技术解决不了一个复杂问题
//   * Pipeline → 解决"结构混乱"，让 Prompt 模块化、可复用
//   * FewShot → 解决"风格不对"，让 AI 模仿示例的语气
//   * ExampleSelector → 解决"示例太多"，只选最相关的 2-3 个
//   * ChatPromptTemplate → 解决"角色不清"，system 设定人设，human 给任务
// - 这就像搭积木：每个组件解决一个小问题，组合起来解决大问题
// - 生产环境的 Agent 几乎都是这种"组合拳"，没有银弹
// ============================================

import "dotenv/config"
import { ChatOpenAI } from "@langchain/openai"
import {
    ChatPromptTemplate,
    PipelinePromptTemplate,
    PromptTemplate,
    FewShotPromptTemplate
} from "@langchain/core/prompts"
import { LengthBasedExampleSelector } from "@langchain/core/example_selectors"

const model = new ChatOpenAI({
    modelName: process.env.MODEL_NAME,
    apiKey: process.env.API_KEY,
    temperature: 0,
    configuration: { baseURL: process.env.BASE_URL }
})

// ========== 模块 1：FewShot 示例库（不同风格的周报片段）==========
const examples = [
    {
        requirement: "重点突出稳定性治理",
        snippet:
            "- 处理 P1 故障 1 起、P2 故障 2 起，均在 SLA 内修复\n" +
            "- 补充 3 个高风险接口的限流与熔断策略\n" +
            "- 新增 6 条延迟抖动告警规则"
    },
    {
        requirement: "偏向对外展示成果",
        snippet:
            "- 上线「实时订单看板」，支持业务查看转化漏斗\n" +
            "- 打通埋点 → 数据仓库 → 实时服务闭环\n" +
            "- 完成 2 场跨部门分享，收到 15 条正向反馈"
    },
    {
        requirement: "非常简短的周报",
        snippet: "本周整体运行平稳，未发生重大事故，核心指标均在预期范围内。"
    }
]

const examplePrompt = PromptTemplate.fromTemplate(
    `场景：{requirement}\n示例：\n{snippet}\n---`
)

// 用 ExampleSelector 智能选择示例（控制总长度不超过 500 字符）
const exampleSelector = await LengthBasedExampleSelector.fromExamples(examples, {
    examplePrompt,
    maxLength: 500,
    getTextLength: (text) => text.length
})

const fewShotPrompt = new FewShotPromptTemplate({
    examplePrompt,
    exampleSelector,
    prefix: "参考以下周报示例的风格和结构：\n",
    suffix: "\n现在请根据示例风格，为下面场景生成周报。",
    inputVariables: []
})

// ========== 模块 2：Pipeline 模块化 Prompt ==========

const personaPrompt = PromptTemplate.fromTemplate(
    `你是一名资深工程团队负责人，写作风格：{tone}。`
)

const contextPrompt = PromptTemplate.fromTemplate(
    `公司：{company} | 团队：{team} | 汇报对象：{manager} | 时间：{week}`
)

const taskPrompt = PromptTemplate.fromTemplate(
    `本周开发活动：\n{activities}\n\n请提炼亮点、风险、下周计划。`
)

const formatPrompt = PromptTemplate.fromTemplate(
    `输出 Markdown 周报，结构：1.概览 2.详细拆分 3.关键指标表格（模块|亮点|风险|下周计划）`
)

// 最终模板：把 FewShot + Pipeline 拼在一起
const finalTemplate = PromptTemplate.fromTemplate(
    `{persona_block}\n{context_block}\n{task_block}\n{format_block}\n\n{fewshot_block}\n\n现在请生成最终周报：`
)

const pipeline = new PipelinePromptTemplate({
    pipelinePrompts: [
        { name: "persona_block", prompt: personaPrompt },
        { name: "context_block", prompt: contextPrompt },
        { name: "task_block", prompt: taskPrompt },
        { name: "format_block", prompt: formatPrompt },
        { name: "fewshot_block", prompt: fewShotPrompt }
    ],
    finalPrompt: finalTemplate
})

// ========== 模块 3：生成最终 Prompt 并调用 LLM ==========

const formatted = await pipeline.format({
    tone: "专业、清晰、略带鼓励",
    company: "星航科技",
    team: "AI 平台组",
    manager: "王总",
    week: "2025-05-05 ~ 2025-05-11",
    activities:
        "- 小李：完成 AI 助手工单流转，提交 25 次\n" +
        "- 小张：接入日志检索和知识库查询，提交 19 次\n" +
        "- 小王：完善监控告警，新增 10 条核心告警规则\n" +
        "- 实习生小陈：补充使用文档和 FAQ，支持 3 个试点团队"
})

console.log("=== 最终组合后的 Prompt ===")
console.log(formatted)
console.log("\n" + "=".repeat(60))

// 用 ChatPromptTemplate 包装成消息数组
const chatPrompt = ChatPromptTemplate.fromMessages([
    ["system", "你是一名资深工程团队负责人。"],
    ["human", formatted]
])
const messages = await chatPrompt.formatMessages({})

console.log("\n=== AI 生成的周报 ===")
const response = await model.invoke(messages)
console.log(response.content)
