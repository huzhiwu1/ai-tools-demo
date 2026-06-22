/**
 * Exercise 04: 记忆 Middleware — 让 Agent 拥有持久记忆
 *
 * 学习目标：
 * 1. 掌握 createMemoryMiddleware 的分类记忆机制
 * 2. 理解 MemoryMiddleware 自动注入 <agent_memory> 的工作方式
 * 3. 掌握项目记忆 vs 个人偏好的分离存储
 *
 * 运行方式：pnpm ex4
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent, HumanMessage } from "langchain";
import {
  createFilesystemMiddleware,
  createMemoryMiddleware,
  FilesystemBackend,
} from "deepagents";

// ============================================
// 第一步：准备工作区
// ============================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceDir = path.join(__dirname, "workspace-memory");

// 每次运行前清空，确保可复现
fs.rmSync(workspaceDir, { recursive: true, force: true });
fs.mkdirSync(workspaceDir);

// ============================================
// 第二步：定义记忆文件路径
// ============================================

/**
 * 记忆分类说明
 *
 * DeepAgents 的记忆不是"一个文件装所有"，而是按类型分别存储：
 *
 * | 类型 | 路径 | 存什么 |
 * |------|------|--------|
 * | 项目记忆 | /AGENTS.md | 技术栈、架构、仓库约定 |
 * | 个人偏好 | /memory/preferences.md | 语言、包管理器、回答风格 |
 *
 * 核心原则：不同类型的记忆存到不同文件，不要混写！
 *
 * 为什么？
 * 1. Token 效率：每次只需读取相关类型的记忆
 * 2. 更新安全：修改偏好不会影响项目信息
 * 3. LLM 理解更准确：清楚每类信息的用途
 */
const projectMemoryPath = "/AGENTS.md";
const preferencesMemoryPath = "/memory/preferences.md";

// ============================================
// 第三步：创建 Backend 和 Middleware
// ============================================

const backend = new FilesystemBackend({
  rootDir: workspaceDir,
  virtualMode: true,
});

/**
 * [createMemoryMiddleware]
 *
 * 职责：在每次 Agent 调用时，自动读取 sources 中的记忆文件，注入到 prompt 中
 *
 * 流程：
 * 1. 用户发送消息
 * 2. MemoryMiddleware 读取 sources 中所有文件的内容
 * 3. 将内容包裹在 <agent_memory> 标签中，注入到 systemMessage
 * 4. LLM 根据 <agent_memory> 中的记忆回答问题
 *
 * 关键细节：
 * - sources 是一个数组，可以指定多个记忆文件
 * - 如果文件不存在，Middleware 不会报错（空记忆）
 * - 用户要求"记住"时，Agent 会调用 edit_file 写入对应文件
 * - 下次调用时，Middleware 会自动读取新写入的内容
 */
const memoryMiddleware = createMemoryMiddleware({
  backend,
  sources: [projectMemoryPath, preferencesMemoryPath],
});

/**
 * [createFilesystemMiddleware]
 *
 * 职责：为 Agent 提供文件操作能力（用于读写记忆文件）
 *
 * 注意：MemoryMiddleware 只负责"读取并注入"，
 * "写入记忆"仍然需要 FilesystemMiddleware 提供 write_file / edit_file 工具
 */
const filesystemMiddleware = createFilesystemMiddleware({ backend });

// ============================================
// 第四步：创建 Agent
// ============================================

const model = new ChatOpenAI({
  model: process.env.MODEL_NAME,
  apiKey: process.env.OPENAI_API_KEY,
  configuration: { baseURL: process.env.OPENAI_BASE_URL },
  temperature: 0,
});

// TODO: 仔细阅读 systemPrompt，理解记忆的写入规则
const agent = createAgent({
  model,
  tools: [],
  systemPrompt: [
    "你是项目助手。工作区根路径为 /，可用 ls、read_file、write_file、edit_file。",
    "根据 <agent_memory> 回答；用户要求记住时，必须立刻 edit_file，且按类型写入对应文件：",
    `- ${projectMemoryPath}：项目说明、技术栈、架构、仓库约定等`,
    `- ${preferencesMemoryPath}：用户个人偏好（语言、包管理器、回答风格等）`,
    "不要混写：项目事实不要写入 preferences，个人偏好不要写入 AGENTS.md。",
  ].join("\n"),
  middleware: [
    createFilesystemMiddleware({ backend }),
    createMemoryMiddleware({
      backend,
      sources: [projectMemoryPath, preferencesMemoryPath],
    }),
  ],
});

