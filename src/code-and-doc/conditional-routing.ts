/**
 * 文档 3：LangGraph 条件路由（Conditional Routing）
 * ------------------------------------------------------------------
 * 知识点：条件路由让 Agent 的执行路径由"状态"决定而不是写死。
 *   - 模型判断走哪条分支（LLM 路由）
 *   - 规则判断走哪条分支（关键词/正则路由）
 *   - ReAct 循环里"还有工具要调用就继续，否则结束"（终止条件）
 *
 * 两步式教学：
 *   坏例子：条件边永远把自己指回自己 → 无限循环 → GraphRecursionError
 *   好例子：条件边 + 终止条件（迭代上限）→ 客服路由图真实跑通
 *   对比：LLM 路由 vs 规则路由
 *
 * 运行：npx tsx src/code-and-doc/conditional-routing.ts
 */

import {
  Annotation,
  StateGraph,
  START,
  END,
  GraphRecursionError,
} from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

/* ------------------------------------------------------------------ */
/* 1. 坏例子：没有终止条件的循环（复现"图卡死"）                          */
/* ------------------------------------------------------------------ */

const LoopState = Annotation.Root({
  // 注意：LangGraph v1 中 default 必须配 reducer 才会生效（LastValue 不应用 default）
  iterations: Annotation<number>({ default: () => 0, reducer: (_a, b) => b }),
  log: Annotation<string[]>({
    default: () => [],
    reducer: (a, b) => [...a, ...b],
  }),
});

function buildInfiniteLoopGraph() {
  return new StateGraph(LoopState)
    .addNode("classify", async (state) => ({
      iterations: state.iterations + 1,
      log: [`第 ${state.iterations + 1} 次进入 classify（路由函数永远返回自己）`],
    }))
    // 问题根源：路由函数永远返回 "loop"，条件边把 classify 指回 classify，
    // 没有任何分支指向 END —— 图没有终止条件。
    .addConditionalEdges(
      "classify",
      () => "loop",
      { loop: "classify" }, // 唯一出口还是自己
    )
    .addEdge(START, "classify")
    .compile();
}

async function badExample() {
  console.log("========== 坏例子：无终止条件的图 ==========");
  const graph = buildInfiniteLoopGraph();
  try {
    // recursionLimit: 8 —— 模拟线上图最多迭代 8 步，防止真的烧钱烧到天荒地老
    await graph.invoke({}, { recursionLimit: 8 });
    console.log("（意外：竟然正常结束了？）");
  } catch (err) {
    if (err instanceof GraphRecursionError) {
      console.log(
        `复现成功：${err.message}\n` +
          `→ 路由函数永远返回自己，图在 ${8} 次迭代后被 LangGraph 强制终止。\n` +
          `  线上若不设 recursionLimit，就是无限循环：不断调用模型/工具，token 与费用失控。`,
      );
    } else {
      console.log("复现失败，抛出了其他错误：", (err as Error).message);
    }
  }
  console.log("");
}

/* ------------------------------------------------------------------ */
/* 2. 好例子：客服路由图（规则路由 + 条件边）                              */
/* ------------------------------------------------------------------ */

const ServiceState = Annotation.Root({
  input: Annotation<string>({ default: () => "" }),
  category: Annotation<string>({ default: () => "unknown", reducer: (_a, b) => b }),
  log: Annotation<string[]>({
    default: () => [],
    reducer: (a, b) => [...a, ...b],
  }),
});

// 规则路由器：关键词/正则，零成本、可解释、稳定
function ruleRouter(input: string): string {
  const text = input.toLowerCase();
  if (/退|换|退款|退货/.test(text)) return "return";
  if (/查.*订单|订单.*查|物流|到哪/.test(text)) return "order";
  if (/人工|转人工|客服|投诉/.test(text)) return "human";
  return "fallback";
}

function buildServiceGraph(router: (input: string) => string) {
  return new StateGraph(ServiceState)
    .addNode("classify", async (state) => ({
      category: router(state.input),
      log: [`分类结果：${router(state.input)}（输入：${state.input.slice(0, 20)}…）`],
    }))
    .addNode("handle_order", async (state) => ({
      log: ["[查订单节点] 调用订单服务，返回订单状态"],
    }))
    .addNode("handle_return", async (state) => ({
      log: ["[退换货节点] 调用售后流程，生成退货单"],
    }))
    .addNode("human_agent", async (state) => ({
      log: ["[人工客服节点] 创建工单，转接人工"],
    }))
    .addNode("fallback", async (state) => ({
      log: ["[兜底节点] 无法识别，回复'请换个说法'"],
    }))
    // 关键 API：addConditionalEdges(source, 路由函数, 路径表)
    // 路由函数返回路径表的 key，决定下一步去哪个节点
    .addConditionalEdges(
      "classify",
      (state) => state.category,
      {
        order: "handle_order",
        return: "handle_return",
        human: "human_agent",
        fallback: "fallback",
      },
    )
    .addEdge(START, "classify")
    .addEdge("handle_order", END)
    .addEdge("handle_return", END)
    .addEdge("human_agent", END)
    .addEdge("fallback", END)
    .compile();
}

