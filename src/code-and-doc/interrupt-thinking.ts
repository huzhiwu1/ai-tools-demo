/**
 * interrupt-thinking.ts
 * 场景：用户提问 → LLM 思考中（慢节点模拟）→ 用户发现想错了 → 打断 → 发提醒 → 状态清洗后带纠正重跑
 *
 * 运行：npx tsx interrupt-thinking.ts
 * 依赖：@langchain/langgraph（真实 API，非 Mock）
 * 说明：LLM 思考用分步 delay 模拟（每步打印思考过程），便于控制打断时机、输出可复现；
 *       生产环境把 think 节点换成 ChatOpenAI 流式调用 + 传 signal（见注释），打断机制完全一致。
 */
import { Annotation, MemorySaver, START, END, StateGraph } from "@langchain/langgraph";

const State = Annotation.Root({
  messages: Annotation<string[]>({
    default: () => [],
    reducer: (a, b) => [...a, ...b],
  }),
  // 打断标记：用户手动打断思考时为 true
  interrupted: Annotation<boolean>({ default: () => false }),
  // 提醒内容：用户打断后发的纠正信息
  reminder: Annotation<string | null>({ default: () => null }),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 模拟 LLM 思考：4 步，每步 400ms，逐步把"思考过程"追加进 messages。
 * 生产环境替换为真实流式：const stream = await llm.stream(prompt, { signal }); for await (const chunk of stream) {...}
 */
async function thinkNode(state: typeof State.State, config: { signal?: AbortSignal }) {
  const thoughts = [
    "[思考] 用户问的是订单 12345 的状态。",
    "[思考] 我打算直接查数据库返回结果。",
    "[思考] 等一下，用户可能想问退款进度而不是物流。",
    "[回答] 您的订单 12345 当前状态：已发货，预计明天送达。",
  ];
  const updates: string[] = [];
  for (const t of thoughts) {
    // 每步开始前检查是否被打断——这就是"用户手动打断 LLM 思考"的落点
    if (config.signal?.aborted) {
      throw new Error("ABORTED_BY_USER");
    }
    await sleep(400);
    updates.push(t);
    console.log("  LLM:", t);
  }
  return { messages: updates };
}

async function runWithAbort(graph: ReturnType<typeof buildGraph>, cfg: { configurable: { thread_id: string } }, abortAfterMs: number) {
  const ac = new AbortController();
  const run = (async () => {
    const stream = await graph.stream({ messages: ["帮我查订单 12345"] }, { ...cfg, signal: ac.signal });
    for await (const _ of stream) {
      /* 消费流 */
    }
  })();
  // 用户在第 N 毫秒发现 LLM 想错了，手动打断
  await sleep(abortAfterMs);
  ac.abort();
  try {
    await run;
    return { aborted: false };
  } catch (e) {
    return { aborted: true, error: (e as Error).message };
  }
}

function buildGraph() {
  return new StateGraph(State)
    .addNode("think", thinkNode)
    .addEdge(START, "think")
    .addEdge("think", END)
    .compile({ checkpointer: new MemorySaver() });
}

async function main() {
  // ===== 场景 A：不打断，正常跑完（对照） =====
  console.log("===== 场景 A：不打断，正常跑完（对照） =====");
  const graphA = buildGraph();
  const cfgA = { configurable: { thread_id: "t-A" } };
  const rA = await runWithAbort(graphA, cfgA, 10_000); // 10s 不打断
  const stA = await graphA.getState(cfgA);
  console.log("最终 messages:", JSON.stringify(stA.values.messages));
  console.log("next:", JSON.stringify(stA.next), "| 结果:", rA.aborted ? "被打断" : "正常完成");
  console.log();

  // ===== 场景 B：思考中打断 =====
  console.log("===== 场景 B：LLM 思考中，用户手动打断 =====");
  const graphB = buildGraph();
  const cfgB = { configurable: { thread_id: "t-B" } };
  const rB = await runWithAbort(graphB, cfgB, 1000); // 1s 后打断（第 2 步思考中途）
  const stB = await graphB.getState(cfgB);
  console.log("打断结果:", JSON.stringify(rB));
  console.log("打断后 messages:", JSON.stringify(stB.values.messages));
  console.log("打断后 next:", JSON.stringify(stB.next), "（非空 = 执行现场没跑完）");
  console.log();

  // ===== 场景 C：打断 + 用户发提醒 → 状态清洗 → 带纠正重跑 =====
  console.log("===== 场景 C：打断 + 发提醒 → 清洗状态 → 带纠正重跑 =====");
  const graphC = buildGraph();
  const cfgC = { configurable: { thread_id: "t-C" } };
  const rC = await runWithAbort(graphC, cfgC, 1000);
  console.log("第一次 run 打断:", JSON.stringify(rC));

  // 用户提醒来了：服务层标记 interrupted + 记录提醒（updateState 走 reducer，messages 通道是追加）
  await graphC.updateState(cfgC, { interrupted: true, reminder: "我其实想问退款进度，不是物流" });
  const stC = await graphC.getState(cfgC);
  console.log("标脏后 interrupted:", stC.values.interrupted, "| reminder:", stC.values.reminder);
  console.log("标脏后 next:", JSON.stringify(stC.next), "（还挂着旧现场）");

  // 状态清洗：旧 thread 物理废弃（换新 thread_id = 重置执行位置），
  // 但 messages 保留（对话脉络有用）+ 追加用户提醒 → 重新思考
  const freshCfg = { configurable: { thread_id: "t-C-fresh" } };
  const stream2 = await graphC.stream(
    { messages: [...stC.values.messages, `[用户提醒] ${stC.values.reminder}`] },
    freshCfg
  );
  for await (const _ of stream2) {
    /* 消费流 */
  }
  const stC2 = await graphC.getState(freshCfg);
  console.log("重跑后 messages:", JSON.stringify(stC2.values.messages));
  console.log("→ 干净：旧思考被丢弃，提醒生效，从零重新思考");
}

main().catch((e) => {
  console.error("main failed:", e);
  process.exitCode = 1;
});
