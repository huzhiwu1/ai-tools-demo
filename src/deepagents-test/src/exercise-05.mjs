/**
 * Exercise 05: 摘要 Middleware — 自动压缩长对话
 *
 * 学习目标：
 * 1. 掌握 createSummarizationMiddleware 的对话压缩机制
 * 2. 理解 trigger 和 keep 参数的作用
 * 3. 理解摘要的自动触发和存储流程
 *
 * 运行方式：pnpm ex5
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent, HumanMessage } from "langchain";
import { createSummarizationMiddleware, FilesystemBackend } from "deepagents";

// ============================================
// 第一步：准备工作区
// ============================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceDir = path.join(__dirname, "workspace-summarization");
const historyPathPrefix = "/conversation_history";

// 每次运行前清空
fs.rmSync(workspaceDir, { recursive: true, force: true });
fs.mkdirSync(workspaceDir, { recursive: true });

// ============================================
// 第二步：定义摘要提示词
// ============================================

/**
 * [summaryPrompt]
 *
 * 职责：指导 LLM 如何生成对话摘要
 *
 * 关键细节：
 * - {conversation} 是占位符，运行时会被替换为实际对话内容
 * - 摘要应包含：主要话题、关键结论、继续对话所需的上下文
 * - 摘要应简洁，不要罗列无关细节
 */
const summaryPrompt = `你是对话摘要助手。请用中文总结以下对话，包含：
1. 讨论的主要话题
2. 达成的关键结论或决定
3. 继续对话所需的重要上下文

保持简洁，不要罗列无关细节。

待摘要的对话：
{conversation}

摘要：`;

// ============================================
// 第三步：创建 Middleware 和 Agent
// ============================================

const model = new ChatOpenAI({
  model: process.env.MODEL_NAME,
  apiKey: process.env.OPENAI_API_KEY,
  configuration: { baseURL: process.env.OPENAI_BASE_URL },
  temperature: 0,
});

const backend = new FilesystemBackend({
  rootDir: workspaceDir,
  virtualMode: true,
});

/**
 * [createSummarizationMiddleware]
 *
 * 职责：当对话消息超过阈值时，自动压缩旧消息为摘要
 *
 * 流程（以 trigger=8, keep=4 为例）：
 * 1. 用户发送第 8 条消息 → 超过 trigger(8)
 * 2. Middleware 调用 LLM 对前 4 条消息生成摘要
 * 3. 摘要保存到 /conversation_history/xxx.json
 * 4. 保留最近 4 条消息 + 摘要作为新的上下文
 * 5. 继续对话
 *
 * 关键参数说明：
 * - model: 用于生成摘要的 LLM（可以和 Agent 的 model 不同）
 * - backend: 文件系统后端，用于存储摘要
 * - historyPathPrefix: 摘要文件的存储路径前缀
 * - summaryPrompt: 摘要生成提示词
 * - trigger: 触发阈值（超过多少条消息时触发摘要）
 * - keep: 保留最近多少条消息（不被摘要压缩的）
 */
const agent = createAgent({
  model,
  tools: [],
  systemPrompt:
    "你是会话助手。记住用户提到的关键事实，中文简短回答。若看到「此前对话摘要」，请据此继续对话。",
  middleware: [
    // TODO: 补全 createSummarizationMiddleware 的参数
    // 提示：参考上面的参数说明
    // createSummarizationMiddleware({
    //   model,
    //   backend,
    //   historyPathPrefix,
    //   summaryPrompt,
    //   trigger: { type: "messages", value: 8 },
    //   keep: { type: "messages", value: 4 },
    // }),
  ],
});

// ============================================
// 第四步：运行多轮对话触发摘要
// ============================================

/**
 * 对话流程说明
 *
 * 这 5 条消息的设计是为了触发摘要：
 * 1. "记住猫叫小橘" → 消息数 +2（Human + AI）
 * 2. "记住住在北京" → 消息数 +2
 * 3. "记住喜欢拿铁" → 消息数 +2 → 累计 6 条
 * 4. "记住生日 5 月 1 日" → 消息数 +2 → 累计 8 条 → 触发摘要！
 * 5. "回忆所有信息" → 验证摘要后 Agent 仍能回答
 *
 * 每轮对话后检查是否有新的摘要文件生成
 */
