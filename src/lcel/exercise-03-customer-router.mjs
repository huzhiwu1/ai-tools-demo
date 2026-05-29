import "dotenv/config"
import { ChatOpenAI } from "@langchain/openai";

import { PromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { RunnableLambda, RunnablePassthrough, RunnableSequence, RunnableBranch } from "@langchain/core/runnables";
import chalk from "chalk"
import { z } from "zod";

const baseModelConfig = {
    modelName: process.env.MODEL_NAME,
    apiKey: process.env.API_KEY,

    configuration: {
        baseURL: process.env.BASE_URL,
    },
}

const model = new ChatOpenAI({
    ...baseModelConfig,
    temperature: 0,
});


const classifySchema = z.object({
    intent: z.string().describe("用户的问题分类,分类总共四个，分别是: presales、aftersales、chitchat、unknown"),
    reason: z.string().describe("用户问题分类的理由"),
});

const classifyPrompt = PromptTemplate.fromTemplate(
    `你是客服意图分类器。请判断用户问题属于哪一类：
- presales : 售前咨询（价格、配置、库存等）
- aftersales : 售后问题（退货、投诉、维修等）
- chitchat : 闲聊（问候、天气、感慨等）
- unknown : 看不懂或无法分类

【用户问题】
{query}`
);

const classifyModel = model.withStructuredOutput(classifySchema);


const classifyChain = RunnablePassthrough.assign({
    classifyModel: classifyPrompt.pipe(classifyModel)
})

const flattenChain = RunnableLambda.from((input) => ({
    query: input.query,
    intent: input.classifyModel.intent,
    reason: input.classifyModel.reason,
}));

const finalChain = RunnableSequence.from([classifyChain, flattenChain]);

const presalesModel = new ChatOpenAI({ ...baseModelConfig, temperature: 0.7 })
const aftersalesModel = new ChatOpenAI({ ...baseModelConfig, temperature: 0 })
const chitchatModel = new ChatOpenAI({ ...baseModelConfig, temperature: 0.9 })


const presalesPrompt = PromptTemplate.fromTemplate(`
你是热情的售前客服。请用 1-2 句话回答用户咨询，结尾加一个友好的 emoji。

用户问题：{query}
`)


const presalesChain = presalesPrompt.pipe(presalesModel).pipe(new StringOutputParser())

const aftersalesPrompt = PromptTemplate.fromTemplate(`
你是严谨的售后专员。请先表达歉意，再给出 1-2 句具体的解决方案，语气稳重。

用户问题：{query}
`)
const aftersalesChain = aftersalesPrompt.pipe(aftersalesModel).pipe(new StringOutputParser())

const chitchatPrompt = PromptTemplate.fromTemplate(`
你是俏皮的小助手。请用一句简短俏皮的话回应。

用户说：{query}
`)
const chitchatChain = chitchatPrompt.pipe(chitchatModel).pipe(new StringOutputParser())

const defaultPrompt = PromptTemplate.fromTemplate(`
你是礼貌的客服。用户的问题我们暂时无法准确理解，请礼貌引导用户重新描述。

用户问题：{query}
`)

const defaultChain = defaultPrompt.pipe(model).pipe(new StringOutputParser())

const routerChain = RunnableBranch.from([
    [(step) => step.intent === "presales", presalesChain],
    [(step) => step.intent === "aftersales", aftersalesChain],
    [(step) => step.intent === "chitchat", chitchatChain],
    defaultChain,
]);


const enrichWithAnswer = RunnablePassthrough.assign({
    answer: routerChain,
})


const fullChain = RunnableSequence.from([finalChain, enrichWithAnswer]);


const testCases = [
    "这款手机多少钱？有红色的吗？",
    "我要退货！你们东西质量太差了！",
    "今天天气真好啊~",
    "呃呃呃...嗯哼？",
]

for (const query of testCases) {
    console.log(chalk.bgCyan(`\n=== 用户问：${query} ===`))
    try {
        const result = await fullChain.invoke({ query })
        console.log(chalk.yellow(`[意图] ${result.intent}  [理由] ${result.reason}`))
        console.log(chalk.green(`[回答] ${result.answer}`))
    } catch (err) {
        console.error(chalk.red("出错:"), err.message)
    }
}

// ============================================
// 【调试参考区 · 不改原代码】
// ============================================
//
// 【现有代码的 3 个 bug（按致命程度排序）】
//
// Bug 1（必崩）：顶部没有 import chalk
//   现象：ReferenceError: chalk is not defined
//   修复：在顶部加  import chalk from "chalk"
//
// Bug 2（隐蔽）：业务子链没接 StringOutputParser
//   现象：result.answer 是 AIMessage 对象，打印出来是一大址 JSON
//   原因：presalesPrompt.pipe(presalesModel) 返回 AIMessage，不是字符串
//   修复：每条业务子链末尾都接上 .pipe(new StringOutputParser())
//   例：presalesPrompt.pipe(presalesModel).pipe(new StringOutputParser())
//
// Bug 3（边界）：RunnableBranch 缺默认分支
//   现象：LLM 偶尔返回不在 enum 里的 intent（如大写 PRESALES）会报错
//   修复：Branch 最后一项不带条件即默认分支
//   例：RunnableBranch.from([
//             [(s) => s.intent === "presales", presalesChain],
//             [(s) => s.intent === "aftersales", aftersalesChain],
//             [(s) => s.intent === "chitchat", chitchatChain],
//             defaultChain,  ← 默认分支不包括在数组中的条件对里
//         ])
//
// 【加日志大法】
//
// 方法 1：万能 tap Lambda（推荐）
//   在链的任意位置插入，看到进入这一节的完整输入
//   const tap = (label) => RunnableLambda.from((input) => {
//       console.log(`\n[🔍 ${label}]`)
//       console.dir(input, { depth: 3, colors: true })
//       return input
//   })
//
//   用法：
//   const fullChain = RunnableSequence.from([
//       tap("入口"),                  ← 看 { query }
//       classifyChain,
//       tap("分类后"),                ← 看 { query, classifyModel: {...} }
//       flattenChain,
//       tap("摊平后"),                ← 看 { query, intent, reason }
//       enrichWithAnswer,
//       tap("最终"),                  ← 看 { query, intent, reason, answer }
//   ])
//
// 方法 2：拆开每一节单独 invoke（定位最快）
//   const input = { query: "这款手机多少钱\uff1f" }
//   const r1 = await classifyChain.invoke(input);    console.log("r1:", r1)
//   const r2 = await flattenChain.invoke(r1);        console.log("r2:", r2)
//   const r3 = await routerChain.invoke(r2);         console.log("r3:", r3)
//
// 方法 3：streamEvents 看 LangChain 内部事件流（高阶）
//   const events = await fullChain.streamEvents(
//       { query: "这款手机多少钱\uff1f" },
//       { version: "v2" }
//   )
//   for await (const ev of events) {
//       if (ev.event === "on_chain_end") {
//           console.log(`[${ev.name}] →`, JSON.stringify(ev.data.output)?.slice(0, 100))
//       }
//   }
//
// 【加日志的 4 条铁律】
//   1. tap 必须 return input，否则下游拿不到数据
//   2. 先拆开每节单跱定位问题节点，再加 tap 看完整数据流
//   3. 不要用 console.log(input) 看套套对象，用 console.dir(input, { depth: 3 })
//   4. 调试完事记得把 tap 拿掉或换成 logger，别污染生产日志
//
// ============================================