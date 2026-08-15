/**
 * 手写最小 Harness 循环（raw fetch 版）
 * ------------------------------------------------------------------
 * 展示 agent loop 的底层机制，不依赖任何框架：
 *   系统提示 + 工具 schema → LLM → 返回 tool_calls → 执行工具 →
 *   把工具结果回填为 tool 消息 → 再调 LLM → 直到模型不再调用工具。
 * 这就是"嵌入式 harness"的骨架，LangGraph createReactAgent 干的
 * 就是这件事（外加状态管理、checkpoint、流式等增强）。
 *
 * 运行：cd ai-tools-demo && npx tsx src/code-and-doc/harness-loop-fetch.ts
 * 需要 LLM key：export LLM_API_KEY=sk-... LLM_BASE_URL=https://api.deepseek.com/v1
 * 或直接复用 ~/.zshrc 的 DEEPSEEK_API_KEY（脚本自动回退）。
 */

const API = process.env.LLM_BASE_URL ?? "https://api.deepseek.com/v1";
const KEY = process.env.LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY;
if (!KEY) {
  console.error("缺少 LLM key：export LLM_API_KEY=sk-...");
  process.exit(1);
}

// ── 工具 schema：模型看到的"能力清单" ─────────────────────────────
// 描述和 parameters 会拼进请求，模型据此决定"什么时候调、传什么参"。
const TOOLS = [
  {
    type: "function",
    function: {
      name: "calculator",
      description: "计算一个数学表达式并返回结果，例如 42 * 8",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "数学表达式，只含数字和运算符" },
        },
        required: ["expression"],
      },
    },
  },
];

// ── LLM 调用：一次请求 = 完整消息历史 + 工具清单 ──────────────────
async function callLLM(messages: unknown[]) {
  const res = await fetch(`${API}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      messages,
      tools: TOOLS,
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as {
    choices: Array<{ message: { content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
  };
  return data.choices[0].message;
}

// ── 工具执行：模型只声明"想调用什么"，真正干活的是这段代码 ────────
function runTool(name: string, argsText: string): string {
  if (name === "calculator") {
    const { expression } = JSON.parse(argsText) as { expression: string };
    if (!/^[\d+\-*/().\s]+$/.test(expression)) return "非法表达式";
    // eslint-disable-next-line no-new-func
    return String(Function(`"use strict"; return (${expression})`)());
  }
  return "未知工具";
}

async function main() {
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: "你是计算助手。遇到计算必须调用 calculator 工具，不要自己口算。" },
    { role: "user", content: "计算 42 * 8" },
  ];

  let round = 0;
  while (round < 5) {
    round++;
    const msg = await callLLM(messages);
    console.log(`\n=== 第 ${round} 轮 ===`);
    console.log("模型输出:", msg.content ?? "(无正文)");

    const toolCalls = msg.tool_calls ?? [];
    // 回填 assistant 消息（含 tool_calls），这是协议要求：tool 消息必须跟在它后面
    messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: toolCalls });

    if (toolCalls.length === 0) {
      console.log("没有工具调用 → 循环结束");
      break;
    }

    for (const tc of toolCalls) {
      console.log(`工具调用: ${tc.function.name}(${tc.function.arguments})`);
      const result = runTool(tc.function.name, tc.function.arguments);
      console.log(`工具返回: ${result}`);
      // tool 消息通过 tool_call_id 关联到对应的 assistant 调用
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
  }

  const last = messages[messages.length - 1];
  console.log("\n最终回答:", typeof last.content === "string" ? last.content : JSON.stringify(last.content));
}

main().catch((e) => {
  console.error("运行失败:", e.message);
  process.exit(1);
});
