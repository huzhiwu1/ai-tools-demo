/**
 * 文档 4：Interrupt / Human-in-the-loop（人工介入）
 * ------------------------------------------------------------------
 * 知识点：interrupt 是 LangGraph 的暂停点——
 *   图执行到关键步骤停下来等人工确认，确认后从暂停点继续，而不是重跑。
 *
 * 演示场景：自动下单 Agent，调用支付工具前必须人工确认金额和收款方。
 *   用户点同意 → resume 继续支付；点拒绝 → 取消订单，不执行支付。
 *
 * 两步式教学：
 *   坏例子：不用 interrupt，危险操作直接执行（日志演示扣款）
 *   好例子：interrupt 暂停 → getState 查看暂停点 → Command(resume) 继续
 *
 * 关键点：
 *   - 编译时必须传 checkpointer（MemorySaver），否则 interrupt 直接报错
 *   - interrupt() 在节点内调用，第一次执行抛 GraphInterrupt
 *   - 恢复用 graph.invoke(new Command({ resume: 值 }), config)
 *
 * 运行：npx tsx src/code-and-doc/interrupt-hitl.ts
 */

import {
  Annotation,
  StateGraph,
  START,
  END,
  MemorySaver,
  interrupt,
  Command,
  GraphValueError,
} from "@langchain/langgraph";

/* ------------------------------------------------------------------ */
/* 1. 真实世界：支付工具（mock）                                         */
/* ------------------------------------------------------------------ */

function mockPay(amount: number, payee: string): string {
  return `✅ 支付成功：¥${amount.toFixed(2)} 已转给 ${payee}`;
}

/* ------------------------------------------------------------------ */
/* 2. 坏例子：没有 interrupt，危险操作直接执行                            */
/* ------------------------------------------------------------------ */

const DangerousState = Annotation.Root({
  amount: Annotation<number>({ default: () => 0 }),
  payee: Annotation<string>({ default: () => "" }),
  log: Annotation<string[]>({
    default: () => [],
    reducer: (a, b) => [...a, ...b],
  }),
});

function buildDangerousGraph() {
  return new StateGraph(DangerousState)
    .addNode("prepare", async () => ({
      amount: 2999.0,
      payee: "深圳某某数码专营店",
      log: ["[prepare] 生成订单：¥2999.00"],
    }))
    .addNode("pay", async (state) => ({
      log: [`[pay] 直接调用支付工具：${mockPay(state.amount, state.payee)}`],
    }))
    .addEdge(START, "prepare")
    .addEdge("prepare", "pay")
    .addEdge("pay", END)
    .compile();
}

async function badExample() {
  console.log("========== 坏例子：无 interrupt，危险操作直接执行 ==========");
  const graph = buildDangerousGraph();
  const result = await graph.invoke({});
  console.log("执行日志：", result.log.join(" → "));
  console.log("→ 用户根本没确认，钱就被扣了。这显然不能上生产。\n");
}

/* ------------------------------------------------------------------ */
/* 3. 好例子：interrupt 暂停 + 人工确认 + resume 继续                     */
/* ------------------------------------------------------------------ */

const OrderState = Annotation.Root({
  orderId: Annotation<string>({ default: () => "" }),
  amount: Annotation<number>({ default: () => 0 }),
  payee: Annotation<string>({ default: () => "" }),
  approved: Annotation<boolean | null>({ default: () => null, reducer: (_a, b) => b }),
  status: Annotation<string>({ default: () => "created", reducer: (_a, b) => b }),
  log: Annotation<string[]>({
    default: () => [],
    reducer: (a, b) => [...a, ...b],
  }),
});

function buildHitlGraph() {
  return new StateGraph(OrderState)
    .addNode("prepare", async (state) => ({
      orderId: state.orderId,
      amount: 2999.0,
      payee: "深圳某某数码专营店",
      status: "awaiting_approval",
      log: ["[prepare] 生成订单：¥2999.00，收款方：深圳某某数码专营店"],
    }))
    .addNode("confirm", async (state) => {
      // interrupt() 是暂停点：
      //   第一次执行 → 抛出 GraphInterrupt，图停在 confirm 节点，等待外部 resume
      //   外部 resume 后 → interrupt() 的返回值就是 resume 传入的值
      const decision = interrupt<{ type: string; amount: number; payee: string }, {
        approved: boolean;
        note?: string;
      }>({
        type: "payment_approval",
        amount: state.amount,
        payee: state.payee,
      });
      return {
        approved: decision.approved,
        status: decision.approved ? "approved" : "cancelled",
        log: [
          `[confirm] 收到人工确认：${decision.approved ? "同意" : "拒绝"}${decision.note ? `（备注：${decision.note}）` : ""}`,
        ],
      };
    })
    .addNode("pay", async (state) => ({
      status: "paid",
      log: [`[pay] 执行支付：${mockPay(state.amount, state.payee)}`],
    }))
    // 条件边：批准才支付，拒绝直接结束（订单取消，钱不动）
    .addConditionalEdges(
      "confirm",
      (state) => (state.approved ? "yes" : "no"),
      { yes: "pay", no: END },
    )
    .addEdge(START, "prepare")
    .addEdge("prepare", "confirm")
    .addEdge("pay", END)
    // 关键：interrupt 依赖 checkpointer 保存暂停点状态，编译时必须传
    .compile({ checkpointer: new MemorySaver() });
}

