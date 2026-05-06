// ============================================
// 03-fewshot-prompt-template.mjs
// ============================================
// 职责：学习 FewShotPromptTemplate —— 给 AI 看示例，让它"照猫画虎"
//
// 关键流程：
// 1. 准备几条"输入 → 期望输出"的示例（few-shot examples）
// 2. 定义单条示例的模板（examplePrompt），告诉 AI 示例长什么样
// 3. 用 FewShotPromptTemplate 把示例 + 前缀 + 后缀组合成最终 prompt
// 4. 传入新任务，AI 会模仿示例的风格和结构
//
// 知识扩展（小白能懂）：
// - Few-shot = "给几个例子"，是教 LLM 最快的方式，比写规则更有效
// - 原理：LLM 的注意力机制会"关注"示例中的模式，新任务时自动模仿
// - 示例质量 > 数量：2-3 个高质量示例 > 10 个 mediocre 示例
// - 示例要覆盖不同场景（保守型、积极型、简洁型），让 AI 学会"变通"
// - 适用于：风格迁移（让 AI 模仿特定语气）、格式固定（表格/JSON）、复杂推理
// ============================================

import "dotenv/config"
import { ChatOpenAI } from "@langchain/openai"
import { FewShotPromptTemplate, PromptTemplate } from "@langchain/core/prompts"

const model = new ChatOpenAI({
    modelName: process.env.MODEL_NAME,
    apiKey: process.env.API_KEY,
    temperature: 0,
    configuration: { baseURL: process.env.BASE_URL }
})

// 步骤 1：准备示例数据（输入 → 期望输出）
const examples = [
    {
        requirement: "重点突出稳定性，适合发给关注风险的老板",
        style: "稳健、保守，多强调风险识别",
        snippet:
            "- 处理 P1 故障 1 起、P2 故障 2 起，均在 SLA 内修复\n" +
            "- 补充 3 个高风险接口的限流与熔断策略\n" +
            "- 新增 6 条延迟抖动告警规则"
    },
    {
        requirement: "偏向对外展示成果，适合发给跨部门同学",
        style: "积极、突出成果，技术细节适度抽象",
        snippet:
            "- 上线「实时订单看板」，支持业务查看转化漏斗\n" +
            "- 打通埋点 → 数据仓库 → 实时服务闭环\n" +
            "- 完成 2 场跨部门分享，收到 15 条正向反馈"
    }
]

// 步骤 2：定义单条示例的模板
const examplePrompt = PromptTemplate.fromTemplate(`
用户需求：{requirement}
期望风格：{style}
示例输出：
{snippet}
---`)

// 步骤 3：组合成 FewShotPromptTemplate
const fewShotPrompt = new FewShotPromptTemplate({
    examples,           // 示例数据
    examplePrompt,      // 单条示例模板
    prefix: "下面是几条不同风格的周报示例，你可以从中学习语气和结构：\n",
    suffix: `

现在请根据上面的示例风格，为下面这个场景写一份新周报：
场景：{current_requirement}
请输出 Markdown 周报草稿。`,
    inputVariables: ["current_requirement"]  // 新任务需要的变量
})

// 步骤 4：传入新任务，生成最终 prompt
const finalPrompt = await fewShotPrompt.format({
    current_requirement:
        "我们本周在做内部 AI 助手项目，既有稳定性保障（处理线上问题），" +
        "也有新功能上线（接入知识库）。希望周报既能体现'把坑兜住了'，" +
        "又能展示业务侧能感知到的亮点。"
})

console.log("=== FewShot 组合后的 Prompt ===")
console.log(finalPrompt)

// 步骤 5：发给 LLM
console.log("\n=== AI 生成的周报 ===")
const response = await model.invoke(finalPrompt)
console.log(response.content)
