// ============================================
// 04-runnable-passthrough.mjs
// ============================================
// 职责：学习 RunnablePassthrough —— 数据透传与字段扩展
//
// 关键流程：
// 1. new RunnablePassthrough() —— 原样透传输入，不做任何修改
// 2. RunnablePassthrough.assign({ newField: runnable }) —— 保留原输入 + 新增字段
// 3. 配合 RunnableMap 使用，实现"保留原始数据 + 并行处理"
// 4. RunnablePick —— 从对象中挑选指定字段
//
// 知识扩展（小白能懂）：
// - RunnablePassthrough 就像"复印机"：输入什么，输出什么，一模一样
// - RunnablePassthrough.assign 就像"复印 + 批注"：保留原文件 + 在旁边写新内容
// - 为什么需要它？因为 chain 中的每个环节只能"一个输入一个输出"，
//   如果后面的环节需要用到前面的原始数据，就需要 Passthrough 帮忙保留
// - 类比：你在计算器上算题，想知道 "原数字" 和 "计算结果"，
//   Passthrough 就是帮你把原数字也一起带下来的工具
// ============================================

import "dotenv/config"
import {
    RunnablePassthrough,
    RunnableLambda,
    RunnableSequence,
    RunnableMap,
    RunnablePick
} from "@langchain/core/runnables"

// ============================================
// 示例1：基础透传 —— 原样输出
// ============================================
console.log("=".repeat(60))
console.log("【示例1】RunnablePassthrough —— 原样透传")
console.log("=".repeat(60))

const passthrough = new RunnablePassthrough()

const result1 = await passthrough.invoke("你好，世界")
console.log(`输入: "你好，世界"`)
console.log(`输出: "${result1}"`)
console.log(`是否相等: ${result1 === "你好，世界"}`)

// ============================================
// 示例2：assign —— 保留原数据 + 新增字段
// ============================================
console.log("\n" + "=".repeat(60))
console.log("【示例2】RunnablePassthrough.assign —— 保留 + 扩展")
console.log("=".repeat(60))

// 原始输入是 { name: "张三", age: 25 }
// 我们想保留 name 和 age，同时新增 upperName 和 ageGroup
const enrichData = RunnablePassthrough.assign({
    upperName: RunnableLambda.from((input) => input.name.toUpperCase()),
    ageGroup: RunnableLambda.from((input) => input.age >= 18 ? "成年人" : "未成年人")
})

const result2 = await enrichData.invoke({ name: "张三", age: 25 })
console.log("输入: { name: '张三', age: 25 }")
console.log("输出:")
console.log(result2)
// { name: "张三", age: 25, upperName: "张三", ageGroup: "成年人" }

// ============================================
// 示例3：在 RunnableSequence 中使用 assign —— 逐步丰富数据
// ============================================
console.log("\n" + "=".repeat(60))
console.log("【示例3】在链中使用 assign —— 逐步丰富数据对象")
console.log("=".repeat(60))

// 场景：处理一篇文章，逐步添加各种分析结果
const processArticle = RunnableSequence.from([
    // 步骤1：接收原始文章，添加字数统计
    RunnablePassthrough.assign({
        wordCount: RunnableLambda.from((input) => input.article.split("").length)
    }),
    // 步骤2：在上一步基础上，添加段落数
    RunnablePassthrough.assign({
        paragraphCount: RunnableLambda.from((input) => input.article.split("\n").filter(p => p.trim()).length)
    }),
    // 步骤3：在上一步基础上，添加是否有代码块
    RunnablePassthrough.assign({
        hasCode: RunnableLambda.from((input) => input.article.includes("```"))
    }),
    // 步骤4：最终整理
    RunnableLambda.from((input) => ({
        title: input.title,
        article: input.article.slice(0, 50) + "...",
        stats: {
            wordCount: input.wordCount,
            paragraphCount: input.paragraphCount,
            hasCode: input.hasCode
        }
    }))
])

const article = `这是一篇关于 AI 的技术文章。

人工智能正在改变世界，从自动驾驶到医疗诊断。

\`\`\`python
print("Hello AI")
\`\`\``

const result3 = await processArticle.invoke({
    title: "AI 技术展望",
    article: article
})
console.log("文章分析结果:")
console.log(JSON.stringify(result3, null, 2))

// ============================================
// 示例4：RunnablePick —— 从对象中挑选字段
// ============================================
console.log("\n" + "=".repeat(60))
console.log("【示例4】RunnablePick —— 字段筛选")
console.log("=".repeat(60))

// 场景：前一个环节输出了很多字段，但后一个环节只需要其中几个
const fullData = {
    name: "李四",
    age: 30,
    city: "北京",
    country: "中国",
    email: "li@example.com",
    phone: "13800138000",
    bio: "资深前端工程师"
}

// 只挑选 name 和 bio 两个字段
const pickNameAndBio = new RunnablePick(["name", "bio"])

const result4 = await pickNameAndBio.invoke(fullData)
console.log("原始数据包含:", Object.keys(fullData).join(", "))
console.log("挑选后:")
console.log(result4)

// 在 chain 中使用 RunnablePick
const chain = RunnableSequence.from([
    // 先丰富数据
    RunnablePassthrough.assign({
        fullInfo: RunnableLambda.from((input) =>
            `${input.name}，${input.age}岁，来自${input.city}`
        )
    }),
    // 再挑选需要的字段传给下游
    new RunnablePick(["name", "fullInfo"])
])

const result4b = await chain.invoke(fullData)
console.log("\n链式处理后的结果:")
console.log(result4b)

// ============================================
// 示例5：经典组合模式 —— Passthrough + Map 保留原始输入
// ============================================
console.log("\n" + "=".repeat(60))
console.log("【示例5】经典模式 —— 保留原始输入的同时并行处理")
console.log("=".repeat(60))

// 场景：并行处理时，需要保留原始输入
const parallelWithOriginal = RunnableSequence.from([
    // 把原始输入放到 original 字段下，同时并行处理
    RunnableMap.from({
        original: new RunnablePassthrough(),
        processed: RunnableLambda.from((input) => ({
            upper: input.text.toUpperCase(),
            length: input.text.length,
            reversed: input.text.split("").reverse().join("")
        }))
    })
])

const result5 = await parallelWithOriginal.invoke({ text: "Hello Runnable" })
console.log("保留原始 + 并行处理:")
console.log(JSON.stringify(result5, null, 2))

// ============================================
// 【知识点总结】
// ============================================
console.log("\n" + "=".repeat(60))
console.log("【知识点总结】")
console.log("=".repeat(60))
console.log(`
1. new RunnablePassthrough()
   - 作用：原样透传输入
   - 用途：占位、调试、保留数据

2. RunnablePassthrough.assign({ key: runnable })
   - 作用：保留原对象所有字段 + 新增字段
   - 用途：逐步丰富数据对象，像给对象"加属性"

3. new RunnablePick(["field1", "field2"])
   - 作用：从对象中挑选指定字段
   - 用途：控制传给下游的数据量，只传需要的

4. 经典组合模式
   RunnableMap.from({
       original: new RunnablePassthrough(),     // 保留原输入
       resultA: runnableA,                       // 处理结果A
       resultB: runnableB                        // 处理结果B
   })

5. 注意事项
   - assign 不会覆盖原有字段（除非新字段名和原字段重名）
   - Pick 后的对象只包含指定的字段，其他字段丢失
   - 在 Sequence 中 assign 是"累加"的，可以链式使用
`)
