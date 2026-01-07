import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import {
  SystemMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import fs from "fs/promises";
import z from "zod";

const model = new ChatOpenAI({
  modelName: process.env.MODEL_NAME,
  apiKey: process.env.API_KEY,
  temperature: 0,
  configuration: {
    baseURL: process.env.BASE_URL,
  },
});

const readFileTool = tool(
  async ({ filePath }) => {
    const content = await fs.readFile(filePath, "utf-8");
    console.log(
      `[工具调用] readFileTool("${filePath}") 成功读取${content.length}个字符`
    );
    return `文件内容:\n ${content}`;
  },
  {
    name: "read_file",
    description:
      "用此工具来读取文件内容。当用户需要查看文件内容，读取代码，分析文件内容时使用。可以传入文件的绝对路径和相对路径。",
    schema: z.object({
      filePath: z.string().describe("文件路径"),
    }),
  }
);

const tools = [readFileTool];

const modelWithTools = model.bindTools(tools);

const messages = [
  new SystemMessage({
    content: `你是一个专业的代码助手，你可以使用read_file工具来读取文件内容并解释代码
        工作流程：
        1. 当用户需要读取文件内容时，调用read_file工具并传入文件路径。
        2. 工具会返回文件的内容。
        3. 你可以根据文件内容来回答用户的问题或解释代码。
        可用工具：
        - read_file: 用于读取文件内容。
        `,
  }),
  new HumanMessage({
    content: "请读取src/hello-langChain.mjs文件内容,并解释代码",
  }),
];

let resp = await modelWithTools.invoke(messages);

messages.push(resp);

while (resp.tool_calls && resp.tool_calls.length > 0) {
  console.log(`检测到${resp.tool_calls.length}个工具调用`);
  const toolResponses = await Promise.all(
    resp.tool_calls.map(async (toolCall) => {
      const tool = tools.find((t) => t.name === toolCall.name);
      if (!tool) {
        return `工具${toolCall.name}不存在`;
      }
      console.log(`调用工具${toolCall.name}，参数${toolCall.args}`);
      try {
        return await tool.invoke(toolCall.args);
      } catch (error) {
        return `工具${toolCall.name}调用失败，错误信息：${error.message}`;
      }
    })
  );
  resp.tool_calls.forEach((toolCall, index) => {
    messages.push(
      new ToolMessage({
        content: toolResponses[index],
        tool_call_id: toolCall.id,
      })
    );
  });
  resp = await modelWithTools.invoke(messages);
}
console.log("最终回复：\n");
console.log(resp.content);
