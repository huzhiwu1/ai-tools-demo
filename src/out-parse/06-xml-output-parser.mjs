import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";
import { XMLOutputParser } from "@langchain/core/output_parsers";
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
 * 【结构化输出之旅 - 第6站】XMLOutputParser
 * ============================================
 *
 * 核心知识点：除了 JSON，还能用什么格式？
 *
 * 前面的章节都在讲 JSON 格式的结构化输出，
 * 但 JSON 并不是唯一的选择。
 *
 * XML（可扩展标记语言）是另一种结构化数据格式，
 * 它用"标签"来组织数据，比如：
 *
 *   <person>
 *     <name>张三</name>
 *     <age>25</age>
 *   </person>
 *
 * 什么时候用 XML 而不是 JSON？
 *   1. 数据有嵌套层级关系时，XML 的可读性更好
 *   2. 需要给元素添加"属性"时（如 <book id="123">）
 *   3. 需要混合文本和结构化数据时
 *   4. 某些传统系统（如企业级 Java 系统）更习惯 XML
 *
 * 但总体来说，JSON 更轻量、更流行，除非有特殊需求，否则优先用 JSON。
 * 这一节主要是让你了解 LangChain 支持多种输出格式。
 * ============================================
 */

// ============================================
// 创建 XMLOutputParser 实例
// ============================================
// XMLOutputParser 的工作方式和 StructuredOutputParser 类似：
//   1. getFormatInstructions() 生成 XML 格式的指令
//   2. 把指令拼接到 Prompt 中
//   3. LLM 返回 XML 格式数据
//   4. parser.parse() 自动解析为 JavaScript 对象
//
// 解析后的数据格式比较特殊：
//   XML: <person><name>张三</name><age>25</age></person>
//   解析后: { person: { name: ["张三"], age: ["25"] } }
//
// 注意：所有文本内容都会被包装成数组，这是 XML 解析的特点
// （因为 XML 允许同一个标签出现多次）。
// ============================================
const parser = new XMLOutputParser();

async function main() {
    try {
        // ============================================
        // 步骤 1：获取 XML 格式化指令
        // ============================================
        const formatInstructions = parser.getFormatInstructions();

        console.log(chalk.yellow("📋 parser.getFormatInstructions() 生成的 XML 指令："));
        console.log(chalk.gray(formatInstructions));
        console.log();

        // ============================================
        // 步骤 2：构造 Prompt
        // ============================================
        // 注意：这里我们要求 LLM 返回 XML 格式，而不是 JSON。
        // Prompt 里需要明确告诉 LLM 想要什么标签结构。
        // ============================================
        const question = `请介绍抖音博主"造船的路飞"的信息。
要求用 XML 格式返回，包含以下标签：
- <name>：姓名
- <birthday>：生日
- <gender>：性别
- <article_count>：文章数量
- <follower_count>：粉丝数量
- <followee_count>：关注数量
- <main_articles>：包含多个 <article> 子标签

${formatInstructions}`;

        console.log(chalk.yellow("📤 发送给 LLM 的问题："));
        console.log(chalk.gray(question));
        console.log();

        // ============================================
        // 步骤 3：调用 LLM
        // ============================================
        console.log(chalk.blue("⏳ 等待 LLM 回答..."));
        console.log();

        const res = await model.invoke(question);

        console.log(chalk.green("📥 LLM 原始回答（XML 格式）："));
        console.log(res.content);
        console.log();

        // ============================================
        // 步骤 4：用 XMLOutputParser 解析
        // ============================================
        // parser.parse() 会把 XML 字符串转换为 JS 对象。
        //
        // 【知识扩展】XML vs JSON 解析结果对比：
        //
        // XML 输入：
        //   <person>
        //     <name>张三</name>
        //     <age>25</age>
        //     <hobbies><hobby>游泳</hobby><hobby>编程</hobby></hobbies>
        //   </person>
        //
        // 解析后：
        //   { person: {
        //       name: ["张三"],
        //       age: ["25"],
        //       hobbies: { hobby: ["游泳", "编程"] }
        //   }}
        //
        // 注意所有文本都在数组里！访问时要取 [0]。
        // ============================================
        console.log(chalk.cyan("🔧 使用 XMLOutputParser.parse() 解析 XML..."));

        const result = await parser.parse(res.content);

        console.log(chalk.magenta("✅ 解析后的 JavaScript 对象："));
        console.log(result);
        console.log();

        // ============================================
        // 步骤 5：访问数据
        // ============================================
        // ⚠️ 注意：XMLOutputParser 解析后，文本内容都在数组里！
        // 比如 <name>张三</name> 解析后是 { name: ["张三"] }
        // 所以访问时要写 result.name[0]，而不是 result.name
        // ============================================
        console.log(chalk.yellow("🔍 访问 XML 解析后的数据："));

        // XML 的根标签可能不同，取决于 LLM 的输出
        // 可能是 <result>、<person>、<blogger> 等
        const rootKey = Object.keys(result)[0];
        const data = result[rootKey];

        console.log(`  根标签: ${rootKey}`);
        console.log(`  原始数据结构: ${JSON.stringify(data)}`);
        console.log();

        // 安全地访问字段（考虑到数组包装）
        const getValue = (obj, key) => {
            if (!obj || !obj[key]) return "未找到";
            return Array.isArray(obj[key]) ? obj[key][0] : obj[key];
        };

        console.log(`  姓名: ${getValue(data, "name")}`);
        console.log(`  生日: ${getValue(data, "birthday")}`);
        console.log(`  性别: ${getValue(data, "gender")}`);
        console.log(`  文章数: ${getValue(data, "article_count")}`);
        console.log(`  粉丝数: ${getValue(data, "follower_count")}`);
        console.log(`  关注数: ${getValue(data, "followee_count")}`);
        console.log();

        console.log(chalk.gray("💡 XMLOutputParser 的小结"));
        console.log(chalk.gray("   ✅ 优点：支持 XML 格式的结构化输出"));
        console.log(chalk.gray("   ✅ 优点：适合需要层级结构和属性的场景"));
        console.log(chalk.gray("   ❌ 缺点：解析后的数据有数组包装，访问麻烦"));
        console.log(chalk.gray("   ❌ 缺点：XML 比 JSON 冗长，LLM 输出 token 更多"));
        console.log(chalk.gray("   ❌ 缺点：不如 JSON 流行，生态系统支持较少"));
        console.log();
        console.log(chalk.cyan("🎯 推荐：除非有明确的 XML 需求，否则优先使用 JSON 格式！"));
        console.log(chalk.cyan("   即：优先使用 withStructuredOutput 或 StructuredOutputParser + zod"));

    } catch (error) {
        console.error(chalk.red("❌ 发生错误："), error.message);
    }
}

main().catch(e => console.error(chalk.red(`报错：${e}`)));
