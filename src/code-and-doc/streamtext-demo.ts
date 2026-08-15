/**
 * 文档 5：Vercel AI SDK 流式输出（React 前端视角）
 * ------------------------------------------------------------------
 * 知识点：Vercel AI SDK 把"LLM 流式响应 → React 组件渲染"变成标准化的
 *   useChat / streamText 流程，前端不用手写 SSE 解析。
 *
 * 演示场景：React 聊天框 → 后端 streamText → 前端 useChat 流式渲染。
 *
 * 两步式教学（本文件是可运行的 Node 脚本，演示流式消费核心）：
 *   坏例子：手写 fetch + 解析 SSE → 必须等全部收完才渲染（卡顿），
 *           且把协议标记 [DONE] 混进正文（顺序/内容错乱）
 *   好例子：AI SDK streamText + textStream 逐 token 渲染；
 *           未安装 ai 包时自动降级为 LangChain 原生 stream()（等价消费方式）
 *
 * 需要真实 LLM 时设置 OPENAI_API_KEY（或 DEEPSEEK_API_KEY 走兼容接口）。
 * 没有 key 时使用 mock 流演示同样的"解析/渲染"差异。
 * 安装真实依赖：npm i ai @ai-sdk/langchain（本机 npm 若离线会自动走降级路径）
 *
 * 运行：npx tsx src/code-and-doc/streamtext-demo.ts
 */

import { ChatOpenAI } from "@langchain/openai";

/* ------------------------------------------------------------------ */
/* 1. 模型与 mock 流                                                     */
/* ------------------------------------------------------------------ */

// 创建真实模型：优先 OPENAI_API_KEY，其次 DEEPSEEK_API_KEY（OpenAI 兼容）。
// 都没有 → 返回 null，后续走 mock 流。
function createModel(): ChatOpenAI | null {
  const openaiKey = process.env.OPENAI_API_KEY;
  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  if (openaiKey) {
    return new ChatOpenAI({
      model: "gpt-4o-mini",
      apiKey: openaiKey,
      temperature: 0,
      maxRetries: 0,
      configuration: { timeout: 8000 },
    });
  }
  if (deepseekKey) {
    return new ChatOpenAI({
      model: "deepseek-chat",
      apiKey: deepseekKey,
      temperature: 0,
      maxRetries: 0,
      configuration: { baseURL: "https://api.deepseek.com", timeout: 8000 },
    });
  }
  return null;
}

// mock 流：没有 API key 时，模拟 LLM 逐 token 吐字
async function* mockTokenStream(text: string, delayMs = 40): AsyncGenerator<string> {
  for (const token of text.split("")) {
    await new Promise((r) => setTimeout(r, delayMs));
    yield token;
  }
}

// 模拟后端 SSE 事件流（坏例子里手写解析的对象）
function simulateSSEEvents(): { data: string }[] {
  return [
    { data: '{"type":"text-delta","text":"你好"}' },
    { data: '{"type":"text-delta","text":"，我是"}' },
    { data: '{"type":"text-delta","text":"AI 客服。"}' },
    { data: "[DONE]" }, // SSE 结束标记
  ];
}

/* ------------------------------------------------------------------ */
/* 2. 坏例子：手写 fetch + SSE 解析                                      */
/* ------------------------------------------------------------------ */

// 新手最常见的两个错误：
//   ① 用 await res.text() 一次性读完 → 必须等整段生成完才渲染 → 前端"卡顿"
//   ② 把 data: 行当正文直接 join，连 [DONE] 结束标记也拼进去 → 内容错乱
async function badExample() {
  console.log("========== 坏例子：手写 fetch + 解析 SSE ==========");

  const events = simulateSSEEvents();
  // 模拟 fetch：一次性把响应体读完（错误①）
  const rawText = events.map((e) => `data: ${e.data}\n\n`).join("");
  console.log("原始 SSE 报文：");
  console.log(JSON.stringify(rawText));

  // 新手解析（错误②）：拆行 → 取 data: 后面的内容 → 直接拼起来
  const parsed = rawText
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.replace("data:", "").trim())
    .join("");

  console.log("前端渲染结果：", JSON.stringify(parsed));
  console.log(
    "→ 问题 1：res.text() 等全部生成完才返回，用户看到的是'卡顿后突然整段出现'；\n" +
      "→ 问题 2：[DONE] 结束标记混进正文，且没有增量渲染、无法中途停止。\n",
  );
}

/* ------------------------------------------------------------------ */
/* 3. 好例子：streamText + textStream（增量渲染）                         */
/* ------------------------------------------------------------------ */

async function consumeTokenStream(stream: AsyncGenerator<string, void, unknown>) {
  const pieces: string[] = [];
  for await (const token of stream) {
    pieces.push(token);
    process.stdout.write(token); // 逐 token 输出，模拟前端逐字渲染
  }
  process.stdout.write("\n");
  return pieces.join("");
}

