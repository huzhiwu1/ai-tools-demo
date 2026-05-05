// ============================================
// mini-cursor.mjs
// ============================================
//
// 职责：实现一个流式版 AI Agent，能像 Cursor IDE 一样实时生成代码
//
// 核心架构：ReAct 循环（感知 → 思考 → 行动 → 观察）
//
// 流程：
//   1. 初始化：绑定工具到模型，创建对话历史
//   2. 用户输入 → 加入历史
//   3. 进入循环（最多 maxIterations 轮）：
//      a. 获取历史消息
//      b. 调用 model.stream() 获取流式输出
//      c. 增量解析 tool_call（边收边尝试解析）
//      d. 如果是 write_file，实时预览内容（打字机效果）
//      e. 流结束后，完整消息存入历史
//      f. 如果有 tool_calls，执行工具，结果回传历史
//      g. 如果没有 tool_calls，直接返回最终答案
//   4. 循环结束，返回最后一条消息内容
//
// 关键技术：流式增量解析
//   普通流式：只显示文本，无法提前知道 LLM 在调什么工具
//   本方案：每收到一个 chunk 就用 JsonOutputToolsParser 尝试解析
//   一旦解析出 write_file 的 content，立刻把新增内容打到屏幕
//   printedLengths Map 记录每个工具已打印长度，避免重复输出
//
// 关键细节：
//   fullAIMessage 通过 concat() 累积，流结束后是完整 AIMessage
//   toolParser.parseResult() 在 JSON 不完整时会抛异常，需 try/catch 忽略
//   工具执行结果用 ToolMessage 包装，tool_call_id 必须对应，否则历史错乱
//   maxIterations 是安全阀，防止无限循环
//
// 知识扩展：
//   什么是 ReAct？Reasoning + Acting 的缩写。
//   LLM 先推理（Thought），再决定行动（Action），然后观察结果（Observation），
//   循环往复直到完成任务。这是目前最可靠的 Agent 设计模式。
//
//   什么是流式输出？LLM 不一次性返回完整回答，而是像打字一样逐块传输。
//   用户感知更快，但需要"拼图"才能得到完整数据。
//
//   为什么能实时预览代码？因为 LLM 的 tool_call 参数也是流式传输的。
//   我们在传输过程中就尝试解析 content 字段，有新增就打印，实现直播效果。
// ============================================

import 'dotenv/config';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { InMemoryChatMessageHistory } from '@langchain/core/chat_history';
import { JsonOutputToolsParser } from '@langchain/core/output_parsers/openai_tools';
import { executeCommandTool, listDirectoryTool, readFileTool, writeFileTool } from './all-tools.mjs';
import chalk from 'chalk';

const model = new ChatOpenAI({
    modelName: process.env.MODEL_NAME,
    apiKey: process.env.API_KEY,
    temperature: 0,
    configuration: {
        baseURL: process.env.BASE_URL,
    },
});

const tools = [
    readFileTool,
    writeFileTool,
    executeCommandTool,
    listDirectoryTool,
];

// 绑定工具到模型
const modelWithTools = model.bindTools(tools);