async function goodExample() {
  console.log("========== 好例子：interrupt 暂停 → 人工确认 → resume ==========");
  const graph = buildHitlGraph();
  const config = { configurable: { thread_id: "order-20260815-001" } };

  // ① 第一次 invoke：跑到 confirm 的 interrupt() 时图暂停。
  // 注意版本差异：LangGraph v1.4+ 的 invoke 不抛异常，而是正常返回，
  // 返回的 state 里带 __interrupt__ 字段（早期版本是抛 GraphInterrupt）。
  const paused = await graph.invoke({ orderId: "ORD-20260815-001" }, config);
  const interrupts = (
    paused as { __interrupt__?: Array<{ value: unknown }> }
  ).__interrupt__;
  if (interrupts && interrupts.length > 0) {
    console.log("① 图已暂停。暂停点要求人工确认：");
    console.log("   ", JSON.stringify(interrupts[0].value));
  } else {
    console.log("（意外：图没有暂停）");
  }

  // ② getState：查看暂停点的完整状态（values + 下一步 next）
  const snapshot = await graph.getState(config);
  console.log("② getState 暂停点快照：");
  console.log("   values：", JSON.stringify(snapshot.values));
  console.log("   next（下一步要执行的节点）：", JSON.stringify(snapshot.next));
  console.log("   （next 指向 confirm，说明 resume 后从 confirm 继续，而不是从头重跑）");

  // ③ 人工点了"同意" → Command(resume) 从暂停点继续
  const approvedResult = await graph.invoke(
    new Command({ resume: { approved: true, note: "人工已核对金额" } }),
    config,
  );
  console.log("③ 人工同意后 resume，执行日志：", approvedResult.log.join(" → "));
  console.log("   最终状态：", approvedResult.status);

  // ④ 换一个 thread，人工点"拒绝" → 不支付，直接取消
  console.log("");
  const rejectConfig = { configurable: { thread_id: "order-20260815-002" } };
  await graph.invoke({ orderId: "ORD-20260815-002" }, rejectConfig);
  const rejectedResult = await graph.invoke(
    new Command({ resume: { approved: false, note: "金额不对，拒绝" } }),
    rejectConfig,
  );
  console.log("④ 人工拒绝后 resume，执行日志：", rejectedResult.log.join(" → "));
  console.log("   最终状态：", rejectedResult.status, "（pay 节点从未执行，钱没动）");
  console.log("");
}

/* ------------------------------------------------------------------ */
/* 4. 补充：忘了传 checkpointer 会怎样                                    */
/* ------------------------------------------------------------------ */

async function noCheckpointerExample() {
  console.log("========== 补充：不传 checkpointer 的后果 ==========");
  const graph = new StateGraph(OrderState)
    .addNode("confirm", async (state) => {
      const decision = interrupt({ type: "payment_approval", amount: state.amount, payee: state.payee });
      return { approved: decision.approved };
    })
    .addEdge(START, "confirm")
    .addEdge("confirm", END)
    .compile(); // 没传 checkpointer！

  try {
    await graph.invoke({ amount: 1, payee: "x" });
  } catch (err) {
    if (err instanceof GraphValueError) {
      console.log("报错信息：", err.message);
      console.log("→ interrupt 必须配合 checkpointer 才能保存'暂停到哪了'，这是设计使然。");
    } else {
      console.log("（抛出了非预期错误）", (err as Error).message);
    }
  }
  console.log("");
}

/* ------------------------------------------------------------------ */
/* 5. main                                                             */
/* ------------------------------------------------------------------ */

async function main() {
  await badExample();
  await goodExample();
  await noCheckpointerExample();

  console.log("========== 结论 ==========");
  console.log(
    "Human-in-the-loop 的正确姿势：\n" +
      "  1. 编译时传 checkpointer（MemorySaver / 生产用 PostgresSaver）；\n" +
      "  2. 危险节点前调用 interrupt(payload) 暂停，payload 展示给前端；\n" +
      "  3. 前端确认后 invoke(new Command({ resume: 结果 })) 从暂停点继续；\n" +
      "  4. getState() 可随时查看暂停点状态（next 表示 resume 后从哪个节点继续）。",
  );
}

main().catch((err) => {
  console.error("main 执行失败：", err);
  process.exitCode = 1;
});
