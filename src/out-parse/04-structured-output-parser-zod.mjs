import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";
import { StructuredOutputParser } from "@langchain/core/output_parsers";
import { z } from "zod";
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
 * 【结构化输出之旅 - 第4站】StructuredOutputParser + zod（推荐）
 * ============================================
 *
 * 核心知识点：zod 是什么？为什么用它？
 *
 * zod 是一个 TypeScript 优先的 Schema 声明和校验库。
 * 你可以把它理解为"数据形状的说明书"。
 *
 * 打个比方：
 *   - 没有 zod：你告诉 LLM "给我一个人的信息"，
 *     它可能返回任何东西，你得自己猜里面有什么字段
 *   - 有 zod：你画了一张"蓝图"，上面精确标注了
 *     "name 是字符串、age 是数字、hobbies 是字符串数组"，
 *     LLM 按图施工，zod 最后验收
 *
 * 为什么 zod 特别适合 AI 应用？
 *   1. 声明式：用代码描述数据形状，而不是写文档
 *   2. 类型安全：TypeScript 能自动推断类型，IDE 有代码提示
 *   3. 运行时校验：数据进来后自动检查是否符合预期
 *   4. 描述能力：.describe() 会被 LangChain 提取到 Prompt 中
 * ============================================
 */

// ============================================
// 步骤 1：用 zod 定义精确的输出结构
// ============================================
// 这里的每个 .string()、.number()、.array() 都是类型声明。
// LLM 看到生成的格式化指令后，会尽量按这些类型返回数据。
//
// 【知识扩展】zod 常用类型速查：
//   z.string()      → 字符串
//   z.number()      → 数字
//   z.boolean()     → 布尔值
//   z.array(X)      → X 类型的数组
//   z.object({...}) → 对象
//   z.optional()    → 可选字段（可以不存在）
//   z.enum(["a","b"]) → 枚举值（只能是列出的选项之一）
//   .describe("...") → 字段说明（会被 LangChain 用到 Prompt 中）
// ============================================
const schema = z.object({
    name: z.string().describe("博主的姓名"),
    birthday: z.string().describe("博主的生日，格式如 1990-01-01"),
    gender: z.enum(["男", "女"]).describe("博主的性别，只能是 男 或 女"),
    article_count: z.number().describe("发布的文章总数，必须是数字"),
    follower_count: z.number().describe("粉丝数量，必须是数字"),
    followee_count: z.number().describe("关注数量，必须是数字"),
    main_articles: z.array(z.string()).describe("主要文章标题列表，字符串数组")
});

// ============================================
// 步骤 2：创建 Parser（从 zod schema 生成）
// ============================================
// fromZodSchema 是 StructuredOutputParser 最强大的构造函数。
// 它会读取 zod schema 的完整信息（类型、描述、约束），
// 生成一段非常详细的 JSON Schema 格式化指令。
//
// 与 fromNamesAndDescriptions 的区别：
//   - fromNamesAndDescriptions：只知道"字段名+描述"，默认全字符串
//   - fromZodSchema：知道"字段名+类型+描述+约束"，精确控制每个字段
// ============================================
const parser = StructuredOutputParser.fromZodSchema(schema);

