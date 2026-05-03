import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";
import { JsonOutputParser, StructuredOutputParser } from "@langchain/core/output_parsers";
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

const jayChouSchema = z.object({
    name: z.string().describe("姓名"),
    birthday: z.string().describe("生日"),
    gender: z.string().describe("性别"),
    famous_songs: z.array(z.string()).describe("热门歌曲列表"),
    album_count: z.number().describe("专辑数量")
});

function getQuestion(formatInstructions) {
    return `请介绍周杰伦的信息，以 JSON 格式返回，包含：
name（姓名）、birthday（生日）、gender（性别）、
famous_songs（热门歌曲，数组）、album_count（专辑数量，数字）。
${formatInstructions}`;
}

function printHeader(title) {
    console.log(chalk.yellow("\n═══════════════════════════════════════════"));
    console.log(chalk.yellow(`  ${title}`));
    console.log(chalk.yellow("═══════════════════════════════════════════\n"));
}

/**
 * ============================================
 * 【结构化输出之旅 - 第7站】流式结构化输出
 * ============================================
 *
 * 核心问题：流式输出 和 结构化输出 能同时使用吗？
 *
 * 先回顾两个概念：
 *   - 流式输出（Streaming）：LLM 不一次性返回完整回答，
 *     而是像打字一样，一个字一个字地传给你。用户感知更快。
 *   - 结构化输出（Structured）：LLM 按 JSON/XML 等固定格式返回，
 *     程序需要等完整数据到达后才能解析。
 *
 * 矛盾点：
 *   流式 = 边生成边传（快，但要"拼图"）
 *   结构化 = 要等完整 JSON（慢，但要"验收"）
 *
 * 这一站学习三种解决方案，从简单到高级。
 * ============================================
 */

// ============================================
// 方式一：先流式显示，完整后再解析（最实用）
// ============================================
// 思路：
//   1. 用 stream() 逐块接收 LLM 的输出
//   2. 实时显示给用户看（打字机效果）
//   3. 同时把所有块拼成完整字符串
//   4. 流结束后，用 parser.parse() 解析完整 JSON
//
// 适用场景：
//   - 聊天机器人：先让用户看到 AI 在"打字"，回复完后再提取结构化数据
//   - 数据录入：AI 边思考边显示，最后把结果存入数据库
// ============================================
async function streamThenParse() {
    printHeader("方式一：先流式显示，完整后再解析");

    const parser = new JsonOutputParser();

    const question = getQuestion(parser.getFormatInstructions());

    console.log(chalk.gray("📤 发送问题..."));

    // stream() 返回一个异步迭代器（AsyncIterator）
    // 每次迭代 yield 一个数据块（chunk），包含部分内容
    const stream = await model.stream(question);

    let fullContent = "";
    let chunkCount = 0;

    console.log(chalk.blue("\n🌊 开始流式接收（实时显示）："));
    console.log(chalk.gray("─".repeat(50)));

    // for await...of 是遍历异步迭代器的标准写法
    // 每次循环拿到一个新的文本片段，就像看直播打字
    for await (const chunk of stream) {
        chunkCount++;
        const text = chunk.content;
        fullContent += text;

        // process.stdout.write 不换行，实现"打字机"效果
        process.stdout.write(text);
    }

    console.log(); // 换行
    console.log(chalk.gray("─".repeat(50)));
    console.log(chalk.green(`✅ 流式接收完毕！共收到 ${chunkCount} 个数据块`));
    console.log(chalk.gray(`📝 拼接后的完整内容长度：${fullContent.length} 字符\n`));

    // 流结束后，现在有了完整内容，可以解析了！
    console.log(chalk.cyan("🔧 现在用 parser.parse() 解析完整 JSON...\n"));

    try {
        const result = await parser.parse(fullContent);

        console.log(chalk.magenta("✅ 解析结果："));
        console.log(result);
        console.log();
        console.log(chalk.yellow("🔍 字段访问："));
        console.log(`  姓名: ${result.name}`);
        console.log(`  生日: ${result.birthday}`);
        console.log(`  专辑数: ${result.album_count} (类型: ${typeof result.album_count})`);
        console.log(`  热门歌曲: ${Array.isArray(result.famous_songs) ? result.famous_songs.join(", ") : result.famous_songs}`);
    } catch (error) {
        console.error(chalk.red("❌ 解析失败："), error.message);
    }
}

// ============================================
// 方式二：增量解析（边收边尝试解析）
// ============================================
// 思路：
//   每收到一个新块，就尝试解析一次当前的"不完整 JSON"。
//   如果已经能解析出一部分字段，就实时显示出来。
//
// 关键技术：parser.parsePartialResult()
//   这是 LangChain 提供的特殊方法，可以容忍不完整的 JSON，
//   返回目前已解析出的部分字段。
//
// 适用场景：
//   - 实时预览：用户想提前看到已解析出的数据
//   - 大 JSON：数据量很大，想边收边处理
//
// ⚠️ 注意：
//   增量解析不一定每次都能成功（特别是 JSON 还没闭合时），
//   失败时不要报错，继续等待下一块即可。
// ============================================
async function incrementalParse() {
    printHeader("方式二：增量解析（边收边尝试解析）");

    const parser = new JsonOutputParser();

    const question = getQuestion(parser.getFormatInstructions());

    const stream = await model.stream(question);

    let fullContent = "";
    let chunkCount = 0;
    let lastParsed = null;

    console.log(chalk.blue("🌊 流式接收 + 增量解析：\n"));

    for await (const chunk of stream) {
        chunkCount++;
        const text = chunk.content;
        fullContent += text;

        // 尝试增量解析
        // parsePartialResult 不会抛出异常，解析失败时返回 null
        const partial = await parser.parsePartialResult(fullContent);

        if (partial && JSON.stringify(partial) !== JSON.stringify(lastParsed)) {
            // 发现新的解析结果！实时显示
            console.log(chalk.cyan(`\n[块 ${chunkCount}] 新增解析内容：`));
            console.log(chalk.gray(JSON.stringify(partial, null, 2)));
            lastParsed = partial;
        }
    }

    console.log(chalk.green(`\n✅ 流结束！共 ${chunkCount} 个块`));

    // 最后再完整解析一次，确保拿到最终正确结果
    console.log(chalk.cyan("\n🔧 最终完整解析："));
    const finalResult = await parser.parse(fullContent);
    console.log(chalk.magenta(JSON.stringify(finalResult, null, 2)));
}