// ============================================
// 第五步：运行多轮对话
// ============================================

/**
 * 对话流程说明
 *
 * 1. "这个项目是做什么的？" → 空记忆，Agent 无法回答
 * 2. "记住：我常用 pnpm" → 写入 /memory/preferences.md
 * 3. "记住：本仓库主入口脚本是 src/index.mjs" → 写入 /AGENTS.md
 * 4. "我常用什么包管理器？" → 从 <agent_memory> 中读取偏好
 *
 * 关键：messages 变量在循环外声明，每轮对话的 messages 会累积
 * 这样 Agent 才能基于之前的上下文继续对话
 */
const prompts = [
  "根据记忆，这个项目是做什么的？只答一句。",
  "请记住：我常用的包管理器是 pnpm。",
  "请记住：本仓库主入口脚本是 src/deepagents/memory-agent.mjs。",
  "我常用什么包管理器？本 demo 主入口脚本路径是什么？各用一行回答。",
];

// TODO: 添加更多测试 prompt
// 提示：你可以测试以下场景：
// 1. 让 Agent 记住一个项目级信息（如"项目使用 Vue3 + TypeScript"）
// 2. 让 Agent 记住一个个人偏好（如"我喜欢简短的回答"）
// 3. 验证这些信息是否被写入了正确的文件

let messages = [];

for (const prompt of prompts) {
  console.log("\n用户:", prompt);
  ({ messages } = await agent.invoke(
    { messages: [...messages, new HumanMessage(prompt)] },
    { recursionLimit: 30 },
  ));
  console.log("回复:", messages.at(-1)?.content);
}

// ============================================
// 第六步：查看记忆文件内容
// ============================================

console.log("\n\n=== 记忆文件内容 ===");

for (const p of [projectMemoryPath, preferencesMemoryPath]) {
  const file = path.join(workspaceDir, p.replace(/^\//, ""));
  if (fs.existsSync(file)) {
    console.log(`\n--- ${p} ---\n`, fs.readFileSync(file, "utf8"));
  } else {
    console.log(`\n--- ${p} ---\n (文件不存在)`);
  }
}

/**
 * 预期输出：
 *
 * 用户: 根据记忆，这个项目是做什么的？只答一句。
 * 回复: 目前没有关于此项目的记忆记录。
 *
 * 用户: 请记住：我常用的包管理器是 pnpm。
 * (Agent 调用 edit_file 写入 /memory/preferences.md)
 * 回复: 已记住您常用 pnpm 作为包管理器。
 *
 * 用户: 请记住：本仓库主入口脚本是 src/deepagents/memory-agent.mjs。
 * (Agent 调用 edit_file 写入 /AGENTS.md)
 * 回复: 已记住仓库主入口脚本。
 *
 * 用户: 我常用什么包管理器？本 demo 主入口脚本路径是什么？各用一行回答。
 * 回复: 常用包管理器: pnpm。主入口脚本: src/deepagents/memory-agent.mjs。
 *
 * --- /AGENTS.md ---
 * 仓库主入口脚本: src/deepagents/memory-agent.mjs
 *
 * --- /memory/preferences.md ---
 * 用户常用的包管理器: pnpm
 *
 * 知识扩展：
 *
 * Q: <agent_memory> 是什么？
 * A: 它是 MemoryMiddleware 自动注入的 XML 标签。Middleware 会在每轮对话开始前，
 *    读取 sources 中的所有文件，将内容包裹在 <agent_memory> 中，插入到 systemMessage。
 *    LLM 看到的系统提示词大概是这样的：
 *    "你是项目助手... <agent_memory> [AGENTS.md的内容] [preferences.md的内容] </agent_memory>"
 *
 * Q: 为什么要分离 AGENTS.md 和 preferences.md？
 * A: 1. Token 效率：如果只有一个大文件，每次都要读取全部内容
 *    2. 更新安全：修改偏好不会意外覆盖项目信息
 *    3. 团队协作：AGENTS.md 可以提交到 Git，preferences.md 是个人配置（加入 .gitignore）
 */
