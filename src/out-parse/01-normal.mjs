import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";
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
 * 【结构化输出之旅 - 第1站】最原始的方式：纯靠 Prompt
 * ============================================
 *
 * 核心问题：为什么我们需要"结构化输出"？
 *
 * 大语言模型（LLM）本质上是一个"文本生成器"，它最擅长生成
 * 自然语言。但程序处理数据需要明确的格式（如 JSON、XML）。
 *
 * 想象你让 LLM 介绍一个人，它可能回复一大段话：
 *   "张三是一位著名的科学家，他出生于1990年..."
 *
 * 这段文字人类能读懂，但程序很难提取"出生年份"这个字段。
 *
 * 结构化输出 = 让 LLM 按照程序能理解的格式返回数据
 *              而不是自由发挥写一段文字。
 *
 * 这一节展示最原始的方法：直接在 Prompt 里写"请用 JSON 格式返回"。
 * 看看它有什么问题，后续章节再介绍更好的解决方案。
 * ============================================
 */

async function main() {
    try {
        // ============================================
        // 步骤 1：构造 Prompt，要求 JSON 格式
        // ============================================
        // 小白注意：Prompt 就是你给 LLM 的"问题"或"指令"。
        //
        // 这里我们明确告诉 LLM 想要什么字段、什么格式。
        // 但 LLM 不一定会"乖乖听话"！它可能：
        //   1. 在 JSON 外面包一层 markdown 代码块 ```json ... ```
        //   2. 先写一段解释文字，再给出 JSON
        //   3. 字段名写错（比如把 name 写成 姓名）
        //   4. JSON 格式不完整（少个括号、逗号）
        //
        // 这些都会导致程序解析失败！
        // ============================================
        const question = `请介绍抖音博主"造船的路飞"的信息。
要求以 JSON 格式返回，包含以下字段：
- name：姓名（字符串）
- birthday：生日（字符串）
- gender：性别（字符串）
- article_count：文章数量（数字）
- follower_count：粉丝数量（数字）
- followee_count：关注数量（数字）
- main_articles：主要文章标题列表（字符串数组）`;

        console.log(chalk.yellow("📤 发送给 LLM 的问题："));
        console.log(question);
        console.log();

        // ============================================
        // 步骤 2：调用 LLM
        // ============================================
        // model.invoke() 是 LangChain 中调用大模型的标准方法。
        // 它会发送 Prompt，等待 LLM 返回完整的回答。
        // ============================================
        console.log(chalk.blue("⏳ 等待 LLM 回答..."));
        console.log();

        const res = await model.invoke(question);

        // ============================================
        // 步骤 3：查看 LLM 的原始输出
        // ============================================
        // 小白注意：仔细观察 LLM 返回的是什么格式？
        // 是干净的 JSON 吗？还是被 markdown 代码块包裹的？
        // 前面有没有废话？
        // ============================================
        console.log(chalk.green("📥 LLM 原始回答："));
        console.log(res.content);
        console.log();

        // ============================================
        // 步骤 4：手动解析 JSON（痛苦的开始）
        // ============================================
        // 这是最痛苦的一步！因为 LLM 的输出格式不确定，
        // 你可能需要写一堆正则表达式来提取 JSON：
        //   - 去掉 ```json 和 ```
        //   - 去掉前面的解释文字
        //   - 修复格式错误
        //
        // 【知识扩展】为什么 LLM 会输出 markdown 代码块？
        // 因为 LLM 在训练时看了大量 GitHub、技术文档，
        // 它"学会"了在回答代码/JSON 时自动加上 ``` 标记。
        // 这本来是好事（人类阅读方便），但对程序解析来说是灾难。
        // ============================================
        let content = res.content;

        // 尝试去掉 markdown 代码块标记（最常见的情况）
        // 正则解释：匹配 ```json 或 ``` 开头，捕获中间内容，匹配 ``` 结尾
        const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (codeBlockMatch) {
            content = codeBlockMatch[1].trim();
            console.log(chalk.cyan("🧹 检测到 markdown 代码块，已提取内部 JSON"));
        } else {
            console.log(chalk.cyan("ℹ️ 没有检测到 markdown 代码块"));
        }

        // 尝试解析 JSON
        let jsonResult;
        try {
            jsonResult = JSON.parse(content);
        } catch (parseError) {
            console.log(chalk.red("❌ JSON 解析失败！LLM 没有返回合法 JSON"));
            console.log(chalk.red("   错误信息：" + parseError.message));
            console.log();
            console.log(chalk.gray("💡 这就是纯靠 Prompt 的问题：LLM 的输出不可预测，"));
            console.log(chalk.gray("   程序解析起来非常困难。继续看后面的章节学习更好的方法！"));
            return;
        }

        // ============================================
        // 步骤 5：使用解析后的数据
        // ============================================
        // 即使 JSON 解析成功了，字段类型也不一定对！
        // 比如 article_count 本应是数字，但 LLM 可能返回字符串 "15"
        // 这就需要额外的类型转换和校验...
        // ============================================
        console.log(chalk.magenta("✅ 手动解析后的数据："));
        console.log(jsonResult);
        console.log();

        console.log(chalk.yellow("🔍 各字段值及类型检查："));
        console.log(`  姓名: ${jsonResult.name}`);
        console.log(`  生日: ${jsonResult.birthday}`);
        console.log(`  性别: ${jsonResult.gender}`);
        console.log(`  文章数: ${jsonResult.article_count} ${chalk.gray(`(实际类型: ${typeof jsonResult.article_count})`)}`);
        console.log(`  粉丝数: ${jsonResult.follower_count} ${chalk.gray(`(实际类型: ${typeof jsonResult.follower_count})`)}`);
        console.log(`  关注数: ${jsonResult.followee_count} ${chalk.gray(`(实际类型: ${typeof jsonResult.followee_count})`)}`);
        console.log(`  主要文章: ${Array.isArray(jsonResult.main_articles) ? jsonResult.main_articles.join(", ") : jsonResult.main_articles}`);
        console.log();

        console.log(chalk.gray("💡 小结：纯靠 Prompt 的问题"));
        console.log(chalk.gray("   1. 输出格式不确定（可能有 markdown、废话）"));
        console.log(chalk.gray("   2. 字段类型不保证（数字可能变字符串）"));
        console.log(chalk.gray("   3. 需要手写大量解析逻辑，容易出错"));
        console.log(chalk.gray("   → 继续看 02-json-output-parser.mjs 学习更好的方法！"));

    } catch (error) {
        console.error(chalk.red("❌ 发生错误："), error);
    }
}

main().catch(e => console.error(chalk.red(`报错：${e}`)));
