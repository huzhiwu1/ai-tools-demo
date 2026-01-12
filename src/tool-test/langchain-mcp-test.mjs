import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import {
  HumanMessage,
  ToolMessage,
  SystemMessage,
} from "@langchain/core/messages";
import chalk from "chalk";

const model = new ChatOpenAI({
  modelName: process.env.MODEL_NAME,
  temperature: 0,
  apiKey: process.env.API_KEY,
  configuration: {
    baseURL: process.env.BASE_URL,
  },
});

const mcpClient = new MultiServerMCPClient({
  mcpServers: {
    "my-mcp-server": {
      command: "node",
      args: ["/Users/huzhiwu/workspace/ai-tools-demo/src/my-mcp-server.mjs"],
    },
  },
});

// 1. 获取工具 (Tools)
// 目的：从 MCP Server 加载可用的工具定义（例如 query_user）。
// 方式：调用 mcpClient.getTools()，这是一个异步操作，必须使用 await。
// 拿到的数据：一个工具对象数组，LangChain 可以直接将其 bind 到模型上。
const tools = await mcpClient.getTools();

// 2. 获取资源 (Resources)
// 目的：获取 MCP Server 提供的静态或动态资源（例如文档、配置文件）。
// 方式：先 listResources 列出所有资源，再 readResource 读取具体内容。
const res = await mcpClient.listResources();

let resourcesContent = "";
// Object.entries(res) 返回的是 [serverName, resourcesArray][]。
// resources 是一个数组，因为一个 MCP Server 可以注册多个 Resource（使用 server.registerResource 多次）。
// 在 src/my-mcp-server.mjs 中，我们通过 server.registerResource("使用指南", ...) 注册了一个资源。
// 如果我们在那里注册了更多资源，这个数组就会包含多个对象。
for (const [name, resources] of Object.entries(res)) {
  for (const resource of resources) {
    // 拿到的数据：content 是一个数组，通常包含 { text: "..." } 或二进制数据。
    const content = await mcpClient.readResource(name, resource.uri);
    resourcesContent += `资源${name}：${content[0].text}\n`;
  }
}

// 3. 绑定工具到模型
// 目的：让 LLM 知道有哪些工具可用，并知道如何调用它们（参数结构）。
const modelWithTools = model.bindTools(tools);

async function runAgentWithTools(query, maxIteractions = 30) {
  const messages = [
    // 将读取到的 MCP 资源作为 System Prompt 的一部分，赋予 AI 背景知识
    new SystemMessage(resourcesContent),
    new HumanMessage(query),
  ];
  for (let i = 0; i < maxIteractions; i++) {
    console.log(chalk.blue(`等待AI思考，第${i}轮迭代`));
    const response = await modelWithTools.invoke(messages);
    messages.push(response);
    if (!response.tool_calls || response.tool_calls.length === 0) {
      console.log(chalk.green(`AI思考结束，回复：${response.content}`));
      if (response.content.includes("任务完成") || i === maxIteractions - 1) {
        return response.content;
      }
      messages.push(
        new HumanMessage(
          "请继续使用工具完成任务，不要只回答文字。如果任务已完成，请回复“任务完成”"
        )
      );
      continue;
    }
    console.log(
      chalk.green(
        `检测到AI调用了${
          response.tool_calls.length
        }个工具：\n${response.tool_calls.map((call) => call.name).join("-\n")}`
      )
    );
    const toolResults = await Promise.all(
      response.tool_calls.map(async (call) => {
        const tool = tools.find((t) => t.name === call.name);
        if (!tool) {
          return `工具 ${call.name} 不存在`;
        }
        return await tool.invoke(call.args);
      })
    );

    response.tool_calls.forEach((call, index) => {
      messages.push(
        new ToolMessage({
          tool_call_id: call.id,
          content: toolResults[index],
        })
      );
    });
  }
  return response.content[response.content.length - 1];
}

await runAgentWithTools("mcp server的使用指南是什么");
await mcpClient.close();