async function goodExample() {
  console.log("========== 好例子：AI SDK streamText 增量渲染 ==========");
  const model = createModel();

  // 优先尝试真实 AI SDK：npm i ai @ai-sdk/langchain 后走这条路径
  try {
    const ai = (await import("ai")) as typeof import("ai");
    const langchainAdapter = (await import("@ai-sdk/langchain")) as typeof import("@ai-sdk/langchain");
    const result = ai.streamText({
      model: langchainAdapter.createLangChainAdapter(model as ChatOpenAI),
      prompt: "用一句话介绍你自己",
    });
    console.log("（真实 AI SDK streamText，逐 token 渲染）");
    await consumeTokenStream(result.textStream as unknown as AsyncGenerator<string, void, unknown>);
    console.log("");
    return;
  } catch (err) {
    const msg = (err as Error).message;
    const missingAi = msg.includes("Cannot find module") || msg.includes("Cannot find package");
    console.log(
      missingAi
        ? "（ai / @ai-sdk/langchain 未安装，降级演示：用 LangChain 原生 stream() 消费，等价逐 token 渲染）"
        : `（streamText 调用失败，降级演示：${msg}）`,
    );
  }

  // 降级路径 1：有 key 时用 ChatOpenAI.stream() —— AI SDK 底层也是这么消费增量
  if (model) {
    try {
      console.log("（真实模型 ChatOpenAI.stream() 增量输出）");
      const stream = await model.stream("用一句话介绍你自己");
      await consumeTokenStream((async function* () {
        for await (const chunk of stream) {
          yield chunk.text ?? "";
        }
      })());
      console.log("");
      return;
    } catch (err) {
      console.log(`（真实模型调用失败：${(err as Error).message}，改用 mock 流）`);
    }
  }

  // 降级路径 2：无 key 或网络失败 → mock 流，演示的仍是"逐 token 渲染"机制
  console.log("（mock 流，逐 token 渲染，无真实 API）");
  await consumeTokenStream(mockTokenStream("你好，我是 AI 客服。"));
  console.log("");
}

/* ------------------------------------------------------------------ */
/* 4. 前端 useChat 与后端路由（React 代码片段，供复制到项目里）             */
/* ------------------------------------------------------------------ */

const FRONTEND_SNIPPET = `
"use client"; // Next.js App Router 组件
import { useChat } from "@ai-sdk/react"; // AI SDK v5；v4 请用 "ai/react"

export default function Chat() {
  // useChat 内部替你完成了：fetch 流式请求、SSE 解析、消息数组维护
  const { messages, input, setInput, handleSubmit, isLoading, stop } = useChat({
    api: "/api/chat",
  });

  return (
    <div>
      {messages.map((m) => (
        <p key={m.id}>
          <b>{m.role === "user" ? "我" : "AI"}：</b>
          {m.content} {/* content 会随着流式响应逐字更新 */}
        </p>
      ))}
      <form onSubmit={handleSubmit}>
        <input value={input} onChange={(e) => setInput(e.target.value)} />
        <button disabled={isLoading}>发送</button>
        {isLoading && <button onClick={stop}>停止生成</button>}
      </form>
    </div>
  );
}
`;

const BACKEND_SNIPPET = `
// app/api/chat/route.ts（Next.js App Router）
import { streamText } from "ai";
import { createLangChainAdapter } from "@ai-sdk/langchain";
import { ChatOpenAI } from "@langchain/openai";

const model = new ChatOpenAI({ model: "gpt-4o-mini", apiKey: process.env.OPENAI_API_KEY });

export async function POST(req: Request) {
  const { messages } = await req.json();
  const result = streamText({
    model: createLangChainAdapter(model),
    messages, // 直接透传 useChat 维护的 messages
  });
  // 返回 AI SDK 标准数据流协议，useChat 开箱即用
  return result.toUIMessageStreamResponse();
}
`;

function showReactSnippets() {
  console.log("========== React 端代码（useChat + streamText 标准链路） ==========");
  console.log("【后端 app/api/chat/route.ts】");
  console.log(BACKEND_SNIPPET);
  console.log("【前端组件（useChat）】");
  console.log(FRONTEND_SNIPPET);
  console.log(
    "→ 前端不再关心 SSE 解析：useChat 处理增量渲染、isLoading、stop()；\n" +
      "  后端 streamText 处理流式协议，两边都是标准件。\n",
  );
}

/* ------------------------------------------------------------------ */
/* 5. main                                                             */
/* ------------------------------------------------------------------ */

async function main() {
  await badExample();
  await goodExample();
  showReactSnippets();

  console.log("========== 结论 ==========");
  console.log(
    "流式输出的正确姿势：\n" +
      "  1. 后端用 ai 包 streamText（可接 LangChain 模型）返回标准数据流；\n" +
      "  2. 前端用 useChat 消费，messages 逐字更新、stop() 随时中断；\n" +
      "  3. 手写 SSE 解析能跑，但协议细节（[DONE]、多行 data、断连重试）\n" +
      "     会持续消耗你，交给 AI SDK 这类标准库才是工程选择。",
  );
}

main().catch((err) => {
  console.error("main 执行失败：", err);
  process.exitCode = 1;
});
