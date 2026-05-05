import { ChatOpenAI } from '@langchain/openai';
import "dotenv/config"
import mysql from 'mysql2/promise';
import chalk from 'chalk';
import { z } from 'zod';

const llm = new ChatOpenAI({
    modelName: process.env.MODEL_NAME || 'gpt-3.5-turbo',
    temperature: 0,
    apiKey: process.env.API_KEY,
    configuration: { baseURL: process.env.BASE_URL },
})

const articleSchema = z.object({
    name: z.string().describe("文章名称"),
    author: z.string().describe("作者"),
    description: z.string().describe("文章描述"),
});

const articleArraySchema = z.array(articleSchema).describe("文章数组");

const structuredModel = llm.withStructuredOutput(articleArraySchema);


const connectionConfig = {
    host: 'localhost',
    port: 3306,
    user: 'root',
    password: 'admin',
    multipleStatements: true,
}


async function extractAndInsertArticles(text) {
    const connection = await mysql.createConnection(connectionConfig);
    try {
        // 1.切换到数据库
        await connection.query('USE article;');

        // 2.使用AI提取结构化信息
        console.log(chalk.green('🧠 使用AI提取结构化信息 ...'))
        const prompt = `请从给定的文本中提取出文章的名称、作者和描述，并返回一个JSON数组，每个文章信息包含名称、作者和描述三个字段。请确保提取的信息是准确的，并且JSON数组的格式是正确的。请开始提取：\n\n${text}
        
            要求：
            1. 提取文章的名称、作者和描述。
            2. 返回一个JSON数组，每个文章信息包含名称、作者和描述三个字段。
            3. 确保提取的信息是准确的，并且JSON数组的格式是正确的。
            4. 如果无法提取信息，请返回一个空数组。
            5. 即使只有一条数据，也返回数据
            `
        const result = await structuredModel.invoke(prompt);

        console.log(chalk.green('🚀 提取结果：'), result, chalk.green(result.length + "条数据"))

        if (result.length === 0) {
            console.log(chalk.yellow('⚠️  无法提取信息，请检查输入文本是否包含文章信息。'))
            return;
        }

        const insertSql = `INSERT INTO articles (
            name, 
            author,
            description
        ) VALUES ?;
        `;

        const values = result.map(article => [article.name, article.author, article.description]);

        console.log(chalk.green('🚀 插入数据 ...'))
        const [rows] = await connection.query(insertSql, [values]);
        console.log(chalk.green(`成功批量插入${rows.affectedRows}条数据`))

    } catch (e) {
        console.error(e);
    } finally {
        if (connection) {
            await connection.end();
            console.log('🔒 连接已关闭');
        }
    }
}

async function main() {
    await extractAndInsertArticles("我最近看了几篇文章，每篇文章都给我留下了深刻的印象。第一篇是《如何用Python编写一个简单的Web服务器》，作者是张三，描述是本文将介绍如何使用Python编写一个简单的Web服务器，帮助读者快速上手。第二篇是《深入浅出JavaScript事件循环》，作者是李四，描述是本文将深入浅出地介绍JavaScript事件循环，帮助读者更好地理解JavaScript运行机制。第三篇是《从零开始构建一个React应用》，作者是王五，描述是本文将从零开始构建一个React应用，帮助读者快速上手React开发。");
}

main()