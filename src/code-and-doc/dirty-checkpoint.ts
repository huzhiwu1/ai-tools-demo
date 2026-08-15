import { Annotation, MemorySaver, START, END, StateGraph } from "@langchain/langgraph";

// messages 用 reducer 追加（真实项目标准做法），脏状态才会真实复现
const State = Annotation.Root({
  messages: Annotation<string[]>({
    default: () => [],
    reducer: (a, b) => [...a, ...b],
  }),
  pendingTool: Annotation<string | null>({ default: () => null }),
  dirty: Annotation<boolean>({ default: () => false }),
});

// 构建"工具第一次调用必超时"的图，模拟外部 API 不稳定
function buildGraph() {
  let toolAttempts = 0;
  return new StateGraph(State)
    .addNode("ingest", async (state) => ({
      pendingTool: `query:${state.messages[state.messages.length - 1]}`,
    }))
    .addNode("callTool", async (state) => {
      toolAttempts += 1;
      if (toolAttempts === 1) {
        throw new Error("工具超时：调用外部 API 30s 无响应");
      }
      return {
        messages: [`工具返回：${state.pendingTool} 执行成功`],
        pendingTool: null,
      };
    })
    .addNode("finish", async (state) => ({ messages: ["流程正常结束"] }))
    .addEdge(START, "ingest")
    .addEdge("ingest", "callTool")
    .addEdge("callTool", "finish")
    .addEdge("finish", END)
    .compile({ checkpointer: new MemorySaver() });
}

async function main() {
  // ===== 场景 A：中断后直接复用 thread，不做脏处理 =====
  console.log("===== 场景 A：中断后直接复用 thread =====");
  const graphA = buildGraph();
  const cfgA = { configurable: { thread_id: "chat-A" } };
  try {
    await graphA.invoke({ messages: ["帮我查订单 12345"] }, cfgA);
  } catch (e) {
    console.log("第一轮中断:", (e as Error).message);
  }
  const stA = await graphA.getState(cfgA);
  console.log("第一轮后 checkpoint:", JSON.stringify(stA.values), "| next:", JSON.stringify(stA.next));

  const resultA = await graphA.invoke({ messages: ["今天天气怎么样"] }, cfgA);
  console.log("第二轮 messages:", JSON.stringify(resultA.messages));
  console.log("→ 新话题被第一轮残留污染，两轮消息混在同一个 thread");

  // ===== 场景 B：服务层检测 dirty + 换 thread 重建 =====
  console.log("\n===== 场景 B：服务层检测 dirty + 换 thread 重建 =====");
  const graphB = buildGraph();
  const cfgB = { configurable: { thread_id: "chat-B" } };
  try {
    await graphB.invoke({ messages: ["帮我查订单 12345"] }, cfgB);
  } catch (e) {
    console.log("第一轮中断:", (e as Error).message);
  }
  // 前端 stop 事件 → 服务端标脏
  await graphB.updateState(cfgB, { dirty: true });
  const stB = await graphB.getState(cfgB);
  console.log("标脏后 checkpoint:", JSON.stringify(stB.values), "| next:", JSON.stringify(stB.next));

  const isDirty = stB.values.dirty === true || stB.next.length > 0;
  console.log("服务层检测 →", isDirty ? "脏，换新 thread 重建" : "干净，续跑");
  if (isDirty) {
    const freshCfg = { configurable: { thread_id: "chat-B-fresh" } };
    const resultB = await graphB.invoke({ messages: ["今天天气怎么样"] }, freshCfg);
    console.log("重建后 messages:", JSON.stringify(resultB.messages));
    console.log("→ 干净：只有新话题，无第一轮残留");
  }
}

main().catch((e) => {
  console.error("main failed:", e);
  process.exitCode = 1;
});