// ============================================
// 方式三：withStructuredOutput 的流式玩法
// ============================================
// 思路：
//   withStructuredOutput 本身返回的是完整对象，不支持流式。
//   但我们可以通过"自定义回调"来实现类似效果：
//   - 底层用普通 stream() 获取文本流
//   - 在回调中实时处理每个 chunk
//   - 最后用 parser 解析
//
// 另一种更现代的方案（LangChain 新特性）：
//   某些模型支持 "structured streaming"，
//   但目前主流方案仍是"文本流 + 后解析"。
// ============================================
async function structuredWithCallback() {
    printHeader("方式三：withStructuredOutput + 自定义处理");

    // 注意：withStructuredOutput 本身不支持 stream()
    // 但我们可以在 Prompt 层面做文章
    const parser = StructuredOutputParser.fromZodSchema(jayChouSchema);
    const formatInstructions = parser.getFormatInstructions();

    const question = `请介绍周杰伦的信息。\n\n${formatInstructions}`;

    const stream = await model.stream(question);

    let fullContent = "";
    let chunkCount = 0;

    console.log(chalk.blue("🌊 流式接收中...\n"));

    for await (const chunk of stream) {
        const text = chunk.content;
        fullContent += text;
        chunkCount++;

        // 每收到 5 个块就打个点，给用户感知进度
        if (chunkCount % 5 === 0) {
            process.stdout.write(chalk.gray("."));
        }
    }

    console.log(chalk.green(" 完成！\n"));

    // 用 zod schema 解析并校验
    const result = await parser.parse(fullContent);

    console.log(chalk.magenta("✅ 结构化结果（带 zod 校验）："));
    console.log(JSON.stringify(result, null, 2));
    console.log();

    // 展示类型安全的字段访问
    console.log(chalk.yellow("🔍 类型安全的访问："));
    console.log(`  专辑数: ${result.album_count} ${chalk.gray(`(${typeof result.album_count})`)}`);
    console.log(`  歌曲数: ${result.famous_songs.length} 首`);
}

// ============================================
// 主函数：按顺序运行三种方式
// ============================================
async function main() {
    console.log(chalk.cyan("\n🎓 结构化流式输出教学 - 三种方式对比\n"));
    console.log(chalk.gray("本文件展示如何在流式输出中获取结构化数据。"));
    console.log(chalk.gray("建议按顺序运行三种方式，体会差异。\n"));

    try {
        await streamThenParse();      // 方式一：最实用
        await incrementalParse();     // 方式二：进阶体验
        await structuredWithCallback(); // 方式三：结合 zod
    } catch (error) {
        console.error(chalk.red("\n❌ 发生错误："), error.message);
    }

    // ============================================
    // 知识扩展：三种方式对比总结
    // ============================================
    console.log(chalk.yellow("\n═══════════════════════════════════════════"));
    console.log(chalk.yellow("  📚 三种方式对比总结"));
    console.log(chalk.yellow("═══════════════════════════════════════════\n"));

    console.log(chalk.cyan("方式一：先流式显示，完整后再解析"));
    console.log(chalk.gray("  ✅ 最简单、最稳定"));
    console.log(chalk.gray("  ✅ 用户体验好（实时看到 AI 在打字）"));
    console.log(chalk.gray("  ✅ 解析只有一次，不会出错"));
    console.log(chalk.gray("  ❌ 结构化数据要等流结束才能用"));
    console.log();

    console.log(chalk.cyan("方式二：增量解析"));
    console.log(chalk.gray("  ✅ 可以边收边看到解析结果"));
    console.log(chalk.gray("  ✅ 适合大 JSON 的渐进式处理"));
    console.log(chalk.gray("  ❌ 增量解析可能失败（JSON 不完整时）"));
    console.log(chalk.gray("  ❌ 代码稍微复杂"));
    console.log();

    console.log(chalk.cyan("方式三：withStructuredOutput + 流式回调"));
    console.log(chalk.gray("  ✅ 结合 zod 类型校验，最规范"));
    console.log(chalk.gray("  ✅ 适合生产环境"));
    console.log(chalk.gray("  ❌ withStructuredOutput 本身不支持流式，需要手动包装"));
    console.log();

    console.log(chalk.green("🎯 推荐：生产环境优先用【方式一】或【方式三】！"));
    console.log(chalk.gray("   方式一适合聊天场景，方式三适合需要强类型校验的场景。"));
}

main().catch(e => console.error(chalk.red(`报错：${e}`)));
