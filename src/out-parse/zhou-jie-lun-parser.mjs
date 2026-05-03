import "dotenv/config"
import { ChatOpenAI } from "@langchain/openai";
import { StructuredOutputParser } from "@langchain/core/output_parsers";
import chalk from "chalk";

import { z } from "zod";

const model = new ChatOpenAI({
    modelName: process.env.MODEL_NAME,
    apiKey: process.env.API_KEY,
    temperature: 0,
    configuration: {
        baseURL: process.env.BASE_URL
    }
})

const schema = z.object({
    name: z.string().describe("姓名"),
    birthday: z.string().describe("出生日期"),
    gender: z.string().describe("性别"),
    song_count: z.number().describe("发布的歌曲数量"),
    follower_count: z.number().describe("粉丝数量"),
});

const parser = StructuredOutputParser.fromZodSchema(schema);

const formatInstructions = parser.getFormatInstructions();

async function main() {
    try {
        const question = `请介绍下周杰伦,\n\n${formatInstructions}`;
        console.log(chalk.yellow(`咨询AI问题：${question} `));
        const res = await model.invoke(question);
        console.log(chalk.green(`AI回答：${res.content} `));
        const jsonResult = await parser.parse(res.content);
        console.log(chalk.blue(`AI回答的JSON格式：${JSON.stringify(jsonResult, null, 2)} `));
    } catch (error) {
        console.error(chalk.red(`Error: ${error}`));
    }
}
main();
