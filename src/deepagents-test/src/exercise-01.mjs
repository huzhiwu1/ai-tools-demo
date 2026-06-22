/**
 * Exercise 01: 基础 Agent + Middleware 入门
 *
 * 学习目标：
 * 1. 理解 createAgent 的基本用法
 * 2. 理解 createMiddleware 的 4 个生命周期钩子
 * 3. 理解 stateSchema 如何在 Middleware 间共享状态
 *
 * 运行方式：pnpm ex1
 */

import "dotenv/config";
import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import {
  createAgent,
  createMiddleware,
  HumanMessage,
  AIMessage,
} from "langchain";

// ============================================
// 第一步：创建自定义 Middleware
// ============================================

/**
 * [LoggingMiddleware]
 *
 * 职责：记录 Agent 执行过程的日志 + 统计模型调用次数
 *
 * 流程：
 * 1. beforeAgent: Agent 开始时，打印当前消息数
 * 2. beforeModel: 每次调用模型前，打印即将调用的信息
 * 3. afterModel: 模型返回后，打印输出预览，并累加调用次数
 * 4. afterAgent: Agent 结束时，打印累计调用次数
 *
 * 关键细节：
 * - stateSchema 定义了 Middleware 自身的状态（modelCallCount）
 * - afterModel 返回 { modelCallCount: state.modelCallCount + 1 } 来更新状态
 * - Middleware 的状态会自动合并到 Agent 的全局状态中
 */
const loggingMiddleware = createMiddleware({
  name: "LoggingMiddleware",

  // 定义 Middleware 的自定义状态
  // stateSchema 中的字段会自动成为 Agent invoke 返回值的一部分
  stateSchema: z.object({
    modelCallCount: z.number().default(0),
  }),

  // 钩子 1：Agent 循环开始前
  beforeAgent: (state) => {
    console.log("\n[Logging] agent 开始，消息数:", state.messages.length);
  },

  // 钩子 2：每次调用 LLM 前
  beforeModel: (state) => {
    console.log(
      `[Logging] 即将调用模型，当前消息数: ${state.messages.length}，已调用: ${state.modelCallCount} 次`,
    );
  },

  // 钩子 3：每次调用 LLM 后
  // 返回一个对象来更新 stateSchema 中定义的状态
  afterModel: (state) => {
    const last = state.messages.at(-1);
    const preview =
      typeof last?.content === "string"
        ? last.content.slice(0, 80)
        : JSON.stringify(last?.content)?.slice(0, 80);
    console.log(`[Logging] 模型返回: ${preview}...`);
    // 关键：通过返回对象来更新状态
    return { modelCallCount: state.modelCallCount + 1 };
  },

  // 钩子 4：Agent 循环结束后
  afterAgent: (state) => {
    console.log(
      `[Logging] agent 结束，累计模型调用: ${state.modelCallCount} 次\n`,
    );
  },
});

/**
 * [AddContextMiddleware]
 *
 * 职责：在每次模型调用前，向 systemMessage 追加额外指令
 *
 * 关键细节：
 * - wrapModelCall 是"包装"模式，可以修改 request 和 response
 * - request 包含 systemMessage、messages 等
 * - handler(request) 是实际的模型调用，必须调用它才能让模型执行
 * - 你可以在 handler 前后插入自己的逻辑
 */
const addContextMiddleware = createMiddleware({
  name: "AddContextMiddleware",

  // wrapModelCall: 包装模型调用
  // 参数 request: 模型调用的请求（包含 systemMessage 等）
  // 参数 handler: 实际执行模型调用的函数
  wrapModelCall: async (request, handler) => {
    console.log("[AddContext] 注入额外 system 上下文");
    // 修改 systemMessage，追加指令
    const modifiedRequest = {
      ...request,
      systemMessage: request.systemMessage.concat("\n\n 请用一句话简洁回答。"),
    };
    // 调用原始 handler，传入修改后的 request
    return handler(modifiedRequest);
  },
});

// ============================================
// 第二步：TODO — 创建一个拦截敏感词的 Middleware
// ============================================

