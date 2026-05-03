import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";
import { StructuredOutputParser } from "@langchain/core/output_parsers";
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
 * 【结构化输出之旅 - 第3站】StructuredOutputParser（简单版）
 * ============================================
 *
 * 核心知识点：StructuredOutputParser 是什么？
 *
 * 如果说 JsonOutputParser 是"自动提取 JSON 的工具"，
 * 那 StructuredOutputParser 就是"能生成格式化指令 + 自动解析"的完整方案。
 *
 * 它的工作流程：
 *   1. 你告诉它："我想要这些字段，每个字段是干什么的"
 *   2. 它自动生成一段详细的格式化指令（自然语言 + JSON Schema）
 *   3. 你把这段指令拼接到 Prompt 里发给 LLM
 *   4. LLM 收到后，知道必须按指定格式返回
 *   5. LLM 返回后，Parser 自动解析成对象
 *
 * 这一节展示最简单的方式：fromNamesAndDescriptions()
 * 你只需要提供"字段名"和"描述"，不需要写复杂的 Schema。
 * ============================================
 */

// ============================================
// 步骤 1：用 fromNamesAndDescriptions 定义输出结构
// ============================================
// 这种方式的优点：超级简单，几行代码搞定！
// 只需要一个对象，键是字段名，值是字段描述。
//
// 但缺点也很明显：
//   1. 所有字段默认都是字符串类型（无法指定 number、array 等）
//   2. 无法进行严格的类型校验
//   3. 适合简单场景，复杂数据结构不够用
//
// 【知识扩展】为什么默认都是字符串？
// fromNamesAndDescriptions 的设计初衷是"快速原型"，
// 它用最简单的接口让你马上看到效果。
// 但如果你需要 number、boolean、数组等精确类型控制，
// 就需要升级到 zod schema 版本（见下一节）。
// ============================================
const parser = StructuredOutputParser.fromNamesAndDescriptions({
    name: "博主的姓名",
    birthday: "博主的生日，格式如 1990-01-01",
    gender: "博主的性别，如 男 或 女",
    article_count: "发布的文章总数",
    follower_count: "粉丝数量",
    followee_count: "关注数量",
    main_articles: "主要文章标题列表，用逗号分隔的字符串"
});

async function main() {
    try {
        // ============================================
        // 步骤 2：获取自动生成的格式化指令
        // ============================================
        // 这是 StructuredOutputParser 的核心魔法！
        // getFormatInstructions() 会返回一段很长的文本，包含：
        //   - "你必须按 JSON 格式输出..."
        //   - 每个字段的说明
        //   - JSON 格式示例
        //
        // 看看它返回了什么，你会惊叹 LangChain 的 Prompt Engineering！
        // ============================================
        const formatInstructions = parser.getFormatInstructions();

        console.log(chalk.yellow("📋 parser.getFormatInstructions() 自动生成的格式化指令："));
        console.log(chalk.gray(formatInstructions));
        console.log();

        // ============================================
        // 步骤 3：构造 Prompt，把格式化指令拼进去
        // ============================================
        // 注意：这里 Prompt 非常简洁！
        // 因为具体的格式要求（字段名、类型、示例）都已经包含在
        // formatInstructions 里了，不需要在 Prompt 里重复写。
        // ============================================
        const question = `请介绍抖音博主"造船的路飞"的信息。\n\n${formatInstructions}`;

        console.log(chalk.yellow("📤 发送给 LLM 的完整问题："));
        console.log(question);
        console.log();

        // ============================================
        // 步骤 4：调用 LLM
        // ============================================
        console.log(chalk.blue("⏳ 等待 LLM 回答..."));
        console.log();

        const res = await model.invoke(question);

        console.log(chalk.green("📥 LLM 原始回答："));
        console.log(res.content);
        console.log();

        // ============================================
        // 步骤 5：用 Parser 自动解析
        // ============================================
        // 和 JsonOutputParser 一样，直接调用 parse() 即可。
        // 但因为这次 Prompt 里有详细的格式指令，LLM 更容易返回正确格式。
        // ============================================
        console.log(chalk.cyan("🔧 使用 StructuredOutputParser.parse() 自动解析..."));

        const result = await parser.parse(res.content);

        console.log(chalk.magenta("✅ Parser 解析后的数据："));
        console.log(result);
        console.log();

        // ============================================
        // 步骤 6：使用数据
        // ============================================
        // ⚠️ 注意：fromNamesAndDescriptions 方式下，所有字段都是字符串！
        // 即使你希望 article_count 是数字，LLM 也可能返回 "15"（字符串）。
        // 如果你需要严格的类型控制，请使用 zod schema 版本。
        // ============================================
        console.log(chalk.yellow("🔍 各字段值及类型："));
        console.log(`  姓名: ${result.name}`);
        console.log(`  生日: ${result.birthday}`);
        console.log(`  性别: ${result.gender}`);
        console.log(`  文章数: ${result.article_count} ${chalk.gray(`(类型: ${typeof result.article_count})`)}`);
        console.log(`  粉丝数: ${result.follower_count} ${chalk.gray(`(类型: ${typeof result.follower_count})`)}`);
        console.log(`  关注数: ${result.followee_count} ${chalk.gray(`(类型: ${typeof result.followee_count})`)}`);
        console.log(`  主要文章: ${result.main_articles}`);
        console.log();

        console.log(chalk.gray("💡 fromNamesAndDescriptions 的小结"));
        console.log(chalk.gray("   ✅ 优点：极简代码，快速上手"));
        console.log(chalk.gray("   ✅ 优点：自动生成格式指令，Prompt 更干净"));
        console.log(chalk.gray("   ❌ 缺点：无法指定字段类型（全是字符串）"));
        console.log(chalk.gray("   ❌ 缺点：无法进行严格的 Schema 校验"));
        console.log(chalk.gray("   → 继续看 04-structured-output-parser-zod.mjs 学习带类型的方案！"));

    } catch (error) {
        console.error(chalk.red("❌ 发生错误："), error.message);
    }
}

main().catch(e => console.error(chalk.red(`报错：${e}`)));
