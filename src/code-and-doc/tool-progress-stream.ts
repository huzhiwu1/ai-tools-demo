/**
 * 文档 A：工具长轮询的进度流（Tool Progress Streaming）
 * ------------------------------------------------------------------
 * 知识点：LangGraph 里工具执行是同步阻塞的——普通 async 工具在 sleep 轮询期间
 *   事件流完全停滞，前端只有 tool_start / tool_end，中间一片黑。
 *   官方解法：工具定义为 async generator（yield 进度）→ streamMode "tools"
 *   的 on_tool_event 实时到达；或 config.writer + streamMode "custom"。
 *
 * 场景：批量验证工作流（batch_validate）——每个用例轮询 5 秒，N 个用例串行，
 *   用户看到的是"卡住"。修复后每个用例的进度实时可见。
 *
 * 两步式教学：
 *   步骤 1（复现）：普通 async 工具 sleep 轮询 → 事件流只有 start/end，中间全黑
 *   步骤 2（修复）：async generator 工具 yield 进度 → on_tool_event 实时到达
 *   步骤 3（兼容）：既有 Promise 工具用 config.writer 发进度（侵入最小）
 *
 * 运行：cd ai-tools-demo && npx tsx src/code-and-doc/tool-progress-stream.ts
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import {
  StateGraph,
  StateSchema,
  START,
  END,
  LangGraphRunnableConfig,
} from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";

const State = new StateSchema({
  messages: z.array(z.any()),
});

/** 模拟批量验证：每个用例轮询等待外部系统（如 Coze 平台）出结果 */
function fakePoll(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------------------------------------------ */
/* 步骤 1（复现）：普通 async 工具，内部 sleep 轮询，无任何中间事件      */
/* ------------------------------------------------------------------ */

const slowBatch = tool(
  async ({ cases }: { cases: number }) => {
    const results: string[] = [];
    for (let i = 1; i <= cases; i++) {
      // 模拟：提交用例 → 轮询 300ms → 拿结果
      await fakePoll(300);
      results.push(`case${i}: pass`);
    }
    return JSON.stringify(results);
  },
  {
    name: "slow_batch",
    description: "批量验证（串行轮询，看不到中间进度）",
    schema: z.object({ cases: z.number() }),
  },
);

/* ------------------------------------------------------------------ */
/* 步骤 2（修复）：async generator 工具，每次 yield 发一条进度事件        */
/* ------------------------------------------------------------------ */

const progressBatch = tool(
  async function* ({ cases }: { cases: number }) {
    const results: string[] = [];
    for (let i = 1; i <= cases; i++) {
      await fakePoll(300);
      results.push(`case${i}: pass`);
      // yield 的内容 = on_tool_event 的 data，实时推给前端
      yield {
        current: i,
        total: cases,
        message: `用例 ${i}/${cases} 执行中...`,
        partial: [...results],
      };
    }
    // return 的值 = 工具最终结果（ToolMessage.content）
    return JSON.stringify({ ok: true, results });
  },
  {
    name: "progress_batch",
    description: "批量验证（带实时进度）",
    schema: z.object({ cases: z.number() }),
  },
);

/* ------------------------------------------------------------------ */
/* 步骤 3（兼容）：既有 Promise 工具，用 config.writer 发进度（零改动返回值） */
/* ------------------------------------------------------------------ */

const writerBatch = tool(
  async (
    { cases }: { cases: number },
    config: LangGraphRunnableConfig,
  ) => {
    const results: string[] = [];
    for (let i = 1; i <= cases; i++) {
      await fakePoll(300);
      results.push(`case${i}: pass`);
      // 旧工具是普通 async 函数，不用改签名结构，writer 直接发
      config.writer?.({ type: "progress", current: i, total: cases });
    }
    return JSON.stringify({ ok: true, results });
  },
  {
    name: "writer_batch",
    description: "批量验证（writer 进度）",
    schema: z.object({ cases: z.number() }),
  },
);

/** 构造"LLM 已决定调用工具"的输入（固定 tool_calls，跳过真实 LLM 保证可复现） */
function makeInputs(toolName: string, id: string) {
  return {
    messages: [
      new HumanMessage("跑 3 个用例"),
      new AIMessage({
        content: "",
        tool_calls: [
          { name: toolName, args: { cases: 3 }, id, type: "tool_call" as const },
        ],
      }),
    ],
  };
}

function buildGraph(tools: ReturnType<typeof tool>[]) {
  return new StateGraph(State)
    .addNode("tools", new ToolNode(tools))
    .addEdge(START, "tools")
    .addEdge("tools", END)
    .compile();
}

async function main() {
  console.log("========== 步骤 1：复现——普通 async 工具（无中间事件） ==========");
  const g1 = buildGraph([slowBatch]);
  const t0 = Date.now();
  for await (const [mode, chunk] of await g1.stream(makeInputs("slow_batch", "c1"), {
    streamMode: ["tools"],
  })) {
    if (mode === "tools") {
      console.log(`[${Date.now() - t0}ms] ${chunk.event}: ${chunk.name}`);
    }
  }
  console.log(`总耗时 ${Date.now() - t0}ms（中间 ${300 * 3}ms 无任何事件）\n`);

  console.log("========== 步骤 2：修复——async generator 工具（实时进度） ==========");
  const g2 = buildGraph([progressBatch]);
  const t1 = Date.now();
  for await (const [mode, chunk] of await g2.stream(
    makeInputs("progress_batch", "c2"),
    { streamMode: ["tools"] },
  )) {
    if (mode === "tools") {
      console.log(
        `[${Date.now() - t1}ms] ${chunk.event}: ${chunk.name}`,
        chunk.event === "on_tool_event" ? JSON.stringify(chunk.data) : "",
      );
    }
  }
  console.log(`总耗时 ${Date.now() - t1}ms\n`);

  console.log("========== 步骤 3：兼容——config.writer + custom mode ==========");
  const g3 = buildGraph([writerBatch]);
  const t2 = Date.now();
  for await (const [mode, chunk] of await g3.stream(makeInputs("writer_batch", "c3"), {
    streamMode: ["custom"],
  })) {
    if (mode === "custom") {
      console.log(`[${Date.now() - t2}ms] custom: ${JSON.stringify(chunk)}`);
    }
  }
  console.log(`总耗时 ${Date.now() - t2}ms`);
}

main().catch((e) => {
  console.error("执行失败:", e);
  process.exit(1);
});
