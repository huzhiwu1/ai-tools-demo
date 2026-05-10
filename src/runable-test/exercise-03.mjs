import "dotenv/config"
import { ChatOpenAI } from "@langchain/openai";
import { RunnableBranch, RunnableLambda, RunnableSequence } from "@langchain/core/runnables";
import { PromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { z } from "zod";

const model = new ChatOpenAI({
    apiKey: process.env.API_KEY,
    modelName: process.env.MODEL_NAME,
    temperature: 0,
    configuration: {
        baseURL: process.env.BASE_URL
    }
});

const categorySchema = z.object({
    category: z.enum(["tech", "chat", "complaint"]).describe("问题类型：tech=技术问题, chat=闲聊问候, complaint=投诉建议"),
    confidence: z.number().describe("分类置信度，0-1之间的小数"),
    reason: z.string().describe("分类理由，一句话说明为什么归为这个类别")
})

const modelWithSchema = model.withStructuredOutput(categorySchema);

const questionPrompt = PromptTemplate.fromTemplate("请将以下问题分类为技术问题、闲聊问候还是投诉建议，并给出置信度和理由：{question}");

const classifyQuestion = RunnableSequence.from([
    questionPrompt,
    modelWithSchema
]);


const stringOutputParser = new StringOutputParser();

const techChain = RunnableSequence.from([
    PromptTemplate.fromTemplate(
        "你是一位严谨的技术专家，请用专业、准确的语言回答以下问题。\n" +
        "回答完毕后，结尾必须加上'如需进一步查询文档，请告知'。\n\n" +
        "问题：{question}"
    ),
    model,
    stringOutputParser
]);



const chatChain = RunnableSequence.from([
    PromptTemplate.fromTemplate(
        "你是一位友好的AI小助理，请用轻松热情的语气回复，可以适当使用'~'、'哦'等语气词。\n\n" +
        "用户说：{question}"
    ),
    model,
    stringOutputParser
])


const complaintChain = RunnableSequence.from([
    PromptTemplate.fromTemplate(
        "你是客服代表，回复必须满足三点：\n" +
        "1. 先表达同理心，如'非常抱歉给您带来困扰'\n" +
        "2. 说明会转接人工客服跟进\n" +
        "3. 询问客户最佳联系时间\n\n" +
        "客户反馈：{question}"
    ),
    model,
    stringOutputParser
])

const handleDefault = RunnableLambda.from((input) => {
    return `默认处理: 无法识别的输入 ${input}`
})
const isTech = RunnableLambda.from((input) => {
    console.log("Checking if tech:", input);
    return input.category === "tech";
});

const isChat = RunnableLambda.from((input) => {
    console.log("Checking if chat:", input);
    return input.category === "chat";
});

const isComplaint = RunnableLambda.from((input) => {
    console.log("Checking if complaint:", input);
    return input.category === "complaint";
});

const classify = RunnableBranch.from([
    [isTech, techChain],
    [isChat, chatChain],
    [isComplaint, complaintChain],
    handleDefault
]);

const routerWithContext = RunnableLambda.from(async (input) => {
    const classification = await classifyQuestion.invoke(input);
    console.log("Classification:", classification);
    const reply = await classify.invoke({
        question: input.question,
        ...classification
    });
    return {
        question: input.question,
        ...classification,
        reply
    };
});

const handlerMap = {
    tech: "技术助手",
    chat: "小助理",
    complaint: "客服专员"
}


const formatResponse = RunnableLambda.from((input) => {
    console.log("Formatting response:", input);
    return {
        originalQuery: input.question,
        category: input.category,
        confidence: input.confidence,
        reply: input.reply,
        handledBy: handlerMap[input.category],
        responseTime: Date.now()
    }
});

const chain = RunnableSequence.from([
    routerWithContext,
    formatResponse
]);
const cases = [
    "Milvus 和 Chroma 哪个向量数据库更适合生产环境？",       // tech
    "你好呀，今天天气怎么样？",                                // chat
    "你们的系统崩了三次了，严重影响我的工作，必须给个说法！",  // complaint
    "什么是 RAG？"                                            // tech
]
for (const question of cases) {
    console.log(await chain.invoke({ question }));
}
