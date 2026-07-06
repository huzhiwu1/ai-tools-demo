/**
 * Exercise 05: 基于 Redis 的 AI Agent 短期记忆系统
 *
 * 学习目标：
 * 1. 理解 Agent 短期记忆的存储和检索模式
 * 2. 掌握 Redis 在 AI 对话系统中的应用
 * 3. 学会消息压缩（Summarization）策略
 * 4. 实现可续聊的对话系统
 *
 * 核心流程：
 *   invoke 前：从 Redis 读取该会话的 messages
 *   invoke 后：把 agent 返回的 messages 写回 Redis（带 TTL）
 *   压缩：由 langchain summarizationMiddleware 在 agent 内部完成
 *
 * 前置条件：
 *   docker compose up -d redis
 *   cp .env.example .env  并填写 API Key
 *
 * 运行命令：
 *   node src/exercise-05.mjs
 *
 * 交互命令：
 *   exit / quit / :q  退出
 *   :clear            清空当前会话记忆
 */

import "dotenv/config";
import Redis from "ioredis";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ChatOpenAI } from "@langchain/openai";
import {
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
} from "@langchain/core/messages";
import { createAgent, HumanMessage, summarizationMiddleware } from "langchain";

// ============================================
// 1. 配置常量（从环境变量读取）
// ============================================

const REDIS_HOST = process.env.REDIS_HOST ?? "localhost";
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);
const REDIS_DB = Number(process.env.REDIS_DB ?? 0);

// 记忆过期时间：30 分钟（1800 秒）
const MEMORY_TTL = Number(process.env.MEMORY_TTL_SECONDS ?? 1800);

// Key 前缀和会话 ID
const KEY_PREFIX = process.env.MEMORY_KEY_PREFIX ?? "agent:short_memory";
const SESSION_ID = process.env.MEMORY_SESSION_ID ?? "demo_user_001";

// 摘要提示词：指导 LLM 如何压缩对话历史
const summaryPrompt = `你是对话摘要助手。请用中文总结以下对话，包含：
1. 讨论的主要话题
2. 用户提到的重要事实（姓名、偏好、日期等，务必保留原文信息）
3. 继续对话所需的关键上下文

保持简洁，不要编造，不要遗漏用户明确说过的信息。

待摘要的对话：
{messages}

摘要：`;

// ============================================
// 2. Redis 消息存储类
// ============================================

/**
 * RedisMessageStore
 *
 * 职责：管理 Agent 对话消息的持久化存储
 *
 * 流程：
 * 1. loadMessages: 从 Redis 加载历史消息
 * 2. saveMessages: 将新消息写回 Redis（带 TTL）
 * 3. clear: 清空指定会话的记忆
 * 4. ttl: 查看记忆剩余存活时间
 *
 * 关键细节：
 *  使用 JSON 序列化存储完整消息对象
 *   TTL 机制自动清理过期对话，避免内存泄漏
 *   Key 格式：{prefix}:{sessionId}:messages
 */
class RedisMessageStore {
  constructor({ redis, keyPrefix, ttlSeconds }) {
    this.redis = redis;
    this.keyPrefix = keyPrefix;
    this.ttlSeconds = ttlSeconds;
  }

  /**
   * 生成消息存储的 Key
   * @param sessionId 会话 ID
   * @returns Redis Key 字符串
   */
  messagesKey(sessionId) {
    return `${this.keyPrefix}:${sessionId}:messages`;
  }

  /**
   * 从 Redis 加载历史消息
   * @param sessionId 会话 ID
   * @returns ChatMessage[] 消息数组
   */
  async loadMessages(sessionId) {
    const raw = await this.redis.get(this.messagesKey(sessionId));
    if (!raw) return [];

    // 将存储格式转换为 ChatMessage 对象
    return mapStoredMessagesToChatMessages(JSON.parse(raw));
  }

  /**
   * 将消息保存到 Redis（带 TTL）
   * @param sessionId 会话 ID
   * @param messages 要保存的消息数组
   */
  async saveMessages(sessionId, messages) {
    // 将 ChatMessage 转换为可序列化的存储格式
    const payload = JSON.stringify(mapChatMessagesToStoredMessages(messages));
    await this.redis.set(
      this.messagesKey(sessionId),
      payload,
      "EX",
      this.ttlSeconds,
    );
  }

  /**
   * 清空指定会话的记忆
   * @param sessionId 会话 ID
   */
  async clear(sessionId) {
    await this.redis.del(this.messagesKey(sessionId));
  }

  /**
   * 获取记忆的剩余 TTL（秒）
   * @param sessionId 会话 ID
   * @returns TTL 秒数（-1 永不过期，-2 不存在）
   */
  async ttl(sessionId) {
    return this.redis.ttl(this.messagesKey(sessionId));
  }
}