async function goodExample() {
  console.log("========== 好例子：客服路由图（条件边 + 明确出口） ==========");
  const graph = buildServiceGraph(ruleRouter);

  const cases = [
    "我要查订单 ORD-001 到哪了",
    "这件衣服不合适，想退货退款",
    "转人工客服投诉配送太慢",
    "今天天气怎么样",
  ];

  for (const input of cases) {
    const result = await graph.invoke({ input });
    console.log(`输入：${input}`);
    console.log("  执行路径：", result.log.join(" → "));
  }
  console.log("");
}

/* ------------------------------------------------------------------ */
/* 3. ReAct 风格循环 + 终止条件（max iterations）                         */
/* ------------------------------------------------------------------ */

const ReActState = Annotation.Root({
  input: Annotation<string>({ default: () => "" }),
  steps: Annotation<number>({ default: () => 0, reducer: (_a, b) => b }),
  needTool: Annotation<boolean>({ default: () => false, reducer: (_a, b) => b }),
  log: Annotation<string[]>({
    default: () => [],
    reducer: (a, b) => [...a, ...b],
  }),
});

const MAX_ITERATIONS = 3;

function buildReActGraph() {
  return new StateGraph(ReActState)
    .addNode("agent", async (state) => {
      const step = state.steps + 1;
      // 模拟 Agent 决策：前 MAX_ITERATIONS 步都"还想再调一次工具"
      const needTool = step < MAX_ITERATIONS;
      return {
        steps: step,
        needTool,
        log: [
          `[第 ${step} 步] Agent 决策：${needTool ? "还要调工具（继续循环）" : "答案够了（结束）"}`,
        ],
      };
    })
    // 终止条件就藏在这里：needTool === false 时走 end
    .addConditionalEdges(
      "agent",
      (state) => (state.needTool ? "continue" : "end"),
      { continue: "agent", end: END },
    )
    .addEdge(START, "agent")
    .compile();
}

async function reactLoopExample() {
  console.log("========== ReAct 循环：条件边 + max iterations 终止 ==========");
  const graph = buildReActGraph();
  const result = await graph.invoke({ input: "帮我计算 1+2+3" });
  console.log("  执行日志：", result.log.join(" → "));
  console.log(`  总步数：${result.steps}（MAX_ITERATIONS = ${MAX_ITERATIONS}）`);
  console.log(
    "→ 循环不是问题，问题是没有终止条件。生产环境一定给循环加：\n" +
      "   ① 状态里的迭代计数；② 计数达上限强制结束；③ 图级 recursionLimit 兜底。",
  );
  console.log("");
}

/* ------------------------------------------------------------------ */
/* 4. 路由对比：LLM 路由 vs 规则路由                                      */
/* ------------------------------------------------------------------ */

// LLM 路由器：让模型输出分类。需要 OPENAI_API_KEY（或 DeepSeek 兼容接口）。
async function llmRouter(input: string): Promise<string> {
  const apiKey =
    process.env.OPENAI_API_KEY ?? process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return ruleRouter(input); // 无 key 时退化为规则路由
  }

  const model = new ChatOpenAI({
    model: process.env.OPENAI_API_KEY ? "gpt-4o-mini" : "deepseek-chat",
    apiKey,
    temperature: 0,
    maxRetries: 0,
    configuration: process.env.DEEPSEEK_API_KEY
      ? { baseURL: "https://api.deepseek.com", timeout: 8000 }
      : { timeout: 8000 },
  });

  const classifier = model.withStructuredOutput(
    z.object({
      category: z.enum(["order", "return", "human", "fallback"]),
    }),
  );
  const res = await classifier.invoke(input);
  return res.category;
}

async function routerComparison() {
  console.log("========== 路由对比：规则路由 vs LLM 路由 ==========");
  const hardCases = [
    "订单显示已签收但实际没收到，怎么办", // 规则路由会误判为 order；其实是售后问题
    "退单后多久能收到钱", // "退"命中 return，但其实是查退款时效
  ];
  for (const input of hardCases) {
    const ruleResult = ruleRouter(input);
    let llmResult = "（无 key，退化为规则路由）";
    try {
      llmResult = await llmRouter(input);
    } catch (err) {
      llmResult = `（LLM 调用失败，已兜底：${(err as Error).message}）`;
    }
    console.log(`输入：${input}`);
    console.log(`  规则路由 → ${ruleResult}`);
    console.log(`  LLM 路由 → ${llmResult}`);
  }
  console.log(
    "\n→ 规则路由：快、省、可解释，但规则边界外的句子会误判；\n" +
      "  LLM 路由：语义理解强，但有延迟/费用/不确定性。生产常用'规则先兜底 + LLM 处理模糊输入'。",
  );
  console.log("");
}

/* ------------------------------------------------------------------ */
/* 5. main                                                             */
/* ------------------------------------------------------------------ */

async function main() {
  await badExample();
  await goodExample();
  await reactLoopExample();
  await routerComparison();
}

main().catch((err) => {
  console.error("main 执行失败：", err);
  process.exitCode = 1;
});