async function main() {
    try {
        // ============================================
        // 步骤 3：查看自动生成的格式化指令
        // ============================================
        // 注意看输出中的 JSON Schema，它包含了每个字段的 type、description！
        // 这是 fromZodSchema 相比 fromNamesAndDescriptions 的核心优势。
        // ============================================
        const formatInstructions = parser.getFormatInstructions();

        console.log(chalk.yellow("📋 parser.getFormatInstructions() 生成的指令（节选）："));
        // 指令通常很长，只显示前 800 字符
        console.log(chalk.gray(formatInstructions.slice(0, 800) + "\n... (截断，完整内容非常长)"));
        console.log();

        // ============================================
        // 步骤 4：构造 Prompt
        // ============================================
        const question = `请介绍抖音博主"造船的路飞"的信息。\n\n${formatInstructions}`;

        console.log(chalk.yellow("📤 发送给 LLM 的问题（格式化指令已自动附加）："));
        console.log(chalk.gray(question.slice(0, 500) + "\n... (截断)"));
        console.log();

        // ============================================
        // 步骤 5：调用 LLM
        // ============================================
        console.log(chalk.blue("⏳ 等待 LLM 回答..."));
        console.log();

        const res = await model.invoke(question);

        console.log(chalk.green("📥 LLM 原始回答："));
        console.log(res.content);
        console.log();

        // ============================================
        // 步骤 6：解析并校验
        // ============================================
        // parser.parse() 不仅会提取 JSON，还会用 zod schema 做校验：
        //   - 字段类型是否正确？（number 不能是字符串）
        //   - 必填字段是否都存在？
        //   - 枚举值是否在允许范围内？
        //
        // 如果校验失败，parse() 会抛出 ZodError，告诉你哪里不对。
        // 这比 fromNamesAndDescriptions 强大得多！
        // ============================================
        console.log(chalk.cyan("🔧 使用 StructuredOutputParser + zod 解析并校验..."));

        const result = await parser.parse(res.content);

        console.log(chalk.magenta("✅ 解析并通过类型校验的数据："));
        console.log(result);
        console.log();

        // ============================================
        // 步骤 7：使用数据（现在有类型保证了！）
        // ============================================
        // article_count 一定是 number，可以直接做数学运算！
        // main_articles 一定是 string[]，可以直接调用数组方法！
        // ============================================
        console.log(chalk.yellow("🔍 各字段值（类型已保证正确）："));
        console.log(`  姓名: ${result.name}`);
        console.log(`  生日: ${result.birthday}`);
        console.log(`  性别: ${result.gender}`);
        console.log(`  文章数: ${result.article_count} ${chalk.gray(`(类型: ${typeof result.article_count} ✅)`)}`);
        console.log(`  粉丝数: ${result.follower_count} ${chalk.gray(`(类型: ${typeof result.follower_count} ✅)`)}`);
        console.log(`  关注数: ${result.followee_count} ${chalk.gray(`(类型: ${typeof result.followee_count} ✅)`)}`);
        console.log(`  主要文章: ${result.main_articles.join(", ")} ${chalk.gray(`(数组长度: ${result.main_articles.length})`)}`);
        console.log();

        // 类型安全的计算示例
        const totalEngagement = result.follower_count + result.followee_count + result.article_count;
        console.log(chalk.cyan(`📊 互动总量计算：${result.follower_count} + ${result.followee_count} + ${result.article_count} = ${totalEngagement}`));
        console.log(chalk.gray("   注意：因为类型已保证是 number，所以可以直接相加，不需要 parseInt！"));
        console.log();

        console.log(chalk.gray("💡 StructuredOutputParser + zod 的小结"));
        console.log(chalk.gray("   ✅ 优点：精确的类型控制（string、number、array、enum 等）"));
        console.log(chalk.gray("   ✅ 优点：运行时自动校验，字段不对立即报错"));
        console.log(chalk.gray("   ✅ 优点：TypeScript 类型推断，IDE 自动补全"));
        console.log(chalk.gray("   ✅ 优点：.describe() 自动生成字段说明"));
        console.log(chalk.gray("   ❌ 缺点：需要引入 zod 库，学习成本略高"));
        console.log(chalk.gray("   → 继续看 05-with-structured-output.mjs 学习最现代的方式！"));

    } catch (error) {
        console.error(chalk.red("❌ 发生错误："), error.message);
        console.log();
        console.log(chalk.gray("💡 提示：如果报错是 ZodError，说明 LLM 返回的数据不符合 schema。"));
        console.log(chalk.gray("   比如 number 字段返回了字符串，或缺少必填字段。"));
        console.log(chalk.gray("   这恰好说明 zod 校验在工作！没有校验的话，这类错误会在更隐蔽的地方爆发。"));
    }
}

main().catch(e => console.error(chalk.red(`报错：${e}`)));
