/**
 * test-interrupt.mjs - 模拟「打断并发送」验证脏 checkpoint 修复
 *
 * 流程：
 * 1. 发复杂需求（触发 LLM 思考 + 工具调用），8 秒后 abort 模拟打断
 * 2. 等 2 秒让后端检测断开并打脏标记
 * 3. 同一 sessionId 发新消息，观察 AI 是否基于上下文正常回复
 */
const BASE = "http://localhost:3000/api/agent";

async function chatAndAbort(message, sessionId, abortAfterMs) {
  const ac = new AbortController();
  const events = [];
  const res = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, message }),
    signal: ac.signal,
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const timer = setTimeout(() => {
    console.log(`[模拟打断] ${abortAfterMs}ms 后 abort`);
    ac.abort();
  }, abortAfterMs);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        events.push(t);
        if (t.startsWith("d:")) {
          const d = JSON.parse(t.slice(2));
          if (d.type === "tool_start") console.log("  tool_start:", d.name);
          if (d.type === "session") console.log("  session:", d.sessionId);
        }
      }
    }
  } catch (e) {
    console.log("  [流中断]", e.name);
  } finally {
    clearTimeout(timer);
  }
  return { events, sessionId: extractSession(events) ?? sessionId };
}

function extractSession(events) {
  for (const t of events) {
    if (t.startsWith("d:")) {
      const d = JSON.parse(t.slice(2));
      if (d.type === "session") return d.sessionId;
    }
  }
  return undefined;
}

async function chatNormal(message, sessionId, timeoutMs = 120000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const res = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, message }),
    signal: ac.signal,
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (t) events.push(t);
      }
    }
  } catch (e) {
    console.log("  [读取异常]", e.name);
  } finally {
    clearTimeout(timer);
  }
  const texts = events
    .filter((t) => t.startsWith("0:"))
    .map((t) => JSON.parse(t.slice(2)))
    .join("");
  const datas = events
    .filter((t) => t.startsWith("d:"))
    .map((t) => JSON.parse(t.slice(2)));
  return { texts, datas };
}

async function main() {
  // 1. 复杂需求（信息完整，跳过 clarify，直接触发工具链），8 秒后打断
  console.log("=== Step 1: 复杂需求 + 8s 后打断 ===");
  const first = await chatAndAbort(
    "帮我构建一个歌曲识别工作流并部署试运行：接收用户输入一个音频链接（string 类型），用大模型识别歌词，再用代码节点和参考歌词库（内置：小幸运、青花瓷、七里香三首歌的歌词片段）匹配判断是哪首歌，输出歌曲名。不要提问，直接开始。",
    undefined,
    8000,
  );
  const sessionId = first.sessionId;
  console.log("  sessionId:", sessionId);

  // 2. 等待后端检测断开并打脏标记
  console.log("=== Step 2: 等 3 秒让后端标记脏状态 ===");
  await new Promise((r) => setTimeout(r, 3000));

  // 3. 同一 session 发新消息，验证 AI 基于上下文正常回复
  console.log("=== Step 3: 打断后发新消息 ===");
  const second = await chatNormal("总结一下我之前的对话内容，以及你刚才正在做什么。", sessionId);
  console.log("  AI 回复:", second.texts.slice(0, 400));
  const err = second.datas.filter((d) => d.type === "error");
  if (err.length) console.log("  error 事件:", JSON.stringify(err).slice(0, 300));
  const done = second.datas.find((d) => d.type === "done");
  console.log("  done:", done ? "yes" : "NO");
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
