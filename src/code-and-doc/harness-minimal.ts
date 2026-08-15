/**
 * Harness 最小实现：用 LangGraph createReactAgent 搭一个嵌入式 harness
 * ------------------------------------------------------------------
 * 知识点：Model + Harness = Agent。harness = 模型之外让 AI 能落地执行
 *   的整套基础设施。这里用 createReactAgent 演示"嵌入式 harness"
 *   的最小形态：模型 + 工具集 + 自动循环（LLM 发起 tool call → 工具
 *   执行 → 结果回填 → LLM 再决策 → 输出最终答案）。
 *
 * 对照实验：同一个问题（"计算 42 * 8"）分别跑 DeepSeek Harness（dsh
 *   headless，插件化工作台形态）和本脚本（LangGraph 嵌入式 harness），
 *   两个都能拿到答案，但 harness 的形态、扩展方式完全不同。
 *
 * 运行：cd ai-tools-demo && npx tsx src/code-and-doc/harness-minimal.ts
 * 需要真实 LLM key（读 agent-coze-workflow/.env 的 LLM_* 网关配置）
 */

import "dotenv/config";
import * as dotenv from "dotenv";
import * as path from "node:path";
import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

// 加载 agent-coze-workflow/.env（LLM 网关配置）
dotenv.config({ path: path.resolve(__dirname, "../../src/agent-coze-workflow/.env") });

// ── 工具 1：计算器 ────────────────────────────────────────────────
// 每个工具 = 名称 + 描述 + JSON Schema 参数 + 执行函数。
// 描述和 Schema 会拼进 system prompt，模型据此决定"什么时候调、传什么参"。
const calculator = tool(
  async ({ expression }: { expression: string }) => {
    // 白名单校验：只允许数字和运算符，防止把任意代码喂给 Function
    if (!/^[\d+\-*/().\s]+$/.test(expression)) {
      return "非法表达式：只支持数字和 + - * / ( )";
    }
    // eslint-disable-next-line no-new-func
    const result = Function(`"use strict"; return (${expression})`)();
    return String(result);
  },
  {
    name: "calculator",
    description: "计算一个数学表达式并返回结果，例如 42 * 8",
    schema: z.object({
      expression: z.string().describe("数学表达式，只含数字和运算符"),
    }),
  },
);

// ── 工具 2：当前时间 ──────────────────────────────────────────────
const currentTime = tool(
  async () => new Date().toISOString(),
  {
    name: "current_time",
    description: "返回当前 UTC 时间（ISO 8601 字符串）",
    schema: z.object({}),
  },
);

async function main() {
  // 模型层：deepseek-v4-flash（经网关，OpenAI 兼容协议）
  const model = new ChatOpenAI({
    model: process.env.LLM_MODEL ?? "deepseek-v4-flash",
    apiKey: process.env.LLM_API_KEY,
    baseURL: process.env.LLM_BASE_URL,
    temperature: 0,
  });

  // 这就是"嵌入式 harness"的最小形态：模型 + 工具 + 自动循环。
  // createReactAgent 内置 ReAct 循环：LLM → (tool_calls?) → 执行 → 回填 → 再 LLM
  const agent = createReactAgent({
    llm: model,
    tools: [calculator, currentTime],
  });

  const question = "计算 42 * 8 并告诉我结果";
  console.log("问题:", question);

  // 用 streamMode: "updates" 观察循环每一步（这是 harness 循环的可观测性）
  const stream = await agent.stream(
    { messages: [new HumanMessage(question)] },
    { streamMode: "updates" },
  );

  for await (const update of stream) {
    for (const [node, value] of Object.entries(update)) {
      const msg = value.messages?.[value.messages.length - 1];
      if (!msg) continue;
      if (node === "agent") {
        const calls = msg.tool_calls ?? [];
        console.log(
          `\n[agent] 模型决策: ${calls.length > 0 ? `发起工具调用 → ${calls.map((t: { name: string }) => t.name).join(", ")}` : "直接回答（循环结束）"}`,
        );
        if (calls.length > 0) {
          console.log(`        参数: ${JSON.stringify(calls[0].args)}`);
        }
      } else if (node === "tools") {
        console.log(`[tools] ${msg.name} 返回: ${msg.content}`);
      }
    }
  }

  // 取最终答案（最后一次 invoke 的最后一条消息）
  const final = await agent.invoke({ messages: [new HumanMessage(question)] });
  const last = final.messages[final.messages.length - 1];
  console.log("\n最终答案:", last.content);
}

main().catch((err) => {
  console.error("运行失败:", err);
  process.exit(1);
});
