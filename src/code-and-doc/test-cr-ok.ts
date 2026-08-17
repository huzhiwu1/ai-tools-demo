import { Annotation, StateGraph, START, END, GraphRecursionError } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

async function main() {
// ===== 坏例子：无终止条件的循环 =====
const LoopState = Annotation.Root({
  iterations: Annotation<number>({ default: () => 0, reducer: (_a, b) => b }),
  log: Annotation<string[]>({ default: () => [], reducer: (a, b) => [...a, ...b] }),
});
const infiniteGraph = new StateGraph(LoopState)
  .addNode("classify", async (state) => ({ iterations: state.iterations + 1, log: [`第 ${state.iterations + 1} 次进入 classify`] }))
  .addConditionalEdges("classify", () => "loop", { loop: "classify" })
  .addEdge(START, "classify")
  .compile();
console.log("===== 坏例子：无终止条件的循环 =====");
try {
  await infiniteGraph.invoke({}, { recursionLimit: 8 });
} catch (err) {
  if (err instanceof GraphRecursionError) {
    console.log("复现成功：recursionLimit(8) 强制终止了死循环");
    console.log("→ 路由函数永远返回自己，没有出口分支\n");
  }
}

// ===== 好例子：规则路由 =====
const ServiceState = Annotation.Root({
  input: Annotation<string>({ default: () => "" }),
  category: Annotation<string>({ default: () => "unknown", reducer: (_a, b) => b }),
  log: Annotation<string[]>({ default: () => [], reducer: (a, b) => [...a, ...b] }),
});
function ruleRouter(input: string): string {
  const t = input.toLowerCase();
  if (/退|换|退款|退货/.test(t)) return "return";
  if (/查.*订单|订单.*查|物流|到哪/.test(t)) return "order";
  if (/人工|转人工|客服|投诉/.test(t)) return "human";
  return "fallback";
}
const serviceGraph = new StateGraph(ServiceState)
  .addNode("classify", async (state) => ({ category: ruleRouter(state.input), log: [`分类: ${ruleRouter(state.input)}`] }))
  .addNode("handle_order", async (state) => ({ log: ["[查订单] 返回订单状态"] }))
  .addNode("handle_return", async (state) => ({ log: ["[退换货] 生成退货单"] }))
  .addNode("human_agent", async (state) => ({ log: ["[人工] 创建工单"] }))
  .addNode("fallback", async (state) => ({ log: ["[兜底] 无法识别"] }))
  .addConditionalEdges("classify", (state) => state.category, { order: "handle_order", return: "handle_return", human: "human_agent", fallback: "fallback" })
  .addEdge(START, "classify")
  .addEdge("handle_order", END).addEdge("handle_return", END).addEdge("human_agent", END).addEdge("fallback", END)
  .compile();
console.log("===== 好例子：客服路由 =====");
for (const input of ["我要查订单 ORD-001 到哪了", "这件衣服不合适，想退货退款", "转人工客服投诉配送太慢", "今天天气怎么样"]) {
  const r = await serviceGraph.invoke({ input });
  console.log(`"${input}" → ${r.log.join(" → ")}`);
}
console.log("");

// ===== ReAct 循环 + 终止 =====
const ReActState = Annotation.Root({
  steps: Annotation<number>({ default: () => 0, reducer: (_a, b) => b }),
  needTool: Annotation<boolean>({ default: () => false, reducer: (_a, b) => b }),
  log: Annotation<string[]>({ default: () => [], reducer: (a, b) => [...a, ...b] }),
});
const MAX = 3;
const reactGraph = new StateGraph(ReActState)
  .addNode("agent", async (state) => {
    const s = state.steps + 1;
    const need = s < MAX;
    return { steps: s, needTool: need, log: [`[第${s}步] ${need ? "还要调工具" : "回答完成"}`] };
  })
  .addConditionalEdges("agent", (state) => (state.needTool ? "continue" : "end"), { continue: "agent", end: END })
  .addEdge(START, "agent")
  .compile();
console.log("===== ReAct 循环 + 终止 =====");
const r2 = await reactGraph.invoke({ input: "计算 1+2+3" });
console.log(r2.log.join(" → "));
console.log(`总步数: ${r2.steps}, 最大迭代: ${MAX}`);
console.log("");

// ===== LLM 路由 vs 规则路由 =====
console.log("===== 路由对比：规则 vs LLM =====");
const hardCases = ["订单显示已签收但实际没收到", "退单后多久能收到钱"];
for (const input of hardCases) {
  const rule = ruleRouter(input);
  let llm = "（无 key）";
  try {
    const key = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
    if (key) {
      const model = new ChatOpenAI({ model: "deepseek-chat", apiKey: key, temperature: 0, configuration: { baseURL: "https://api.deepseek.com", timeout: 8000 } });
      const c = await model.withStructuredOutput(z.object({ category: z.enum(["order","return","human","fallback"]) })).invoke(input);
      llm = c.category;
    }
  } catch (e: any) { llm = `（失败: ${e.message.slice(0,40)}）`; }
  console.log(`"${input}" → 规则:${rule} | LLM:${llm}`);
}
}

main().catch(e => { console.error(e); process.exit(1); });
