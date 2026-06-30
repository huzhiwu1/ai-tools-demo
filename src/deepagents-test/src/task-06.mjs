import { ChatOpenAI } from "@langchain/openai";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import {
  createFilesystemMiddleware,
  FilesystemBackend,
  createMemoryMiddleware,
  createSummarizationMiddleware,
} from "deepagents";
import { createAgent, HumanMessage } from "langchain";
import chalk from "chalk";

const model = new ChatOpenAI({
  apiKey: process.env.API_KEY,
  model: process.env.MODEL_NAME,
  temperature: 0,
  configuration: {
    baseURL: process.env.BASE_URL,
  },
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceDir = path.join(__dirname, "workspace");

fs.rmSync(workspaceDir, { recursive: true, force: true });
fs.mkdirSync(workspaceDir, { recursive: true });

const historyPathPrefix = "/conversation_history";

const memoryPreferencesPath = "/memory/preferences.md";

const backend = new FilesystemBackend({
  rootDir: workspaceDir,
  virtualMode: true,
});

const filesystemMiddleware = createFilesystemMiddleware({
  backend,
});

const memoryMiddleware = createMemoryMiddleware({
  backend,
  sources: [memoryPreferencesPath],
});

const summaryPrompt = `你是对话摘要助手。请用中文总结以下对话，包含：
1. 讨论的主要话题
2. 达成的关键结论或决定
3. 继续对话所需的重要上下文

保持简洁，不要罗列无关细节。

待摘要的对话：
{conversation}

摘要：`;

const summarizationMiddleware = createSummarizationMiddleware({
  backend,
  model,
  historyPathPrefix,
  trigger: { type: "messages", value: 6 },
  keep: { type: "messages", value: 4 },
  summaryPrompt,
});

const agent = createAgent({
  model,
  tools: [],
  middleware: [filesystemMiddleware, memoryMiddleware, summarizationMiddleware],
  systemPrompt: [
    "你是项目助手。工作区根路径为 /，可用 ls、read_file、write_file、edit_file。",
    "根据 <agent_memory> 回答；用户要求记住时，必须立刻 edit_file，且按类型写入对应文件：",
    `- ${memoryPreferencesPath}： 用户偏好（语言、包管理器、回答风格等）`,
  ].join("\n"),
});

const prompts = [
  "记住：我喜欢用 pnpm",
  "记住：我叫小明",
  "记住：我在学习 DeepAgents",
  "记住：我的目标是成为 AI 工程师",
  "我叫什么？喜欢用什么包管理器？在学什么？目标是什么？",
];

const historyDir = path.join(
  workspaceDir,
  historyPathPrefix.replace(/^\//, ""),
);

function listHistoryFiles() {
  if (!fs.existsSync(historyDir)) return [];
  return fs.readdirSync(historyDir);
}

let messages = [];
async function run() {
  for (const prompt of prompts) {
    console.log(chalk.yellow("用户：", prompt));
    ({ messages } = await agent.invoke(
      {
        messages: [...messages, new HumanMessage(prompt)],
      },
      {
        recursionLimit: 20,
      },
    ));
    console.log(
      chalk.blue(
        "AI回复：",
        messages.at(-1)?.content,
        "当前消息数量：",
        messages.length,
      ),
    );
  }
}
await run();

console.log("\n\n=== 摘要文件内容 ===");
const knownHistory = listHistoryFiles();
if (knownHistory.length > 0) {
  for (const file of knownHistory) {
    const filePath = path.join(historyDir, file);
    console.log(
      `\n--- ${historyPathPrefix}/${file} ---\n`,
      fs.readFileSync(filePath, "utf8"),
    );
  }
} else {
  console.log("\n未生成 conversation_history（可能未触发摘要阈值）");
}

console.log("\n=== 偏好文件内容 ===");
const prefPath = path.join(workspaceDir, "memory/preferences.md");
if (fs.existsSync(prefPath)) {
  console.log(fs.readFileSync(prefPath, "utf8"));
} else {
  console.log("/memory/preferences.md 不存在");
}