// ============================================
// 3. 带记忆的 Agent 调用函数
// ============================================

/**
 * invokeWithMemory
 *
 * 职责：封装带记忆管理的 Agent 调用流程
 *
 * 流程：
 * 1. 从 Redis 加载历史消息
 * 2. 拼接历史消息 + 用户新消息
 * 3. 调用 Agent 执行推理
 * 4. 将完整消息历史写回 Redis
 *
 * @param agent LangChain Agent 实例
 * @param store RedisMessageStore 实例
 * @param sessionId 会话 ID
 * @param userText 用户输入文本
 * @returns Agent 执行结果（包含 messages）
 */
async function invokeWithMemory(agent, store, sessionId, userText) {
  // 1. 加载历史
  const history = await store.loadMessages(sessionId);
  console.log(`  ↳ 从 Redis 加载 ${history.length} 条历史`);

  // 2. 调用 Agent（拼接历史 + 新消息）
  const result = await agent.invoke(
    {
      messages: [...history, new HumanMessage(userText)],
    },
    { recursionLimit: 30 },
  );

  // 3. 保存完整消息历史到 Redis
  await store.saveMessages(sessionId, result.messages);

  const ttl = await store.ttl(sessionId);
  console.log(`  ↳ 写回 Redis ${result.messages.length} 条 (TTL ${ttl}s)`);

  return result;
}

// ============================================
// 4. 主程序入口
// ============================================

async function main() {
  // ----------------------------------------
  // 4.1 连接 Redis
  // ----------------------------------------
  const redis = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    db: REDIS_DB,
  });

  redis.on("connect", () => console.log("✅ Redis 已连接"));
  redis.on("error", (err) => console.error("❌ Redis 错误:", err.message));

  // ----------------------------------------
  // 4.2 创建消息存储实例
  // ----------------------------------------
  const store = new RedisMessageStore({
    redis,
    keyPrefix: KEY_PREFIX,
    ttlSeconds: MEMORY_TTL,
  });

  // ----------------------------------------
  // 4.3 创建 LLM 模型
  // ----------------------------------------
  const model = new ChatOpenAI({
    model: process.env.MODEL_NAME,
    apiKey: process.env.OPENAI_API_KEY,
    configuration: { baseURL: process.env.OPENAI_BASE_URL },
    temperature: 0,
  });

  // ----------------------------------------
  // 4.4 创建带记忆压缩的 Agent
  // ----------------------------------------
  const agent = createAgent({
    model,
    tools: [], // 本示例不需要工具
    systemPrompt:
      "你是会话助手。记住用户提到的关键事实，中文简短回答。若消息中有对话摘要，请据此继续对话。",
    middleware: [
      // summarizationMiddleware: 当消息数超过阈值时，自动压缩旧消息
      summarizationMiddleware({
        model,
        summaryPrompt,
        trigger: { messages: 8 }, // 当消息数 >= 8 时触发压缩
        keep: { messages: 4 }, // 保留最近 4 条消息
      }),
    ],
  });

  // ----------------------------------------
  // 4.5 交互式命令行
  // ----------------------------------------
  console.log("\n===========================================");
  console.log("  Redis 记忆对话系统已启动");
  console.log("  输入 exit / quit / :q 退出");
  console.log("  输入 :clear 清空当前会话记忆");
  console.log("===========================================\n");

  const rl = readline.createInterface({ input: stdin, output: stdout });
  let prevCount = (await store.loadMessages(SESSION_ID)).length;

  try {
    while (true) {
      const userText = (await rl.question("你: ")).trim();
      if (!userText) continue;

      // 退出命令
      if (["exit", "quit", ":q"].includes(userText.toLowerCase())) {
        break;
      }

      // 清空记忆
      if (userText === ":clear") {
        await store.clear(SESSION_ID);
        prevCount = 0;
        console.log("✅ 已清空当前会话记忆\n");
        continue;
      }

      // 调用 Agent（带记忆）
      const { messages } = await invokeWithMemory(
        agent,
        store,
        SESSION_ID,
        userText,
      );

      // 输出助手回复
      console.log("\n助手:", messages.at(-1)?.content);
      console.log(`当前消息数: ${messages.length}`);

      // 检测是否触发了压缩
      if (messages.length < prevCount + 2) {
        console.log("  ⚡ 已触发消息压缩（历史被摘要）");
      }

      prevCount = messages.length;
      console.log();
    }
  } finally {
    rl.close();
  }

  // 关闭 Redis 连接
  await redis.quit();
  console.log("\n👋 程序已退出");
}

main();