/**
 * [BlockedContentMiddleware]
 *
 * 职责：检测用户消息中的敏感词，如果发现则直接结束 Agent
 *
 * 流程：
 * 1. 在 beforeModel 中检查最后一条消息
 * 2. 如果包含 "BLOCKED" 关键词，返回一条 AIMessage 并跳转到 "end"
 * 3. 如果不包含，正常继续
 *
 * 关键细节：
 * - beforeModel 可以返回 { jumpTo: "end" } 来提前结束 Agent 循环
 * - canJumpTo 声明了这个钩子可以跳转到哪些节点
 * - 跳转到 "end" 相当于"短路"，不再调用模型，直接返回
 */
const blockedContentMiddleware = createMiddleware({
  name: "BlockedContentMiddleware",

  // TODO: 补全 beforeModel 钩子
  // 提示：
  // 1. beforeModel 需要声明 canJumpTo: ["end"]
  // 2. 在 hook 函数中，从 state.messages 获取最后一条消息
  // 3. 检查消息内容是否包含 "BLOCKED"
  // 4. 如果包含，返回 { messages: [new AIMessage("该请求已被 middleware 拦截，无法处理。")], jumpTo: "end" }
  //
  // 参考格式：
  // beforeModel: {
  //   canJumpTo: ["end"],
  //   hook: (state) => {
  //     const last = state.messages.at(-1);
  //     const text = typeof last?.content === "string" ? last.content : String(last?.content ?? "");
  //     if (text.includes("BLOCKED")) {
  //       console.log("[Blocked] 检测到 BLOCKED，短路结束");
  //       return {
  //         messages: [new AIMessage("该请求已被 middleware 拦截，无法处理。")],
  //         jumpTo: "end",
  //       };
  //     }
  //   },
  // },

  beforeModel: {},
});

// ============================================
// 第三步：创建 Agent
// ============================================

const model = new ChatOpenAI({
  model: process.env.MODEL_NAME,
  apiKey: process.env.OPENAI_API_KEY,
  configuration: {
    baseURL: process.env.OPENAI_BASE_URL,
  },
  temperature: 0,
});

// TODO: 在 middleware 数组中添加 blockedContentMiddleware
// 提示：middleware 数组中的顺序很重要！
// - loggingMiddleware 应该在最外层（第一个）
// - addContextMiddleware 在中间
// - blockedContentMiddleware 在最内层（最后一个）
const agent = createAgent({
  model,
  tools: [],
  systemPrompt: "你是一个助手。",
  middleware: [
    loggingMiddleware,
    addContextMiddleware,
    // TODO: 在这里添加 blockedContentMiddleware
  ],
});

// ============================================
// 第四步：运行 Agent
// ============================================

// 测试用例 1：正常提问
console.log("\n用户: 用中文说：middleware 是什么？");
const result1 = await agent.invoke({
  messages: [new HumanMessage("用中文说：middleware 是什么？")],
});
console.log("回复:", result1.messages.at(-1)?.content);
console.log("modelCallCount:", result1.modelCallCount);

// 测试用例 2：包含敏感词（被拦截）
console.log("\n用户: 这句话包含 BLOCKED 关键词");
const result2 = await agent.invoke({
  messages: [new HumanMessage("这句话包含 BLOCKED 关键词")],
});
console.log("回复:", result2.messages.at(-1)?.content);
console.log("modelCallCount:", result2.modelCallCount);

/**
 * 预期输出：
 *
 * 用户: 用中文说：middleware 是什么？
 * [Logging] agent 开始，消息数: 1
 * [Logging] 即将调用模型，当前消息数: 1，已调用: 0 次
 * [AddContext] 注入额外 system 上下文
 * [Logging] 模型返回: Middleware（中间件）是一种软件设计模式，...
 * [Logging] agent 结束，累计模型调用: 1 次
 * 回复: Middleware（中间件）是一种软件设计模式，...
 * modelCallCount: 1
 *
 * 用户: 这句话包含 BLOCKED 关键词
 * [Blocked] 检测到 BLOCKED，短路结束
 * 回复: 该请求已被 middleware 拦截，无法处理。
 * modelCallCount: 0  （被拦截，模型未被调用）
 */
