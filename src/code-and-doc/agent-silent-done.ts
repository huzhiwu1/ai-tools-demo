/**
 * 文档 B：Agent 静默 done 排查（Silent Done 诊断）
 * ------------------------------------------------------------------
 * 知识点：Agent 收到消息后 2 秒 done、无文本事件、无 tool_start，前端显示
 *   "处理完成"——这是"静默 done"。根因可能在三层：LLM 层（真的没输出）、
 *   事件层（有输出但没被 stream 捕获）、提取层（有输出但提取逻辑漏了）。
 *
 * 场景：用户输入与工作流无关的"你好"，Agent 直接 done 无回复。
 *
 * 三步式教学：
 *   步骤 1：真实 LLM 直接问"你好"，打印完整响应——LLM 层到底输出了什么
 *   步骤 2：复现提取层缺陷——extractFinalContent 只认最后一条 ai 消息，
 *           最后一条是 tool 消息或 content 为空时兜底"处理完成"（掩盖真相）
 *   步骤 3：修复——空输出守卫，区分"有 reasoning / 有 tool_calls / 全空"，
 *           给出明确兜底，不再用"处理完成"糊弄
 *
 * 运行：cd ai-tools-demo && npx tsx src/code-and-doc/agent-silent-done.ts
 * 需要真实 LLM key（读 agent-coze-workflow/.env 的 LLM_* 网关配置）
 */

import "dotenv/config";
import * as dotenv from "dotenv";
import * as path from "node:path";
import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, SystemMessage, HumanMessage } from "@langchain/core/messages";

// 加载 agent-coze-workflow/.env（LLM 网关配置）
dotenv.config({ path: path.resolve(__dirname, "../../src/agent-coze-workflow/.env") });

const MODEL = process.env.LLM_MODEL ?? "deepseek-v4-flash";
const BASE_URL = process.env.LLM_BASE_URL ?? "https://llm.gw.dachensky.com/v1";
const API_KEY = process.env.LLM_API_KEY ?? "";

const llm = new ChatOpenAI({
  model: MODEL,
  apiKey: API_KEY,
  configuration: { baseURL: BASE_URL },
  temperature: 0.2,
  maxTokens: 2048,
});

/* ------------------------------------------------------------------ */
/* 步骤 1：LLM 层——直接问"你好"，看它到底输出了什么                      */
/* ------------------------------------------------------------------ */

async function step1() {
  console.log("========== 步骤 1：LLM 层——直接问「你好」 ==========");
  const res = await llm.invoke([new HumanMessage("你好")]);
  const content = res.content;
  const reasoning = (res as unknown as Record<string, unknown>)
    .additional_kwargs as Record<string, unknown> | undefined;
  const toolCalls = res.tool_calls;
  console.log("content 类型:", typeof content, "长度:", String(content).length);
  console.log("content 内容:", JSON.stringify(content).slice(0, 200));
  console.log("reasoning_content:", JSON.stringify(reasoning?.reasoning_content ?? null).slice(0, 100));
  console.log("tool_calls:", JSON.stringify(toolCalls ?? []).slice(0, 100));
  const empty = !String(content).trim() && (!toolCalls || toolCalls.length === 0);
  console.log("→ 判定：", empty ? "LLM 层静默（无正文无工具调用）" : "LLM 层正常（有输出）");
  console.log("");
  return res;
}

/* ------------------------------------------------------------------ */
/* 步骤 2：提取层——复现 extractFinalContent 的盲区                       */
/* ------------------------------------------------------------------ */

/** 缺陷版：只认最后一条 ai 消息的 content，取不到就兜底"处理完成" */
function extractFinalContentBuggy(stateValues: Record<string, unknown> | undefined): string {
  if (!stateValues) return "处理完成";
  const messages = stateValues.messages as Array<{ type?: string; content?: string }>;
  if (Array.isArray(messages) && messages.length > 0) {
    const lastMsg = messages[messages.length - 1];
    // 盲区 1：最后一条不是 ai（比如 tool 消息）→ 直接落兜底
    // 盲区 2：ai 消息 content 为空（reasoning 吃了预算 / 只调了工具）→ content 为 falsy → 落兜底
    if (lastMsg?.type === "ai" && lastMsg?.content) {
      return lastMsg.content;
    }
  }
  return "处理完成"; // ← "处理完成"掩盖了真实情况
}

