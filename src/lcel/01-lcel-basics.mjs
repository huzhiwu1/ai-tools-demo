// ============================================
// 01-lcel-basics.mjs
// ============================================
// 职责：LCEL（LangChain Expression Language）入门 —— 一句话看懂"为什么用 LCEL"
//
// 关键流程：
// 1. 看「不用 LCEL」的写法：手写一堆 await，难复用、难替换、难加日志
// 2. 看「用 LCEL」的写法：用 .pipe() / RunnableSequence 把每一步串起来
// 3. 体会四大基础 Runnable：Lambda、Sequence、Passthrough.assign、Branch
// 4. 理解 LCEL 的核心承诺：所有 Runnable 都有 invoke / stream / batch 三种调用方式
//
// 知识扩展（小白能懂）：
//   什么是 LCEL？
//   - 全称 LangChain Expression Language，本质是「用一组标准 Runnable 把 AI 流程拼起来」
//   - 类比：Linux 的管道符 a | b | c，每一步的输出自动流向下一步
//   - 在 JS/TS 里就是 a.pipe(b).pipe(c) 或 RunnableSequence.from([a, b, c])
//
//   为什么不直接写 await a(); await b(); ?
//   1. LCEL 写出来的链天然支持 .stream()（流式）和 .batch()（批量），不用自己改造
//   2. LCEL 链可以挂 LangSmith 追踪、回调、并发控制，业务代码完全不动
//   3. LCEL 链是声明式的：一眼看到"这条链做了几步、每步做啥"，便于团队协作
//
//   小白只需要先记住三件事：
//   1) 任何输入输出明确的处理步骤，都可以包成 Runnable
//   2) 多个 Runnable 用 .pipe() 或 Sequence 串成一条链
//   3) 数据在链里自动流动：上一步的输出 = 下一步的输入
// ============================================

import "dotenv/config"
import chalk from "chalk"
import {
    RunnableLambda,
    RunnableSequence,
    RunnablePassthrough,
    RunnableBranch,
} from "@langchain/core/runnables"
import { ChatOpenAI } from "@langchain/openai"
import { PromptTemplate } from "@langchain/core/prompts"
import { StringOutputParser } from "@langchain/core/output_parsers"

// ============================================
// 准备一个 LLM 模型（后面演示用）
// ============================================
const model = new ChatOpenAI({
    modelName: process.env.MODEL_NAME,
    apiKey: process.env.API_KEY,
    temperature: 0,
    configuration: { baseURL: process.env.BASE_URL },
})

// ============================================
// 示例1：不用 LCEL vs 用 LCEL —— 同一件事的两种写法
// ============================================
console.log(chalk.bgCyan("\n=== 【示例1】不用 LCEL vs 用 LCEL ==="))

// ---------- 写法 A：手写流程（难维护） ----------
async function summarizeWithoutLCEL(concept) {
    const prompt = `请用一句话解释这个技术概念：${concept}`
    const aiMsg = await model.invoke(prompt)         // 第1步：调模型
    const text = aiMsg.content                       // 第2步：取出文本
    return `📌 ${text}`                              // 第3步：加前缀
}

// ---------- 写法 B：LCEL 链（声明式） ----------
const promptTpl = PromptTemplate.fromTemplate(
    "请用一句话解释这个技术概念：{concept}"
)
const addPrefix = RunnableLambda.from((text) => `📌 ${text}`)

// 这里就是 LCEL 的灵魂：一条链清晰展示"输入 → 模板 → LLM → 解析 → 加前缀"
const summaryChain = promptTpl
    .pipe(model)
    .pipe(new StringOutputParser())
    .pipe(addPrefix)

// 关键点：同一条链既能 invoke 也能 stream，业务代码不用改
const a = await summarizeWithoutLCEL("RAG")
const b = await summaryChain.invoke({ concept: "RAG" })
console.log(chalk.yellow("写法 A 结果："), a)
console.log(chalk.green("写法 B 结果："), b)

// ============================================
// 示例2：RunnableLambda —— 把任意函数变成链上的一环
// ============================================
console.log(chalk.bgCyan("\n=== 【示例2】RunnableLambda：万能转换器 ==="))

// 普通函数没有 .pipe()，没法参与链式组装
// RunnableLambda 就是给普通函数戴上"链工具"的帽子
const upper = RunnableLambda.from((s) => s.toUpperCase())
const exclaim = RunnableLambda.from((s) => `${s}!!!`)

// 串成链：输入字符串 → 转大写 → 加感叹号
const shoutChain = upper.pipe(exclaim)
console.log("输入: hello")
console.log("输出:", await shoutChain.invoke("hello"))   // HELLO!!!

// ============================================
// 示例3：RunnableSequence —— 列表式组装（等价于 .pipe 链）
// ============================================
console.log(chalk.bgCyan("\n=== 【示例3】RunnableSequence：列表式组装 ==="))

