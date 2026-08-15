/**
 * 实战：从零搭一个带会话的流式聊天服务
 * ------------------------------------------------------------------
 * 不依赖任何框架，一个 Node HTTP server + 原生 fetch 调 DeepSeek：
 *   - POST /chat { sessionId, message } → SSE 流式返回
 *   - 会话管理：Map 存历史，多轮对话自动拼接上下文
 *   - 上下文截断：只保留系统提示 + 最近 6 轮，防止历史无限膨胀
 *   - 超时：模型调用 30s 无响应 → 发 error 事件 → 断流
 *   - 停止：客户端断开（req close）→ abort 模型请求，不再烧 token
 *   - 协议：0:"text" / d:{...} / e:{...}（与文章一致）
 *
 * 运行：cd ai-tools-demo && source ~/.zshrc && npx tsx src/code-and-doc/chat-server-demo.ts
 * 另开终端测试：
 *   curl -N -X POST http://127.0.0.1:8787/chat -H "Content-Type: application/json" \
 *     -d '{"sessionId":"s1","message":"我叫小明"}'
 *   curl -N -X POST http://127.0.0.1:8787/chat -H "Content-Type: application/json" \
 *     -d '{"sessionId":"s1","message":"我叫什么名字？"}'
 */
import http from "node:http";

const API = "https://api.deepseek.com/v1";
const KEY = process.env.DEEPSEEK_API_KEY ?? "";
const PORT = 8787;
const MAX_ROUNDS = 6; // 上下文截断：保留最近 N 轮对话
const MODEL_TIMEOUT_MS = 30_000;

// ── 会话存储：sessionId → 消息历史 ──────────────────────────────────
const sessions = new Map<string, Array<Record<string, unknown>>>();

function getSession(sessionId: string): Array<Record<string, unknown>> {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, [
      { role: "system", content: "你是聊天助手。回答要简洁，用中文。" },
    ]);
  }
  return sessions.get(sessionId)!;
}

// ── 上下文截断：系统提示 + 最近 MAX_ROUNDS 轮 ───────────────────────
function trimHistory(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const system = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  const tail = rest.slice(-MAX_ROUNDS * 2); // 每轮 = user + assistant 两条
  return [...system, ...tail];
}

// ── 流式调模型：onDelta 回调 + AbortSignal 支持超时/停止 ────────────
async function streamChat(
  messages: Array<Record<string, unknown>>,
  onDelta: (text: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      messages,
      stream: true,
      temperature: 0.7,
    }),
    signal, // 超时/客户端断开时中止
  });
  if (!res.ok || !res.body) {
    throw new Error(`模型接口 ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
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
      const delta = json.choices?.[0]?.delta?.content ?? "";
      if (delta) onDelta(delta);
    }
  }
}

// ── HTTP 服务 ───────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/chat") {
    res.writeHead(404).end();
    return;
  }

  // 读请求体
  let body = "";
  for await (const chunk of req) body += chunk;
  let sessionId = "default";
  let message = "";
  try {
    const parsed = JSON.parse(body);
    sessionId = parsed.sessionId ?? "default";
    message = String(parsed.message ?? "");
  } catch {
    res.writeHead(400).end("bad json");
    return;
  }
  if (!message) {
    res.writeHead(400).end("message required");
    return;
  }

  // SSE 响应头
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // 会话：追加用户消息 → 截断 → 流式
  const history = getSession(sessionId);
  history.push({ role: "user", content: message });
  const trimmed = trimHistory(history);

  // 超时控制器：30s 无响应就 abort（AbortSignal.timeout 由 Node 18+ 提供）
  const timeout = setTimeout(() => {
    res.write(`d:${JSON.stringify({ type: "error", message: "模型响应超时" })}\n`);
    res.write(`e:${JSON.stringify({ type: "done" })}\n`);
    res.end();
  }, MODEL_TIMEOUT_MS);

  // 客户端断开（点了停止/关页面）→ 中止模型请求
  const abortController = new AbortController();
  req.on("close", () => abortController.abort());

  try {
    let full = "";
    await streamChat(
      trimmed,
      (delta) => {
        full += delta;
        res.write(`0:${JSON.stringify(delta)}\n`); // 文本增量
      },
      abortController.signal,
    );
    clearTimeout(timeout);
    history.push({ role: "assistant", content: full }); // 记入历史，供下一轮用
    res.write(`e:${JSON.stringify({ type: "done" })}\n`);
    res.end();
  } catch (err) {
    clearTimeout(timeout);
    const msg = (err as Error).message;
    // 区分"主动停止"和"真错误"：停止不写 error，只是断流
    if (abortController.signal.aborted) {
      res.end();
    } else {
      res.write(`d:${JSON.stringify({ type: "error", message: msg })}\n`);
      res.write(`e:${JSON.stringify({ type: "done" })}\n`);
      res.end();
    }
  }
});

server.listen(PORT, () => {
  console.log(`聊天服务已启动: http://127.0.0.1:${PORT}/chat`);
  console.log(`测试: curl -N -X POST http://127.0.0.1:${PORT}/chat -H "Content-Type: application/json" -d '{"sessionId":"s1","message":"hi"}'`);
});