// Agent 执行函数
async function runAgentWithTools(query, maxIterations = 30) {
    const history = new InMemoryChatMessageHistory();

    await history.addMessage(new SystemMessage(`你是一个项目管理助手，使用工具完成任务。

当前工作目录: ${process.cwd()}

工具：
1. read_file: 读取文件
2. write_file: 写入文件
3. execute_command: 执行命令（支持 workingDirectory 参数）
4. list_directory: 列出目录

重要规则 - execute_command：
- wordingDirectory 参数会自动切换到指定目录
- 当使用 workingDirectory 时，绝对不要在 command 中使用 cd
- 错误示例: { command: "cd react-todo-app && pnpm install", workingDirectory: "react-todo-app" }
- 正确示例: { command: "pnpm install", workingDirectory: "react-todo-app" }

重要规则 - write_file：
- 当写入 React 组件文件（如 App.tsx）时，如果存在对应的 CSS 文件（如 App.css），在其他 import 语句后加上这个 css 的导入
`));

    await history.addMessage(new HumanMessage(query));

    for (let i = 0; i < maxIterations; i++) {
        console.log(chalk.bgGreen(`⏳ 正在等待 AI 思考...`));

        // 获取当前消息历史
        const messages = await history.getMessages();

        const rawStream = await modelWithTools.stream(messages);

        // 准备一个空的容器来拼接完整的 AIMessage
        let fullAIMessage = null;

        // 准备一个 tool_call_chunks 的 JSON 增量解析器
        const toolParser = new JsonOutputToolsParser();

        // 记录每个工具调用已打印的长度（用 id 或 filePath 作为 key）
        const printedLengths = new Map();

        console.log(chalk.bgBlue(`\n🚀 Agent 开始思考并生成流...\n`));

        for await (const chunk of rawStream) {
            // 这里的 chunk 是 AIMessageChunk，把它拼接起来
            fullAIMessage = fullAIMessage ? fullAIMessage.concat(chunk) : chunk;

            let parsedTools = null;
            try {
                parsedTools = await toolParser.parseResult([{ message: fullAIMessage }]);
            } catch (e) {
                // 解析失败说明 JSON 还不完整，忽略错误继续累积
            }

            if (parsedTools && parsedTools.length > 0) {
                for (const toolCall of parsedTools) {
                    if (toolCall.type === 'write_file' && toolCall.args?.content) {
                        const toolCallId = toolCall.id || toolCall.args.filePath || 'default';
                        const currentContent = String(toolCall.args.content);
                        const previousLength = printedLengths.get(toolCallId);

                        if (previousLength === undefined) {
                            printedLengths.set(toolCallId, 0);
                            console.log(
                                chalk.bgBlue(
                                    `\n[工具调用] write_file("${toolCall.args.filePath}") - 开始写入（流式预览）\n`,
                                ),
                            );
                        }

                        if (currentContent.length > previousLength) {
                            const newContent = currentContent.slice(previousLength);
                            process.stdout.write(newContent);
                            printedLengths.set(toolCallId, currentContent.length);
                        }
                    }
                }
            } else {
                // 当前还没有解析出工具调用时，如果有文本内容就直接输出
                if (chunk.content) {
                    process.stdout.write(
                        typeof chunk.content === 'string'
                            ? chunk.content
                            : JSON.stringify(chunk.content),
                    );
                }
            }
        }

        // 此时 fullAIMessage 已经完美还原，直接存入 history
        await history.addMessage(fullAIMessage);
        console.log(chalk.green('\n✅ 消息已完整存入历史'));

        // 检查是否有工具调用
        if (!fullAIMessage.tool_calls || fullAIMessage.tool_calls.length === 0) {
            console.log(`\n✨ AI 最终回复:\n${fullAIMessage.content}\n`);
            return fullAIMessage.content;
        }

        // 执行工具调用
        for (const toolCall of fullAIMessage.tool_calls) {
            const foundTool = tools.find((t) => t.name === toolCall.name);
            if (foundTool) {
                const toolResult = await foundTool.invoke(toolCall.args);
                await history.addMessage(
                    new ToolMessage({
                        content: toolResult,
                        tool_call_id: toolCall.id,
                    }),
                );
            }
        }
    }

    const finalMessages = await history.getMessages();
    return finalMessages[finalMessages.length - 1].content;
}

const case1 = `创建一个功能丰富的 React TodoList 应用：

1. 创建项目：echo -e "n\nn" | pnpm create vite react-todo-app --template react-ts
2. 修改 src/App.tsx，实现完整功能的 TodoList：
 - 添加、删除、编辑、标记完成
 - 分类筛选（全部/进行中/已完成）
 - 统计信息显示
 - localStorage 数据持久化
3. 添加复杂样式：
 - 渐变背景（蓝到紫）
 - 卡片阴影、圆角
 - 悬停效果
4. 添加动画：
 - 添加/删除时的过渡动画
 - 使用 CSS transitions
5. 列出目录确认

注意：使用 pnpm，功能要完整，样式要美观，要有动画效果

去掉 main.tsx 里的 index.css 导入

之后在 react-todo-app 项目中：
1. 使用 pnpm install 安装依赖
2. 使用 pnpm run dev 启动服务器
`;

try {
    await runAgentWithTools(case1);
} catch (error) {
    console.error(`\n❌ 错误: ${error.message}\n`);
}

