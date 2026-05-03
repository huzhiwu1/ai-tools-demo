import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";
import { JsonOutputParser } from "@langchain/core/output_parsers";
import chalk from "chalk";

const model = new ChatOpenAI({
    modelName: process.env.MODEL_NAME || "gpt-3.5-turbo",
    temperature: 0,
    apiKey: process.env.API_KEY,
    configuration: {
        baseURL: process.env.BASE_URL
    }
});

/**
 * ============================================
 * 【结构化输出之旅 - 第2站】JsonOutputParser
 * ============================================
 *
 * 核心知识点：LangChain 的输出解析器（Output Parser）是什么？
 *
 * Output Parser 是 LangChain 提供的专用组件，它的职责是：
 *   1. 在发送请求前，给 LLM 附加"格式化指令"
 *   2. 在收到响应后，自动解析并校验 LLM 的输出
 *
 * 就像快递的"包装+拆包"服务：
 *   - 寄件时：Output Parser 给包裹贴上"请按此格式填写"的标签
 *   - 收件时：Output Parser 自动拆包，把内容整理成程序能用的格式
 *
 * JsonOutputParser 是最基础的 Parser，专门处理 JSON 输出。
 *
 * ⚠️ 重要提示：在 @langchain/core 较新版本中，
 *    JsonOutputParser.getFormatInstructions() 返回空字符串，
 *    这个方法已经失效。但了解它的工作原理仍然有意义。
 * ============================================
 */

// ============================================
// 创建 JsonOutputParser 实例
// ============================================
// JsonOutputParser 的核心能力：
//   1. parse()：自动从 LLM 输出中提取 JSON 并解析
//   2. 能处理 markdown 代码块（自动去掉 ```json）
//   3. 能处理 JSON 前后有废话的情况（尽量提取）
//
// 但它的缺点也很明显：
//   1. getFormatInstructions() 失效（返回空字符串）
//   2. 无法指定具体的字段名和类型
//   3. 没有 Schema 校验能力
// ============================================
const parser = new JsonOutputParser();

async function main() {
    try {
        // ============================================
        // 步骤 1：构造 Prompt
        // ============================================
        // 这里我们仍然手动描述 JSON 格式，因为 getFormatInstructions()
        // 在较新版本中已返回空字符串，无法自动附加格式说明。
        //
        // 【知识扩展】为什么 getFormatInstructions() 会失效？
        // LangChain 在不断演进。JsonOutputParser 最初确实会返回一段
        // 格式化指令，但随着更好的方案出现（如 StructuredOutputParser、
        // withStructuredOutput），旧的方法逐渐被废弃。
        //
        // 这告诉我们一个重要道理：AI 生态发展很快，
        // 今天的方法明天可能就过时了，保持学习很重要！
        // ============================================
        const formatInstructions = parser.getFormatInstructions();

        console.log(chalk.yellow("📋 parser.getFormatInstructions() 的返回值："));
        console.log(chalk.gray(JSON.stringify(formatInstructions)));
        console.log();

        if (!formatInstructions) {
            console.log(chalk.red("⚠️ 警告：getFormatInstructions() 返回了空字符串！"));
            console.log(chalk.red("   JsonOutputParser 的格式化指令功能已失效。"));
            console.log();
        }

        const question = `请介绍抖音博主"造船的路飞"的信息。
要求以 JSON 格式返回，包含以下字段：
- name：姓名（字符串）
- birthday：生日（字符串）
- gender：性别（字符串）
- article_count：文章数量（数字）
- follower_count：粉丝数量（数字）
- followee_count：关注数量（数字）
- main_articles：主要文章标题列表（字符串数组）
${formatInstructions}`;

        console.log(chalk.yellow("📤 发送给 LLM 的完整问题（注意末尾的空指令）："));
        console.log(question);
        console.log();

        // ============================================
        // 步骤 2：调用 LLM
        // ============================================
        console.log(chalk.blue("⏳ 等待 LLM 回答..."));
        console.log();

        const res = await model.invoke(question);

        // ============================================
        // 步骤 3：查看原始输出
        // ============================================
        console.log(chalk.green("📥 LLM 原始回答："));
        console.log(res.content);
        console.log();

        // ============================================
        // 步骤 4：用 JsonOutputParser 自动解析
        // ============================================
        // 这是 JsonOutputParser 的核心价值所在！
        // 你不需要再手写正则提取 JSON，直接调用 parser.parse() 即可。
        //
        // 【知识扩展】parser.parse() 内部做了什么？
        //   1. 在文本中查找 JSON 对象（支持嵌套在大段文字中）
        //   2. 去掉 markdown 代码块标记 ```json ... ```
        //   3. 用 JSON.parse() 解析
        //   4. 如果失败，会抛出 OutputParserException
        //
        // 但注意：它只管"提取并解析 JSON"，不管"JSON 里的字段对不对"。
        // 如果 LLM 返回的 JSON 缺少字段或类型不对，parser.parse() 不会报错，
        // 这些问题要等到你使用数据时才会暴露。
        // ============================================
        console.log(chalk.cyan("🔧 使用 JsonOutputParser.parse() 自动解析..."));

        const jsonResult = await parser.parse(res.content);

        console.log(chalk.magenta("✅ Parser 解析后的数据："));
        console.log(jsonResult);
        console.log();

        // ============================================
        // 步骤 5：访问字段（仍然没有类型保证）
        // ============================================
        console.log(chalk.yellow("🔍 各字段值："));
        console.log(`  姓名: ${jsonResult.name}`);
        console.log(`  文章数: ${jsonResult.article_count} ${chalk.gray(`(类型: ${typeof jsonResult.article_count})`)}`);
        console.log(`  粉丝数: ${jsonResult.follower_count} ${chalk.gray(`(类型: ${typeof jsonResult.follower_count})`)}`);
        console.log();

        // ============================================
        // 总结
        // ============================================
        console.log(chalk.gray("💡 JsonOutputParser 的小结"));
        console.log(chalk.gray("   ✅ 优点：自动提取 JSON，省掉手写正则"));
        console.log(chalk.gray("   ❌ 缺点1：getFormatInstructions() 已失效"));
        console.log(chalk.gray("   ❌ 缺点2：无法声明字段类型，没有 Schema 校验"));
        console.log(chalk.gray("   → 继续看 03-structured-output-parser.mjs 学习更强大的方法！"));

    } catch (error) {
        console.error(chalk.red("❌ 发生错误："), error.message);
        console.log();
        console.log(chalk.gray("💡 提示：如果解析失败，说明 LLM 没有返回合法 JSON。"));
        console.log(chalk.gray("   这正是 JsonOutputParser 的局限性——它无法强制 LLM 的格式。"));
    }
}

main().catch(e => console.error(chalk.red(`报错：${e}`)));
