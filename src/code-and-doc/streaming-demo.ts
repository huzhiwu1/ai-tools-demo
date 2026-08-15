/**
 * 流式输出教学实验：坏例子（手写解析）vs 好例子（真实模型逐 token 流）
 * ------------------------------------------------------------------
 * 实验 0：手写 fetch + res.text() 等全部返回（卡顿感来源）
 * 实验 1：手写解析 SSE，把 [DONE] 混进正文（新手最典型错误）
 * 实验 2：真实模型 ChatOpenAI.stream() 逐 token 输出（边生成边显示）
 *
 * 运行：cd ai-tools-demo && source ~/.zshrc && npx tsx src/code-and-doc/streaming-demo.ts
 * 实验 2 需要 DEEPSEEK_API_KEY（~/.zshrc 里已有）
 */
import { ChatOpenAI } from "@langchain/openai";

// 模拟后端 SSE 事件流（AI SDK 协议简化版：data: 携带 JSON 事件，[DONE] 结束）
function simulateSSEEvents(): { data: string }[] {
  return [
    { data: '{"type":"text-delta","text":"你好"}' },
    { data: '{"type":"text-delta","text":"，我是"}' },
    { data: '{"type":"text-delta","text":"AI 客服。"}' },
    { data: "[DONE]" }, // SSE 结束标记
  ];
}

// ── 实验 0：res.text() 等全部返回 ────────────────────────────────────
async function badExampleText() {
  console.log("========== 实验 0：等全部生成完才返回 ==========");
  const events = simulateSSEEvents();
  // 模拟 fetch：响应体一次性读完（res.text()），不流式读取
  const rawText = events.map((e) => `data: ${e.data}\n\n`).join("");
  console.log("原始 SSE 报文（服务端 4 个事件）：");
  console.log(JSON.stringify(rawText));
  // res.text() 的行为：整段收完才拿到 → 用户看到的是"卡顿后整段出现"
  console.log("\nres.text() 一次性拿到的内容（生成完才有）：");
  console.log(JSON.stringify(rawText));
  console.log("\n→ 问题：LLM 生成要几秒，这期间前端什么都渲染不了。\n");
}

// ── 实验 1：手写解析把 [DONE] 混进正文 ───────────────────────────────
async function badExampleParse() {
  console.log("========== 实验 1：手写解析，[DONE] 混进正文 ==========");
  const events = simulateSSEEvents();
  const rawText = events.map((e) => `data: ${e.data}\n\n`).join("");

  // 新手解析：拆行 → 取 data: 后面的内容 → 直接拼起来
  const parsed = rawText
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.replace("data:", "").trim())
    .join("");

  console.log("前端渲染结果：", JSON.stringify(parsed));
  console.log("→ 问题：[DONE] 结束标记混进正文，用户看到 '[DONE]' 两个字。\n");
}

// ── 实验 2：原生 fetch 流式读取（边读边渲染） ────────────────────────
async function goodExample() {
  console.log("========== 实验 2：原生 fetch 流式读 SSE，逐 token 渲染 ==========");
  const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "用一句话介绍你自己" }],
      stream: true, // 关键：流式模式
      temperature: 0,
    }),
  });

  // 逐块读响应体：每收到一块就解析渲染，不等全部生成完
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let count = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // 按行拆 SSE：data: {...}
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // 最后一行可能不完整，留到下次
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue; // 结束标记，跳过
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content ?? "";
        if (delta) {
          count++;
          process.stdout.write(delta); // 逐块打印，模拟前端逐字渲染
          await new Promise((r) => setTimeout(r, 20)); // 放慢让你看清打字机效果
        }
      } catch {
        /* 忽略不完整的 JSON 行 */
      }
    }
  }
  process.stdout.write("\n");
  console.log(`\n→ 共 ${count} 个增量块。模型边生成边吐字，前端每收到一块就渲染一次，这就是流式输出。`);
}

async function main() {
  await badExampleText();
  await badExampleParse();
  await goodExample();
}

main().catch((err) => {
  console.error("运行失败:", err.message);
  process.exit(1);
});