// .pipe(a).pipe(b).pipe(c)  ===  RunnableSequence.from([a, b, c])
// 用 Sequence 在结构变复杂时更好读
const seqChain = RunnableSequence.from([
    RunnableLambda.from((n) => n + 1),    // 5 → 6
    RunnableLambda.from((n) => n * 2),    // 6 → 12
    RunnableLambda.from((n) => `结果是 ${n}`),
])
console.log("输入: 5  →  输出:", await seqChain.invoke(5))

// ============================================
// 示例4：RunnablePassthrough.assign —— 链上"挂字段"
// ============================================
console.log(chalk.bgCyan("\n=== 【示例4】RunnablePassthrough.assign：保留原值 + 增加新字段 ==="))

// 场景：链的下游需要同时拿到「原始问题」和「LLM 给出的扩展」
// .assign() 就是"在原对象上挂一个新字段"，原字段一个不丢
const enrich = RunnablePassthrough.assign({
    // 在 input 上新增一个 length 字段
    length: RunnableLambda.from((input) => input.text.length),
    // 在 input 上新增一个 reversed 字段
    reversed: RunnableLambda.from((input) => input.text.split("").reverse().join("")),
})

const enriched = await enrich.invoke({ text: "LCEL" })
console.log("输入: { text: 'LCEL' }")
console.log("输出:", enriched)
// { text: 'LCEL', length: 4, reversed: 'LCEL' 反过来 }

// 知识扩展：为什么 Agent 里特别爱用 .assign？
// 因为 Agent 的状态对象（messages, response, tools...）需要一路带下去
// 每一步只往 state 上"加"东西，永远不丢，下一步可以随时拿到上几步的结果

// ============================================
// 示例5：RunnableBranch —— 链上的"if/else"
// ============================================
console.log(chalk.bgCyan("\n=== 【示例5】RunnableBranch：条件分支 ==="))

// 场景：根据数字正负，走不同的处理路径
const router = RunnableBranch.from([
    // [判断条件函数, 满足时走的分支]
    [(n) => n > 0, RunnableLambda.from((n) => `正数：${n} + 10 = ${n + 10}`)],
    [(n) => n < 0, RunnableLambda.from((n) => `负数：${n} - 10 = ${n - 10}`)],
    // 最后一个不带条件，是默认分支
    RunnableLambda.from((n) => `零或其它：${n}`),
])

for (const x of [5, -3, 0]) {
    console.log(`  输入 ${x} → ${await router.invoke(x)}`)
}

// 知识扩展：Agent 里 Branch 用来做什么？
// LLM 输出可能是「最终回答」也可能是「调用工具的指令」
// Branch 就是这个分岔口：
//   if (response.tool_calls?.length > 0) 执行工具分支
//   else 进入"完成"分支返回最终答案
// （示例3的 mcp 教学文件里你会再次看到这个套路）

// ============================================
// 示例6：所有 Runnable 都自带 stream / batch
// ============================================
console.log(chalk.bgCyan("\n=== 【示例6】LCEL 的隐藏福利：stream / batch ==="))

console.log(chalk.blue("【流式 stream】一边生成一边打字机输出："))
const stream = await summaryChain.stream({ concept: "向量数据库" })
for await (const chunk of stream) {
    process.stdout.write(chalk.green(chunk))
}
console.log("\n")

console.log(chalk.blue("【批量 batch】一次喂多个输入并行处理："))
const batchInputs = [
    { concept: "Embedding" },
    { concept: "Token" },
]
const batchOut = await summaryChain.batch(batchInputs)
batchOut.forEach((text, i) => console.log(`  [${i}] ${text}`))

// ============================================
// 【知识点总结】
// ============================================
console.log(chalk.bgMagenta("\n=== 【知识点总结】==="))
console.log(`
1. LCEL 的本质：用统一接口（Runnable）把 AI 流程拼成一条链
   - 链的每一节都实现了 invoke / stream / batch
   - 不用自己写循环就有流式输出和批量推理

2. 入门必会的 5 个 Runnable
   - RunnableLambda  : 把普通函数包成链上一环
   - RunnableSequence: 把多个 Runnable 串成线性流水线
   - .pipe()         : Sequence 的语法糖，链短的时候更直观
   - RunnablePassthrough.assign : 不丢原数据，往状态对象上"挂字段"
   - RunnableBranch  : 链上的 if/else，做分支路由

3. 何时用 LCEL，何时不用
   - 简单脚本（一两步）：直接 await 也行，没必要套链
   - 多步流程 / 需要流式 / 多种调用方式（invoke、stream、batch）：必上 LCEL
   - 复杂 Agent（多轮工具调用循环）：用 LCEL + Branch + assign 组装"一步"，再用外层 for 控制循环次数

4. 接下来怎么学
   - 02-rag-chain.mjs    ：用 LCEL 拼一条 RAG 链（基于 ebook-reader-rag.mjs）
   - 03-react-agent.mjs  ：用 LCEL 拼一个 ReAct Agent 单步（基于 mcp-test.mjs）
`)
