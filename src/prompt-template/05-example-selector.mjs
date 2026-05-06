// ============================================
// 05-example-selector.mjs
// ============================================
// 职责：学习 ExampleSelector —— 智能选择最相关的示例
//
// 关键流程：
// 1. 准备一批示例（不同风格、不同长度）
// 2. 创建 ExampleSelector（如 LengthBasedExampleSelector），设定选择策略
// 3. 把 Selector 传给 FewShotPromptTemplate，替代固定的 examples 数组
// 4. 传入新任务时，Selector 自动挑选最合适的示例，再传给 LLM
//
// 知识扩展（小白能懂）：
// - FewShot 的痛点：示例多了浪费 token，示例少了覆盖不全
// - ExampleSelector 解决"选哪个示例"的问题：根据任务特征自动筛选
// - LengthBasedExampleSelector：按文本长度选，适合控制 prompt 总长度
// - SemanticSimilarityExampleSelector：按语义相似度选，适合找"最像"的示例（需要向量数据库）
// - 为什么重要？因为 LLM 的上下文窗口有限，不能塞 100 个示例
// - 生产环境常用策略：先用 Selector 选出 Top-K 最相关示例，再传给 FewShot
// ============================================

import "dotenv/config"
import { ChatOpenAI } from "@langchain/openai"
import { FewShotPromptTemplate, PromptTemplate } from "@langchain/core/prompts"
import { LengthBasedExampleSelector } from "@langchain/core/example_selectors"

const model = new ChatOpenAI({
    modelName: process.env.MODEL_NAME,
    apiKey: process.env.API_KEY,
    temperature: 0,
    configuration: { baseURL: process.env.BASE_URL }
})

// 步骤 1：准备一批长度差异明显的示例
const examples = [
    {
        requirement: "重点突出稳定性，适合发给关注风险的老板",
        snippet:
            "- 处理 P1 故障 1 起、P2 故障 2 起，均在 SLA 内修复\n" +
            "- 补充 3 个高风险接口的限流与熔断策略\n" +
            "- 新增 6 条延迟抖动告警规则"
    },
    {
        requirement: "偏向对外展示成果，适合发给跨部门同学",
        snippet:
            "- 上线「实时订单看板」，支持业务查看转化漏斗\n" +
            "- 打通埋点 → 数据仓库 → 实时服务闭环\n" +
            "- 完成 2 场跨部门分享，收到 15 条正向反馈"
    },
    {
        requirement: "只要非常简短的周报，两三句话告诉老板一切稳定",
        snippet: "本周整体运行平稳，未发生重大事故，核心指标均在预期范围内。"
    },
    {
        requirement: "需要详细的技术周报，涵盖研发测试上线监控各环节",
        snippet:
            "- 研发：完成结算服务重构，拆分 3 个独立子服务，接口延迟下降 35%\n" +
            "- 测试：补齐 20+ 条自动化用例，回归时间从 2 天缩短到 0.5 天\n" +
            "- 上线：采用灰度 + Canary 策略，2 次轻微抖动均在 5 分钟内回滚\n" +
            "- 监控：新增 8 条核心告警和 3 个 SLO 指标"
    }
]

// 步骤 2：定义单条示例模板
const examplePrompt = PromptTemplate.fromTemplate(`
场景：{requirement}
示例：
{snippet}
---`)

// 步骤 3：创建 ExampleSelector（按长度选择，控制总 prompt 长度）
const exampleSelector = await LengthBasedExampleSelector.fromExamples(examples, {
    examplePrompt,
    maxLength: 700,  // 选出来的示例总长度不超过 700 字符
    getTextLength: (text) => text.length
})

// 步骤 4：用 Selector 构建 FewShotPromptTemplate
const fewShotPrompt = new FewShotPromptTemplate({
    examplePrompt,
    exampleSelector,  // 关键：用 Selector 替代固定的 examples 数组
    prefix: "下面是一些不同风格的周报片段示例：\n",
    suffix: `

现在请根据上面的示例风格，为新场景写一份周报：
场景：{current_requirement}
请输出 Markdown 周报。`,
    inputVariables: ["current_requirement"]
})

// 步骤 5：测试——传入一个中等长度的需求，观察 Selector 选了哪些示例
const requirement =
    "我们本周在做内部 AI 助手项目，既有稳定性保障（处理线上问题），" +
    "也有新功能上线（接入知识库、日志检索）。"

const finalPrompt = await fewShotPrompt.format({
    current_requirement: requirement
})

console.log("=== Selector 自动挑选的示例（已组合进 Prompt）===")
console.log(finalPrompt)

// 步骤 6：发给 LLM
console.log("\n=== AI 生成的周报 ===")
const response = await model.invoke(finalPrompt)
console.log(response.content)
