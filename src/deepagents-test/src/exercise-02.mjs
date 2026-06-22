/**
 * Exercise 02: Middleware 进阶 — wrapToolCall 与工具注入
 *
 * 学习目标：
 * 1. 掌握通过 Middleware 的 tools 字段注入工具
 * 2. 掌握 wrapToolCall 包装工具执行
 * 3. 理解 Command 的用法（在 wrapToolCall 中更新状态 + 返回消息）
 *
 * 运行方式：pnpm ex2
 */

import "dotenv/config";
import { Command } from "@langchain/langgraph";
import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import {
  createAgent,
  createMiddleware,
  HumanMessage,
  ToolMessage,
  tool,
} from "langchain";

// ============================================
// 第一步：定义工具
// ============================================

/**
 * [get_current_time]
 *
 * 职责：返回当前 UTC 时间的 ISO 8601 字符串
 *
 * 关键细节：
 * - 这个工具不是直接传给 createAgent 的 tools 数组
 * - 而是通过 Middleware 的 tools 字段注入
 * - 这是 DeepAgents 的核心能力：按需注入工具
 */
const getCurrentTime = tool(() => new Date().toISOString(), {
  name: "get_current_time",
  description: "返回当前 UTC 时间的 ISO 8601 字符串",
  schema: z.object({}),
});

// TODO: 定义一个计算平方的工具
// 提示：
// const square = tool(
//   ({ n }) => JSON.stringify({ n, result: n * n }),
//   {
//     name: "square",
//     description: "计算一个数的平方",
//     schema: z.object({
//       n: z.number().describe("要计算平方的数"),
//     }),
//   }
// );

// ============================================
// 第二步：创建 Middleware（注入工具 + 包装工具调用）
// ============================================

/**
 * [ExtendedToolsMiddleware]
 *
 * 职责：通过 Middleware 注入工具，并用 wrapToolCall 包装工具执行过程
 *
 * 流程：
 * 1. tools 字段注册了 getCurrentTime 工具
 * 2. wrapToolCall 在工具执行前后打印日志
 * 3. 工具执行后，用 ToolMessage 包装结果，并追加额外信息
 * 4. 用 Command 返回更新后的状态和消息
 *
 * 关键细节：
 * - wrapToolCall 的 request 包含 tool（工具实例）和 toolCall（调用参数）
 * - handler(request) 执行原始工具，返回 ToolMessage
 * - 如果要同时更新状态和返回消息，必须用 Command 包装
 * - Command({ update: { ... } }) 会合并到 Agent 的全局状态
 */
const extendedToolsMiddleware = createMiddleware({
  name: "ExtendedToolsMiddleware",

  stateSchema: z.object({
    toolInvocationCount: z.number().default(0),
  }),

  // 关键：通过 tools 字段注入工具
  // 即使 createAgent 时 tools 为空，Middleware 注入的工具也能被 LLM 使用
  tools: [getCurrentTime],

  // wrapToolCall: 包装工具的执行过程
  // 类似 wrapModelCall，但包装的是工具调用而非模型调用
  wrapToolCall: async (request, handler) => {
    // request.tool 是工具实例，request.toolCall 是调用参数
    const toolName = request.tool?.name ?? request.toolCall.name;
    console.log(
      `[Tools] 即将执行: ${toolName}`,
      "args:",
      request.toolCall.args ?? {},
    );

    // 调用原始 handler 执行工具
    const result = await handler(request);

    // 检查结果是否是 ToolMessage 实例
    if (!ToolMessage.isInstance(result)) return result;

    // 包装结果：在工具返回的内容后追加额外信息
    const wrapped = new ToolMessage({
      content: `${result.content}\n[wrapToolCall] 已由 ExtendedToolsMiddleware 包装`,
      tool_call_id: result.tool_call_id,
      name: result.name,
    });

    console.log(
      `[Tools] 执行完成: ${toolName}`,
      typeof wrapped.content === "string"
        ? wrapped.content.slice(0, 120)
        : wrapped,
    );

    // 关键：使用 Command 同时更新状态和返回消息
    // Command 是 LangGraph 的概念，用于在图中传递更新
    return new Command({
      update: {
        toolInvocationCount: request.state.toolInvocationCount + 1,
        messages: [wrapped],
      },
    });
  },

  afterAgent: (state) => {
    console.log(
      `[Tools] agent 结束，middleware 统计工具调用: ${state.toolInvocationCount} 次`,
    );
  },
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

// TODO: 尝试在 middleware 数组中添加另一个 Middleware
// 提示：你可以创建一个 LoggingMiddleware，在 beforeModel 和 afterModel 中打印日志
// 参考 Exercise 01 中的 loggingMiddleware

const agent = createAgent({
  model,
  tools: [], // 注意：tools 为空！工具由 Middleware 注入
  systemPrompt: "你是一个助手。",
  middleware: [extendedToolsMiddleware],
});

// ============================================
// 第四步：运行 Agent
// ============================================

console.log("\n用户: 给我当前时间");
const result = await agent.invoke({
  messages: [new HumanMessage("给我当前时间")],
});
console.log("回复:", result.messages.at(-1)?.content);
console.log("toolInvocationCount:", result.toolInvocationCount);

// TODO: 取消下面注释，测试你的 square 工具
// console.log("\n用户: 计算 7 的平方");
// const result2 = await agent.invoke({
//   messages: [new HumanMessage("计算 7 的平方")],
// });
// console.log("回复:", result2.messages.at(-1)?.content);

/**
 * 预期输出：
 *
 * 用户: 给我当前时间
 * [Tools] 即将执行: get_current_time args: {}
 * [Tools] 执行完成: get_current_time 2026-06-22T...Z
 *                               [wrapToolCall] 已由 ExtendedToolsMiddleware 包装
 * 回复: 当前 UTC 时间是 2026-06-22T...Z。（由 ExtendedToolsMiddleware 包装）
 * toolInvocationCount: 1
 *
 * 知识扩展：
 *
 * Q: 为什么用 Command 而不是直接返回 ToolMessage？
 * A: 因为 wrapToolCall 中如果只返回 ToolMessage，无法同时更新 state（如 toolInvocationCount）。
 *    Command 是 LangGraph 的机制，允许在一次返回中同时更新状态和消息。
 *    这就像 React 的 setState 既可以返回新状态，也可以返回副作用。
 */
