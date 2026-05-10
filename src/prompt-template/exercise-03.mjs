import "dotenv/config"
import { ChatOpenAI } from "@langchain/openai"
import { FewShotChatMessagePromptTemplate } from "@langchain/core/prompts"

const model = new ChatOpenAI({
    apiKey: process.env.API_KEY,
    modelName: process.env.MODEL_NAME,
    temperature: 0,
    configuration: {
        baseURL: process.env.BASE_URL,
    }
})

const examples = [
    {

    },
    {
        human: "What is the capital of Spain?",
        assistant: "The capital of Spain is Madrid.",
    },
    {
        human: "What is the capital of Italy?",
        assistant: "The capital of Italy is Rome.",
    },
];
