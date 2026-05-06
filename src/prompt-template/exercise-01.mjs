import "dotenv/config"
import { ChatOpenAI } from "@langchain/openai"
import { PromptTemplate } from "@langchain/core/prompts"

const model = new ChatOpenAI({
    modelName: process.env.MODEL_NAME,
    apiKey: process.env.API_KEY,
    temperature: 0,
    configuration: {
        baseURL: process.env.BASE_URL
    }
})

const translateTemplate = PromptTemplate.fromTemplate(
    `你是一个资深的翻译助手,` +
    `需要将{source_lang}` +
    `语言翻译成{target_lang}语言，` +
    `要求的翻译的风格是：{style}` +
    `翻译内容是：{text}`
)

async function translate({ source_lang, target_lang, style, text }) {
    const prompt = await translateTemplate.format({
        source_lang,
        target_lang,
        style,
        text
    })
    console.log("====格式化后的 prompt====")
    console.log(prompt)
    const res = await model.invoke(prompt)
    console.log("====AI生成的内容====")
    console.log(res.content)

}

await translate({
    source_lang: "英文",
    target_lang: "中文",
    style: "正式风格",
    text: "Hello, how are you?"
})


const translatePrompt = await translate({
    source_lang: "中文",
    target_lang: "日文",
    style: "口语化风格",
    text: "今晚的月亮很美"
})

