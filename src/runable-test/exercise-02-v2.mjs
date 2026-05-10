import "dotenv/config"
import { ChatOpenAI } from "@langchain/openai";
import { RunnableLambda, RunnableSequence } from "@langchain/core/runnables";
import { StructuredOutputParser, StringOutputParser } from "@langchain/core/output_parsers";
import { PromptTemplate } from "@langchain/core/prompts";
import { z } from "zod";

const model = new ChatOpenAI({
    apiKey: process.env.API_KEY,
    modelName: process.env.MODEL_NAME,
    temperature: 0,
    configuration: {
        baseURL: process.env.BASE_URL
    }
});

const cleanText = RunnableLambda.from((input) => {
    const text = input.rawQuery || "";
    const cleaned = text
        .replace(/\s+/g, "")
        .replace(/[，。、；：,.;:!~"'""''()（）\[\]【】《》…—\-]/g, "")
        .replace(/那个|就是|然后|嗯|呃/g, "")
    console.log(`步骤1 原始文本长度: ${text.length}, 清洗后文本长度: ${cleaned.length}, 清洗后文本: ${cleaned}`);
    return {
        ...input,
        cleaned
    };
});

const checkLength = RunnableLambda.from((input) => {
    const text = input.cleaned;
    const charCount = text.length;
    const tooShort = charCount < 3
    const tooLong = charCount > 100
    console.log(`[步骤2] 字数=${charCount}, tooShort=${tooShort}, tooLong=${tooLong}`)
    return { ...input, charCount, tooShort, tooLong }
});


const addContext = RunnableLambda.from((input, config) => {
    const { userId, sessionId, source } = config?.configurable ?? {};
    console.log(`步骤3 添加上下文 userId: ${userId}, sessionId: ${sessionId}, source: ${source}`);
    return {
        ...input,
        meta: {
            userId,
            sessionId,
            source,
        }
    }
});

const promptTemplate = PromptTemplate.fromTemplate("请把用户的原始问题改写成一个更简洁、更专业的版本\n" +
    "原始问题：{text}\n" +
    "只返回改写后的问题，不需要其他内容\n"
);

const promptChain = RunnableSequence.from([
    promptTemplate,
    model,
    new StringOutputParser()
]);

const generateQuestion = RunnableLambda.from(async (input) => {
    const question = await promptChain.invoke({ text: input.cleaned });
    console.log(`步骤4 改写前的问题: ${input.cleaned}, 改写后的问题: ${question}`);
    return {
        ...input,
        refinedQuery: question
    };
});

// const schema = z.object({
//     originalQuery: z.string().describe("用户原始问题"),
//     refinedQuery: z.string().describe("LLM改写后的问题"),
//     meta: z.object({
//         userId: z.string().describe("用户id"),
//         sessionId: z.string().describe("会话id"),
//         source: z.string().describe("来源"),
//         charCount: z.number().describe("字符长度"),
//         processedAt: z.date().describe("处理时间")
//     })
// });


const generateOutput = RunnableLambda.from((input) => {
    return {
        originalQuery: input.rawQuery,
        refinedQuery: input.refinedQuery,
        meta: {
            ...input.meta,
            charCount: input.rawQuery.length,
            processedAt: new Date()
        }
    };
});

const chain = RunnableSequence.from([
    cleanText,
    checkLength,
    addContext,
    generateQuestion,
    generateOutput
])

const cases = [
    { rawQuery: "乔峰的武功怎么样？" },
    { rawQuery: "那个...我最近在看天龙八部，然后想问一下，就是乔峰这个人他的武功水平怎么样呢？" },
    { rawQuery: "谁？" }   // 这个应该 tooShort=true
]

for (const c of cases) {
    console.log("\n========== 新用例 ==========")
    const r = await chain.invoke(c, { configurable: { userId: "u001", sessionId: "s123", source: "web" } })
    console.log(r)
}
