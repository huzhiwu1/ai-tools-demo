import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";
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
 * 【结构化输出之旅 - 第5站】withStructuredOutput（最现代、最推荐）
 * ============================================
 *
 * 核心知识点：为什么这是最推荐的方式？
 *
 * 回顾前面几站的学习路径：
 *   第1站（01-normal）：纯靠 Prompt，手动解析，痛苦不堪
 *   第2站（02-json-parser）：自动提取 JSON，但无法控制格式
 *   第3站（03-names）：自动生成格式指令，但全是字符串
 *   第4站（04-zod）：精确类型控制，但需要手动拼接 Prompt + parse()
 *
 * 这一站（05-withStructuredOutput）：终极简化！
 *   - 不需要手动拼接 getFormatInstructions()
 *   - 不需要手动调用 parser.parse()
 *   - 不需要关心 LLM 返回的是字符串还是 JSON
 *   - 一行代码搞定：model.withStructuredOutput(schema)
 *
 * 它是怎么做到的？
 * ============================================
 */

// ============================================
// 步骤 1：定义 zod schema（和上一节一样）
// ============================================
const schema = z.object({
    name: z.string().describe("博主的姓名"),
    birthday: z.string().describe("博主的生日，格式如 1990-01-01"),
    gender: z.enum(["男", "女"]).describe("博主的性别"),
    article_count: z.number().describe("发布的文章总数"),
    follower_count: z.number().describe("粉丝数量"),
    followee_count: z.number().describe("关注数量"),
    main_articles: z.array(z.string()).describe("主要文章标题列表")
});

// ============================================
// 步骤 2：核心魔法 - withStructuredOutput
// ============================================
// 这一行代码是 LangChain 的"杀手锏"！
//
// model.withStructuredOutput(schema) 返回一个新的"模型包装器"，
// 它的行为和普通 model 完全一样，但内部做了这些额外工作：
//
// 【知识扩展】withStructuredOutput 的底层原理：
//   现代 LLM（如 GPT-4、Claude）支持 "Function Calling"（函数调用）能力。
//   这意味着模型可以直接返回结构化的 JSON 对象，而不是自由文本。
//
//   LangChain 的 withStructuredOutput 就是利用了这个能力：
//     1. 把你的 zod schema 转换成 OpenAI 的 function schema
//     2. 调用模型时，传一个特殊的 "tools" 参数
//     3. 模型被"强制"返回符合 schema 的 JSON
//     4. LangChain 自动解析 JSON 并做 zod 校验
//     5. 最终直接返回解析好的对象
//
//   因为模型层面就被约束了，所以准确率比 Prompt 工程高得多！
//
// 对比之前的方法：
//   之前（04-zod）：Prompt + 期望 + 祈祷 → LLM 返回文本 → 提取 JSON → 校验
//   现在（05）：模型直接返回结构化数据（function calling）→ 校验 → 直接给对象
// ============================================
const structuredModel = model.withStructuredOutput(schema);

async function main() {
    try {
        // ============================================
        // 步骤 3：调用模型（极简！）
        // ============================================
        // 注意：这里没有 getFormatInstructions()！
        // 没有 parser.parse()！
        // 没有 JSON 提取逻辑！
        //
        // 你像调用普通 model 一样传入问题，
        // 但返回的 result 直接就是一个合法的对象！
        // ============================================
        console.log(chalk.yellow("📤 发送给 LLM 的问题（没有任何格式指令）："));
        console.log(chalk.gray('请介绍抖音博主"造船的路飞"的信息'));
        console.log();

        console.log(chalk.blue("⏳ 等待 LLM 回答..."));
        console.log();

        const result = await structuredModel.invoke("请介绍抖音博主\"造船的路飞\"的信息");

        // ============================================
        // 步骤 4：直接使用结果
        // ============================================
        // result 已经是解析好的、类型安全的对象了！
        // 不需要任何额外处理。
        // ============================================
        console.log(chalk.green("📥 LLM 返回的结构化数据（已经是对象，不是字符串）："));
        console.log(result);
        console.log();

        console.log(chalk.magenta("✅ 解析并通过类型校验的数据："));
        console.log(JSON.stringify(result, null, 2));
        console.log();

        // ============================================
        // 步骤 5：类型安全的字段访问
        // ============================================
        console.log(chalk.yellow("🔍 各字段值（100% 类型安全）："));
        console.log(`  姓名: ${result.name}`);
        console.log(`  生日: ${result.birthday}`);
        console.log(`  性别: ${result.gender}`);
        console.log(`  文章数: ${result.article_count} ${chalk.gray(`(类型: ${typeof result.article_count} ✅)`)}`);
        console.log(`  粉丝数: ${result.follower_count} ${chalk.gray(`(类型: ${typeof result.follower_count} ✅)`)}`);
        console.log(`  关注数: ${result.followee_count} ${chalk.gray(`(类型: ${typeof result.followee_count} ✅)`)}`);
        console.log(`  主要文章: ${result.main_articles.join(", ")}`);
        console.log();

        // ============================================
        // 知识扩展：withStructuredOutput 的两种模式
        // ============================================
        // 默认模式（就是你上面用的）：
        //   - 底层使用 function calling
        //   - 返回解析好的对象
        //   - 如果模型不支持 function calling，会自动降级
        //
        // 另一种模式（JSON 模式）：
        //   structuredModel = model.withStructuredOutput(schema, { method: "jsonMode" })
        //   - 不使用 function calling，而是要求模型返回 JSON
        //   - 适合不支持 function calling 的模型
        //   - 准确率略低于 function calling
        // ============================================

        console.log(chalk.gray("💡 withStructuredOutput 的小结"));
        console.log(chalk.gray("   ✅ 优点：代码最简洁，几行搞定"));
        console.log(chalk.gray("   ✅ 优点：底层用 function calling，准确率最高"));
        console.log(chalk.gray("   ✅ 优点：不需要拼接 Prompt，不需要手动 parse"));
        console.log(chalk.gray("   ✅ 优点：自动处理解析和校验"));
        console.log(chalk.gray("   ❌ 缺点：需要模型支持 function calling（GPT-4、GPT-3.5-turbo 支持）"));
        console.log(chalk.gray("   ❌ 缺点：无法控制 Prompt 的细节（LangChain 内部处理）"));
        console.log();
        console.log(chalk.cyan("🎯 推荐：在正式项目中，优先使用 withStructuredOutput！"));
        console.log(chalk.cyan("   如果模型不支持 function calling，再退回到 StructuredOutputParser + zod"));

    } catch (error) {
        console.error(chalk.red("❌ 发生错误："), error.message);
        console.log();
        console.log(chalk.gray("💡 常见原因："));
        console.log(chalk.gray("   1. 模型不支持 function calling（检查 MODEL_NAME）"));
        console.log(chalk.gray("   2. API 代理/中转服务拦截了 function calling 请求"));
        console.log(chalk.gray("   3. 如果上述情况存在，可以改用 jsonMode："));
        console.log(chalk.gray("      model.withStructuredOutput(schema, { method: 'jsonMode' })"));
    }
}

main().catch(e => console.error(chalk.red(`报错：${e}`)));
