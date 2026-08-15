/**
 * Agent 多通道流式实验：文本 + 思考 + 工具事件 → Data Stream 协议编码
 * ------------------------------------------------------------------
 * 真实项目（ai-tools-demo react-agent.service.ts）的后端协议：
 *   - 0:"text"    → LLM 文本增量（前端 useChat 自动拼接）
 *   - d:{...}     → 结构化事件（tool_start / tool_end / reasoning_delta / done）
 *   - e:{...}     → 流结束标记
 * 本脚本用原生 fetch + 手写 agent 循环，真实跑一遍"协议行是怎么产生的"。
 *
 * 运行：cd ai-tools-demo && source ~/.zshrc && npx tsx src/code-and-doc/data-stream-demo.ts
 */

const API = "https://api.deepseek.com/v1";
const KEY = process.env.DEEPSEEK_API_KEY ?? "";
if (!KEY) {
  console.error("缺少 DEEPSEEK_API_KEY");
  process.exit(1);
}

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

// 流式请求一次，返回：完整消息 + 工具调用列表；事件通过 onEvent 实时吐出
async function streamChat(
  messages: Array<Record<string, unknown>>,
  onEvent: (line: string) => void,
): Promise<{ msg: Record<string, unknown>; calls: Array<{ id: string; name: string; args: string }> }> {
  const res = await fetch(`${API}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      messages,
      tools: TOOLS,
      stream: true, // 流式模式：模型边生成边推送
      temperature: 0,
    }),
  });

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  // 工具调用是分块到达的（每块带 index），按 index 累积拼接
  const toolCalls: Record<number, { id: string; name: string; args: string }> = {};

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      const json = JSON.parse(payload);
      const delta = json.choices?.[0]?.delta ?? {};

      // 1. 思考增量 → d:{"type":"reasoning_delta"}
      if (delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        onEvent(`d:${JSON.stringify({ type: "reasoning_delta", content: delta.reasoning_content })}`);
      }
      // 2. 正文增量 → 0:"文本"
      if (delta.content) {
        content += delta.content;
        onEvent(`0:${JSON.stringify(delta.content)}`);
      }
      // 3. 工具调用增量 → 按 index 累积
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        toolCalls[idx] ??= { id: "", name: "", args: "" };
        if (tc.id) toolCalls[idx].id = tc.id;
        if (tc.function?.name) toolCalls[idx].name += tc.function.name;
        if (tc.function?.arguments) toolCalls[idx].args += tc.function.arguments;
      }
    }
  }

  const calls = Object.values(toolCalls).filter((c) => c.name);
  return {
    msg: {
      role: "assistant",
      content,
      // 回填历史必须用 API 标准格式：type + function 包装
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.args },
      })),
    },
    calls,
  };
}

async function main() {
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: "你是计算助手。遇到计算必须调用 calculator 工具，不要自己口算。" },
    { role: "user", content: "计算 42 * 8" },
  ];

  console.log("========== 第 1 轮：模型思考 + 发起工具调用 ==========");
  const round1 = await streamChat(messages, (line) => console.log(line));
  messages.push(round1.msg);

  if (round1.calls.length === 0) {
    console.log("（模型直接回答了，没有工具调用）");
    return;
  }

  // 执行工具，输出 tool_start / tool_end 事件
  console.log(`d:${JSON.stringify({ type: "tool_start", name: "calculator", input: JSON.parse(round1.calls[0].args) })}`);
  const { expression } = JSON.parse(round1.calls[0].args);
  const result = String(Function('"use strict"; return (' + expression + ')')());
  console.log(`d:${JSON.stringify({ type: "tool_end", name: "calculator", output: result })}`);

  // 工具结果回填，第二轮
  messages.push({ role: "tool", tool_call_id: round1.calls[0].id, content: result });
  console.log("\n========== 第 2 轮：基于工具结果回答 ==========");
  const round2 = await streamChat(messages, (line) => console.log(line));
  console.log(`e:${JSON.stringify({ type: "done" })}`);
  console.log("\n最终回答:", round2.msg.content);
}

main().catch((e) => {
  console.error("运行失败:", e.message);
  process.exit(1);
});
