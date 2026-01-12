import "dotenv/config"; // 加载 .env 文件中的环境变量
import { MultiServerMCPClient } from "@langchain/mcp-adapters"; // 导入 LangChain 的 MCP 多服务器适配器
import { ChatOpenAI } from "@langchain/openai"; // 导入 OpenAI 聊天模型
import {
  HumanMessage,
  ToolMessage,
  SystemMessage,
} from "@langchain/core/messages"; // 导入 LangChain 的消息类型
import chalk from "chalk"; // 导入 chalk 用于控制台彩色输出

// 初始化 OpenAI 模型
const model = new ChatOpenAI({
  modelName: process.env.MODEL_NAME, // 从环境变量获取模型名称
  temperature: 0, // 设置温度为 0，使输出尽可能确定
  apiKey: process.env.API_KEY, // 设置 API Key
  configuration: {
    baseURL: process.env.BASE_URL, // 设置 API Base URL
  },
});

// 初始化 MCP 客户端，连接多个 MCP 服务器
const mcpClient = new MultiServerMCPClient({
  mcpServers: {
    // 1. 本地 Node.js 脚本形式的 MCP Server
    "my-mcp-server": {
      command: "node",
      args: ["/Users/huzhiwu/workspace/ai-tools-demo/src/my-mcp-server.mjs"],
    },
    // 2. 远程 SSE (Server-Sent Events) 形式的 MCP Server (高德地图)
    "amap-maps-streambleHTTP": {
      url: "https://mcp.amap.com/sse?key=" + process.env.AMAP_MAPS_API_KEY,
    },
    // 3. 本地文件系统 Server (通过 npx 运行)
    fileSystem: {
      command: "npx",
      args: [
        "-y",
        "@modelcontextprotocol/server-filesystem", // 使用官方文件系统 Server
        ...(process.env.ALLOWED_PATHS || "").split(","), // 允许访问的目录列表
      ],
    },
    // 4. Chrome DevTools Server (通过 npx 运行)，用于控制浏览器
    "chrome-devtools": {
      command: "npx",
      args: ["-y", "chrome-devtools-mcp@latest"],
    },
  },
});

console.log(chalk.yellow("正在连接 MCP Server 获取工具..."));
// 从所有连接的 MCP Server 获取工具列表
const tools = await mcpClient.getTools();
console.log(chalk.green(`成功获取 ${tools.length} 个工具`));
// 将工具绑定到 LLM 模型，使模型知道有哪些工具可用
const modelWithTools = model.bindTools(tools);

// 运行 Agent 的主函数
async function runAgentWithTools(query, maxIteractions = 30) {
  const messages = [
    // SystemMessage: 设置系统提示词，指导 AI 如何使用工具和处理特定情况
    new SystemMessage(
      "在使用地图工具时，请注意：maps_around_search 的结果中通常已经包含 photo 字段（图片URL）。请优先直接使用该 photo 字段，而不要依赖 maps_search_detail 来获取图片，因为 maps_search_detail 经常返回空数据。\n\n" +
        "在浏览器中展示图片时，为了避免跨域或防盗链（403 Forbidden）问题，请遵循以下策略之一：\n" +
        "1. 优先使用 `new_page` 或 `navigate_page` 直接打开图片 URL。浏览器直接访问通常不会发送 Referer，可以绕过防盗链。\n" +
        '2. 如果必须在 HTML 页面中嵌入图片（例如 `document.body.appendChild(img)`），请务必先执行脚本添加 `<meta name="referrer" content="no-referrer" />` 到 `<head>` 中，然后再插入图片标签。'
    ),
    new HumanMessage(query), // 用户的初始查询
  ];

  // Agent 循环：思考 -> 行动 -> 观察 -> 再思考
  for (let i = 0; i < maxIteractions; i++) {
    console.log(chalk.blue(`AI正在思考，第${i}轮`));
    // 调用模型，获取回复
    const response = await modelWithTools.invoke(messages);
    // 将 AI 的回复加入历史记录
    messages.push(response);

    // 如果 AI 没有调用工具，说明它认为任务已完成或需要更多信息
    if (!response.tool_calls || response.tool_calls.length === 0) {
      console.log(chalk.blue(`AI思考结束，回复: ${response.content}`));
      // 如果回复包含"任务完成"或达到最大轮数，则退出
      if (response.content.includes("任务完成") || i === maxIteractions - 1) {
        return response.content;
      }
      // 否则提示 AI 继续使用工具
      messages.push(
        new HumanMessage(
          "请继续使用工具完成任务，不要只回答文字。如果任务已完成，请回复“任务完成”"
        )
      );
      continue;
    }

    // 打印 AI 计划调用的工具
    console.log(
      chalk.blue(
        `检测到AI正在调用${
          response.tool_calls.length
        }个工具，工具调用列表: ${response.tool_calls
          .map((call) => `${call.name}(${JSON.stringify(call.args)})`)
          .join("\n-")}`
      )
    );

    // 遍历并执行每一个工具调用
    for (const toolCall of response.tool_calls) {
      // 在工具列表中查找对应的工具
      const foundCall = tools.find((tool) => tool.name === toolCall.name);
      let toolResult;

      if (!foundCall) {
        console.log(chalk.blue(`未找到工具 ${toolCall.name}`));
        toolResult = { content: `Error: Tool ${toolCall.name} not found` };
      } else {
        try {
          // 执行工具
          toolResult = await foundCall.invoke(toolCall.args);
        } catch (error) {
          // 捕获工具执行错误，避免程序崩溃
          console.error(
            chalk.red(`工具 ${toolCall.name} 执行出错: ${error.message}`)
          );
          toolResult = { content: `Error: ${error.message}` };
        }
      }

      // 打印工具执行结果（截取前200字符）
      console.log(
        chalk.gray(
          `工具 ${toolCall.name} 执行结果: ${JSON.stringify(
            toolResult
          ).substring(0, 200)}...`
        )
      );

      // 格式化工具返回的内容
      let contentStr = "";
      if (typeof toolResult === "string") {
        contentStr = toolResult;
      } else if (typeof toolResult.content === "string") {
        contentStr = toolResult.content;
      } else if (toolResult && toolResult.text) {
        contentStr = toolResult.text;
      } else {
        contentStr = JSON.stringify(toolResult);
      }

      // 将工具执行结果作为 ToolMessage 加入历史记录
      messages.push(
        new ToolMessage({
          content: contentStr,
          tool_call_id: toolCall.id,
        })
      );
    }
  }
  return messages[messages.length - 1].content;
}

// await runAgentWithTools(
//   "广州白云区附近的酒店，以及去的路线,路线规划生成文档保存到 /Users/huzhiwu/Desktop 的一个md文档中"
// );

await runAgentWithTools(
  "广州白云区三元里附近的酒店，最近的三个酒店，，拿到酒店图片，打开浏览器，展示每个酒店的图片，每个 tab 一个 url 展示，并且在把那个页面标题改为酒店名"
);
await mcpClient.close();