const prompts = [
  "请记住：我的宠物猫叫小橘。",
  "请记住：我住在北京。",
  "请记住：我喜欢喝拿铁。",
  "请记住：我的生日是 5 月 1 日。",
  "根据我们聊过的内容，我的猫叫什么、住哪、喜欢喝什么、生日是哪天？每项一行。",
];

// 用于追踪哪些摘要文件是新生成的
const historyDir = path.join(
  workspaceDir,
  historyPathPrefix.replace(/^\//, ""),
);

function listHistoryFiles() {
  if (!fs.existsSync(historyDir)) return [];
  return fs.readdirSync(historyDir);
}

let messages = [];
let knownHistory = new Set(listHistoryFiles());

for (const prompt of prompts) {
  console.log("\n用户:", prompt);
  ({ messages } = await agent.invoke(
    { messages: [...messages, new HumanMessage(prompt)] },
    { recursionLimit: 30 },
  ));

  console.log("回复:", messages.at(-1)?.content);
  console.log("当前消息数:", messages.length);

  // 检查是否有新的摘要文件生成
  const historyFiles = listHistoryFiles();
  for (const file of historyFiles) {
    if (!knownHistory.has(file)) {
      knownHistory.add(file);
      console.log("已触发摘要，历史已写入:", `${historyPathPrefix}/${file}`);
    }
  }
}

// ============================================
// 第五步：查看摘要文件内容
// ============================================

console.log("\n\n=== 摘要文件内容 ===");

if (knownHistory.size > 0) {
  for (const file of knownHistory) {
    const filePath = path.join(historyDir, file);
    console.log(
      `\n--- ${historyPathPrefix}/${file} ---\n`,
      fs.readFileSync(filePath, "utf8"),
    );
  }
} else {
  console.log(
    "\n未生成 conversation_history（可能未触发摘要阈值，请检查 TODO 是否已补全）",
  );
}

/**
 * 预期输出（补全 TODO 后）：
 *
 * 用户: 请记住：我的宠物猫叫小橘。
 * 回复: 已记住你的宠物猫叫小橘。
 * 当前消息数: 2
 *
 * 用户: 请记住：我住在北京。
 * 回复: 已记住你住在北京。
 * 当前消息数: 4
 *
 * 用户: 请记住：我喜欢喝拿铁。
 * 回复: 已记住你喜欢喝拿铁。
 * 当前消息数: 6
 *
 * 用户: 请记住：我的生日是 5 月 1 日。
 * 已触发摘要，历史已写入: /conversation_history/xxx.json
 * 回复: 已记住你的生日是5月1日。
 * 当前消息数: 4  ← 注意：消息数从 8 压缩到了 4！
 *
 * 用户: 根据我们聊过的内容...
 * 回复: 猫叫小橘，住在北京，喜欢喝拿铁，生日5月1日。
 *
 * 知识扩展：
 *
 * Q: 为什么消息数会从 8 变成 4？
 * A: 因为摘要中间件在触发后，会用摘要替代旧消息。
 *    原来的 8 条消息中，前 4 条被压缩成了一个摘要（1 条消息），
 *    加上保留的最近 4 条，总共约 5 条。
 *    但在 Agent 的 messages 中，摘要会以特定格式注入，所以实际数可能略有不同。
 *
 * Q: trigger 和 keep 怎么设？
 * A: Demo/测试：设较小的值（如 trigger=8, keep=4），便于快速看到效果
 *    生产环境：可以省略，让框架根据模型 profile 自动推断
 *    原则：trigger - keep = 每次摘要的"压缩量"
 *    差值越大，压缩越激进，但可能丢失细节
 *
 * Q: 摘要文件是什么格式？
 * A: JSON 格式，存储在 historyPathPrefix 指定的路径下。
 *    包含：摘要内容、时间戳、被摘要的消息范围等信息。
 */
