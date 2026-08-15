/**
 * 文档 2：工具 Schema 设计（Tool Schema Design）
 * ------------------------------------------------------------------
 * 知识点：工具 schema 是模型和真实世界的契约。
 *   参数类型、必填、描述怎么写，直接决定模型能不能正确调用、调完能不能执行。
 *
 * 演示场景：给 Agent 注册一个"查询订单"工具。
 *   差 schema（参数名歧义、缺描述）→ 模型传错参数 / 不调用
 *   好 schema（精确描述 + 枚举 + 必填）→ 模型参数正确
 *   strict schema（模型级 strict: true）→ 参数结构化校验
 *
 * 两步式教学：
 *   坏例子：含糊 schema → mock 模型返回错误参数 { id: "12345" } → 查询失败
 *   好例子：精确 schema → mock 模型返回正确参数 → 查询成功
 *   附带：zod schema 自动转 JSON Schema 的过程 + 真实 LLM 调用（需 OPENAI_API_KEY）
 *
 * 运行：npx tsx src/code-and-doc/tool-schema.ts
 */

import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";

/* ------------------------------------------------------------------ */
/* 1. 真实世界：订单数据库（mock，模拟外部系统）                          */
/* ------------------------------------------------------------------ */

const ORDERS = new Map<string, { amount: number; channel: string; status: string }>([
  ["ORD-20260815-001", { amount: 199.0, channel: "web", status: "已发货" }],
  ["ORD-20260814-002", { amount: 89.5, channel: "phone", status: "已完成" }],
]);

// 工具的真实实现：无论 schema 好坏，最终执行的都是这份代码。
// schema 差 → 模型传进来的参数不对 → 这里查不到数据。
function queryOrderInDatabase(args: { orderId?: string; id?: string; channel?: string }): string {
  const orderId = args.orderId ?? args.id;
  if (!orderId || !orderId.startsWith("ORD-")) {
    return `查询失败：参数 "${args.id ?? args.orderId ?? "(空)"}" 不是合法订单号（应形如 ORD-xxxx）`;
  }
  const order = ORDERS.get(orderId);
  if (!order) return `查询失败：订单 ${orderId} 不存在`;
  return `查询成功：订单 ${orderId}，金额 ¥${order.amount}，渠道 ${order.channel}，状态 ${order.status}`;
}

/* ------------------------------------------------------------------ */
/* 2. 三版 schema 定义                                                 */
/* ------------------------------------------------------------------ */

// ---- 版本 A：差 schema ----
// 问题：
//   - 参数名叫 id，歧义（订单 id？用户 id？支付 id？）
//   - 没有 description，模型不知道 id 的格式（ORD- 前缀）
//   - 没有 channel 枚举，模型只能猜
const badOrderSchema = z.object({
  id: z.string(),
});

// ---- 版本 B：好 schema ----
// 改进：
//   - orderId 语义明确 + describe 说明格式
//   - channel 用 enum，模型只能在三个值里选
//   - 所有字段必填（zod 默认必填）
const goodOrderSchema = z.object({
  orderId: z
    .string()
    .describe("订单号，形如 ORD-20260815-001，以 ORD- 开头"),
  channel: z
    .enum(["web", "phone", "api"])
    .describe("订单下单渠道：web=网页，phone=电话，api=开放平台"),
});

// ---- 版本 C：strict schema ----
// 两层 strict：
//   1. zod 层 .strict()：禁止传入 schema 之外的字段
//   2. 模型层 strict: true（见下方 bindTools 调用）：OpenAI 结构化工具调用，
//      要求所有字段有描述且必填，模型输出会被服务端校验
const strictOrderSchema = z
  .object({
    orderId: z
      .string()
      .describe("订单号，形如 ORD-20260815-001，以 ORD- 开头"),
    channel: z
      .enum(["web", "phone", "api"])
      .describe("订单下单渠道：web=网页，phone=电话，api=开放平台"),
  })
  .strict();

// 用 LangChain 的 tool() 包装成可注册给模型的结构化工具。
// tool() 内部会自动把 zod schema 转成 JSON Schema（下面第 3 节演示这个过程）。
const badOrderTool = tool(async (input) => queryOrderInDatabase(input), {
  name: "query_order",
  description: "查询订单", // 描述含糊：查什么？参数怎么传？
  schema: badOrderSchema,
});

const goodOrderTool = tool(async (input) => queryOrderInDatabase(input), {
  name: "query_order",
  description:
    "根据订单号查询订单的金额、下单渠道与当前状态。调用前必须先从用户消息中提取完整订单号。",
  schema: goodOrderSchema,
});

const strictOrderTool = tool(async (input) => queryOrderInDatabase(input), {
  name: "query_order",
  description:
    "根据订单号查询订单的金额、下单渠道与当前状态。调用前必须先从用户消息中提取完整订单号。",
  schema: strictOrderSchema,
});

/* ------------------------------------------------------------------ */
/* 3. 展示 zod → JSON Schema 的自动转换                                  */
/* ------------------------------------------------------------------ */