/** 修复版：区分三种情况，返回诊断信息而不是糊弄 */
function extractFinalContentFixed(stateValues: Record<string, unknown> | undefined): {
  final: string;
  diagnosis: string;
} {
  if (!stateValues) return { final: "处理完成", diagnosis: "state 为空" };
  const messages = stateValues.messages as Array<{
    type?: string;
    content?: string;
    tool_calls?: unknown[];
    additional_kwargs?: Record<string, unknown>;
  }>;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { final: "处理完成", diagnosis: "messages 为空" };
  }

  // 从后往前找最后一条 ai 消息（而不是只看最后一条）
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type !== "ai") continue;
    if (m.content && String(m.content).trim()) {
      return { final: String(m.content), diagnosis: "正常" };
    }
    // ai 消息但 content 为空：区分两种情况
    if (m.tool_calls && m.tool_calls.length > 0) {
      return { final: "", diagnosis: `AI 只发起了 ${m.tool_calls.length} 个工具调用但无正文（正常流程）` };
    }
    const reasoning = m.additional_kwargs?.reasoning_content;
    if (reasoning) {
      return { final: "", diagnosis: "AI 只输出了 reasoning，正文为空（token 预算被思考吃掉）" };
    }
    return { final: "", diagnosis: "AI 消息完全为空（模型静默）" };
  }
  return { final: "处理完成", diagnosis: "历史里没有 ai 消息（最后一条是工具结果）" };
}

async function step2() {
  console.log("========== 步骤 2：提取层——extractFinalContent 的盲区 ==========");
  const cases: Array<{ name: string; state: Record<string, unknown> }> = [
    {
      name: "正常：最后一条 ai 有正文",
      state: { messages: [{ type: "ai", content: "工作流已生成" }] },
    },
    {
      name: "异常 A：最后一条是 tool 消息",
      state: {
        messages: [
          { type: "ai", content: "" },
          { type: "tool", content: "结果...", name: "slow_batch" },
        ],
      },
    },
    {
      name: "异常 B：ai 消息 content 为空但发起了工具调用",
      state: {
        messages: [
          { type: "ai", content: "", tool_calls: [{ name: "plan_workflow" }] },
        ],
      },
    },
    {
      name: "异常 C：ai 消息只有 reasoning 没有正文",
      state: {
        messages: [
          {
            type: "ai",
            content: "",
            additional_kwargs: { reasoning_content: "思考了很久..." },
          },
        ],
      },
    },
  ];
  for (const c of cases) {
    const buggy = extractFinalContentBuggy(c.state);
    const fixed = extractFinalContentFixed(c.state);
    console.log(`[${c.name}]`);
    console.log(`  缺陷版 → "${buggy}"`);
    console.log(`  修复版 → final="${fixed.final || "（空）"}" 诊断=${fixed.diagnosis}`);
  }
  console.log("");
}

/* ------------------------------------------------------------------ */
/* 步骤 3：完整链路——真实 Agent + 空输出守卫                              */
/* ------------------------------------------------------------------ */

import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { MemorySaver } from "@langchain/langgraph";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const dummyTool = tool(
  async ({ query }: { query: string }) => `模拟查询: ${query}`,
  {
    name: "query_workflow",
    description: "查询工作流信息",
    schema: z.object({ query: z.string() }),
  },
);

async function step3() {
  console.log("========== 步骤 3：完整链路——真实 Agent + 空输出守卫 ==========");
  const agent = createReactAgent({
    llm,
    tools: [dummyTool],
    checkpointer: new MemorySaver(),
    prompt: new SystemMessage(
      "你是工作流构建助手。只能处理工作流相关需求（生成/修改/验证工作流）。" +
        "与工作流无关的输入，直接简短说明你是做什么的，不要调用工具。",
    ),
    recursionLimit: 10,
  });

  const config = { configurable: { thread_id: "silent-demo" } };

  // 场景 1：无关输入"你好"
  console.log("--- 场景 1：输入「你好」（无关输入） ---");
  const state1 = await agent.invoke(
    { messages: [new HumanMessage("你好")] },
    config,
  );
  const r1 = extractFinalContentFixed(state1);
  console.log("state.messages 最后一条 type:", (state1.messages as unknown[]).at(-1)?.constructor.name);
  console.log(`最终消息 final="${r1.final.slice(0, 100) || "（空）"}" 诊断=${r1.diagnosis}`);

  // 场景 2：相关输入
  console.log("--- 场景 2：输入「查询工作流状态」（相关输入） ---");
  const state2 = await agent.invoke(
    { messages: [new HumanMessage("查询工作流状态")] },
    config,
  );
  const r2 = extractFinalContentFixed(state2);
  console.log(`最终消息 final="${r2.final.slice(0, 100) || "（空）"}" 诊断=${r2.diagnosis}`);
}

async function main() {
  if (!API_KEY) {
    console.log("❌ 未找到 LLM_API_KEY（agent-coze-workflow/.env），无法调用真实 LLM");
    process.exit(1);
  }
  await step1();
  await step2();
  await step3();
}

main().catch((e) => {
  console.error("执行失败:", e);
  process.exit(1);
});