function showJsonSchemaConversion() {
  console.log("========== zod schema 自动转 JSON Schema ==========");
  console.log("--- 差 schema 生成的 JSON Schema ---");
  console.log(JSON.stringify(badOrderSchema.toJSONSchema(), null, 2));
  console.log("");
  console.log("--- 好 schema 生成的 JSON Schema ---");
  console.log(JSON.stringify(goodOrderSchema.toJSONSchema(), null, 2));
  console.log("");
  console.log(
    "对比可见：好 schema 多了 description 与 enum，这些正是模型决定'填什么参数'的依据。\n",
  );
}

/* ------------------------------------------------------------------ */
/* 4. mock 模型：模拟"模型根据 schema 生成 tool_calls"                   */
/* ------------------------------------------------------------------ */

// 没有 API key 时，用这个函数模拟模型行为：
//   - schema 里字段没有 description → 模型"瞎猜"参数
//   - schema 里有 description + enum → 模型按说明生成正确参数
function mockModelToolCall(schemaJson: ReturnType<typeof goodOrderSchema.toJSONSchema>) {
  const props = (schemaJson.properties ?? {}) as Record<string, { description?: string; enum?: string[] }>;
  const hasOrderField = Object.keys(props).some((k) => k.includes("orderId"));
  const hasDescription = Object.values(props).some((p) => Boolean(p.description));
  const hasEnum = Object.values(props).some((p) => Array.isArray(p.enum));

  if (!hasOrderField || !hasDescription || !hasEnum) {
    // 差 schema：模型只能猜 —— 传了 id: "12345"（用户根本没有提供这个参数）
    return { name: "query_order", args: { id: "12345" } };
  }
  // 好 schema：模型按 description/enum 提取正确参数
  return {
    name: "query_order",
    args: { orderId: "ORD-20260815-001", channel: "web" },
  };
}

/* ------------------------------------------------------------------ */
/* 5. 两步式对比：坏 schema vs 好 schema                                */
/* ------------------------------------------------------------------ */

async function twoStepComparison() {
  console.log("========== 坏例子：差 schema 导致参数错误 ==========");
  const badCall = mockModelToolCall(badOrderSchema.toJSONSchema());
  console.log("模型生成的 tool_calls：", JSON.stringify(badCall));
  // 工具真实执行：参数不对 → 查询失败
  console.log("工具执行结果：", queryOrderInDatabase(badCall.args as { id?: string }));
  console.log(
    "→ 为什么？schema 里只有裸的 id: string，模型不知道 id 是订单号、不知道要 ORD- 前缀。\n",
  );

  console.log("========== 好例子：好 schema 参数正确 ==========");
  const goodCall = mockModelToolCall(goodOrderSchema.toJSONSchema());
  console.log("模型生成的 tool_calls：", JSON.stringify(goodCall));
  console.log("工具执行结果：", queryOrderInDatabase(goodCall.args as { orderId?: string; channel?: string }));
  console.log("→ 精确描述 + 枚举 + 必填，让模型一次调对。\n");
}

/* ------------------------------------------------------------------ */
/* 6. strict schema：模型层结构化输出（真实 LLM，可选）                   */
/* ------------------------------------------------------------------ */

async function strictSchemaWithRealLLM() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log(
      "【strict schema 真实调用】跳过：未设置 OPENAI_API_KEY（可设 DEEPSEEK_API_KEY 走 OpenAI 兼容接口）。",
    );
    return;
  }

  const model = new ChatOpenAI({
    model: "gpt-4o-mini",
    apiKey,
    temperature: 0,
    maxRetries: 0,
  });

  try {
    // strict: true —— OpenAI 要求 schema 中所有字段有描述且必填，
    // 并且会强制校验模型输出必须匹配 schema。
    const strictModel = model.bindTools([strictOrderTool], { strict: true });
    const res = await strictModel.invoke(
      "帮我查一下订单 ORD-20260815-001，用户是从网页下的单",
    );
    const toolCalls = res.tool_calls ?? [];
    console.log("========== strict schema 真实调用 ==========");
    console.log("模型 tool_calls：", JSON.stringify(toolCalls, null, 2));
    for (const call of toolCalls) {
      console.log("工具执行结果：", queryOrderInDatabase(call.args as { orderId?: string; channel?: string }));
    }
  } catch (err) {
    console.log(
      "strict schema 真实调用失败（网络或 key 问题，已兜底）：",
      (err as Error).message,
    );
  }
  console.log("");
}

/* ------------------------------------------------------------------ */
/* 7. main                                                             */
/* ------------------------------------------------------------------ */

async function main() {
  showJsonSchemaConversion();
  await twoStepComparison();
  await strictSchemaWithRealLLM();

  console.log("========== 结论 ==========");
  console.log(
    "工具 schema 就是'模型 ↔ 真实世界'的契约：\n" +
      "  1. 参数名要语义化（orderId 而非 id），并 describe 格式（ORD- 前缀）；\n" +
      "  2. 能用 enum 约束的不要用 string（channel 只能在 web/phone/api 里选）；\n" +
      "  3. 生产环境配合模型级 strict: true + 工具执行前 zod 二次校验（schema 即校验器）。",
  );
}

main().catch((err) => {
  console.error("main 执行失败：", err);
  process.exitCode = 1;
});
