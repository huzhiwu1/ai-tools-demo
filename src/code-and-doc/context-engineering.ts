/**
 * 文档 1：上下文工程（Context Engineering）
 * ------------------------------------------------------------------
 * 知识点：上下文工程 = 决定"什么信息放进上下文窗口、以什么形式放、什么时候放"。
 * 比提示词工程更接近 Agent 系统质量的根本。
 *
 * 演示场景：知识库问答 Agent。
 *   用户问题 → 系统提示 + 检索到的文档片段 + 历史消息。
 *   窗口有限，怎么编排才能让模型既看到关键信息又不被噪声淹没？
 *
 * 两步式教学：
 *   坏例子：检索到的 20 段全塞进去（无裁剪、历史全量）→ 上下文污染 → 答非所问
 *   好例子：只塞 top-3 相关段 + 超长段裁剪 + 历史滑动窗口 → 答案正确
 *
 * 本文件不依赖真实 LLM（用 mock 检索 + 模拟模型输出），
 * 最后附带一段"需要 OPENAI_API_KEY"的真实调用（try-catch 兜底）。
 *
 * 运行：npx tsx src/code-and-doc/context-engineering.ts
 */

import { ChatOpenAI } from "@langchain/openai";
import {
  SystemMessage,
  HumanMessage,
  AIMessage,
} from "@langchain/core/messages";

/* ------------------------------------------------------------------ */
/* 1. 数据准备：mock 检索结果（20 段，其中只有前 5 段与问题相关）        */
/* ------------------------------------------------------------------ */

interface RetrievedChunk {
  id: string;
  text: string;
  score: number; // 检索相关度 0~1
}

const QUESTION = "订单 ORD-20260815-001 发货 3 天后想退货，退款多久到账？";

// 前 5 段：真正相关（退货政策 / 退款时效 / 订单状态）
const RELEVANT_CHUNKS: RetrievedChunk[] = [
  {
    id: "doc-001",
    score: 0.92,
    text: "退货政策：签收后 7 天内支持无理由退货，商品需保持完好。退货申请通过后，商家会在 48 小时内确认收货。",
  },
  {
    id: "doc-002",
    score: 0.88,
    text: "退款时效：商家确认收货后，退款会在 1~3 个工作日内原路退回。使用花呗支付的订单，退款时效以支付渠道为准。",
  },
  {
    id: "doc-003",
    score: 0.85,
    text: "订单查询：在「我的订单」页面输入订单号（ORD- 开头）可查看物流与售后状态。发货后 3 天内可申请退货。",
  },
  {
    id: "doc-004",
    score: 0.79,
    text: "退货入口：订单详情页 → 申请售后 → 选择退货退款，填写原因后提交，系统自动生成退货单号。",
  },
  {
    id: "doc-005",
    score: 0.71,
    text: "常见问题：若超过 7 天未收到退款，请联系人工客服，并提供订单号与退款流水号以便核查。",
  },
];

// 后 15 段：检索召回噪声（来自其他文档：登录、发票、会员、评价……
// 刻意避开"退/款/单/货/收"等关键词，让"信号比"能真实反映污染程度）
const NOISE_CHUNKS: RetrievedChunk[] = [
  "登录问题：账号密码连续输错 5 次会被锁定 30 分钟，可通过手机验证码重置。",
  "发票说明：增值税普通发票在交易完成后 30 天内可申请补开，抬头需与账号实名一致。",
  "物流规则：偏远地区配送时效延长 1~2 天，新疆西藏等区域不支持次日达。",
  "会员积分：消费 1 元累计 1 积分，积分有效期 12 个月，过期自动清零。",
  "优惠券：满 200 减 20 的优惠券不可与店铺券叠加，使用规则以页面为准。",
  "地址管理：每个账号最多保存 20 个收货地址，默认地址可在设置中修改。",
  "支付方式：支持微信、支付宝、花呗、银行卡，分期免息活动以页面展示为准。",
  "售后时效：普通商品售后处理周期为 1~5 个工作日，大件家具需上门取件。",
  "隐私政策：平台承诺不向第三方出售用户个人信息，数据加密存储于境内机房。",
  "客服时间：在线客服 9:00~24:00 在线，夜间留言将在次日 9:00 前回复。",
  "账号安全：建议开启两步验证，异地登录时会触发短信验证码校验。",
  "库存说明：商品页展示的库存与实际仓库存可能存在 5 分钟以内的延迟。",
  "配送方式：默认顺丰，也可选择菜鸟驿站自提，自提点支持 7 天免费保管。",
  "评价体系：签收后 15 天内可评价，追加评价需在 90 天内完成。",
  "跨境商品：跨境商品不支持无理由退货，请在下单前仔细阅读关税说明。",
].map((text, i) => ({
  id: `noise-${String(i + 1).padStart(3, "0")}`,
  score: 0.05 + i * 0.01, // 噪声段分数极低，模拟召回误差
  text,
}));

const ALL_CHUNKS: RetrievedChunk[] = [...RELEVANT_CHUNKS, ...NOISE_CHUNKS];

// 20 轮完整历史（真实场景里会越攒越多）
function buildFullHistory(): { role: "user" | "assistant"; text: string }[] {
  const history = [];
  for (let i = 1; i <= 20; i += 1) {
    history.push({ role: "user", text: `第 ${i} 轮问题：随便问问 ${i}` });
    history.push({ role: "assistant", text: `第 ${i} 轮回答：这是历史回答 ${i}` });
  }
  return history;
}

/* ------------------------------------------------------------------ */
/* 2. 工具函数：token 估算、消息组装、模拟模型                           */
/* ------------------------------------------------------------------ */

// 粗略估算 token 数：英文约 4 字符/token，中文约 1~2 字符/token，这里统一按 2 算
function estimateTokens(text: string | number): number {
  const charCount = typeof text === "number" ? text : text.length;
  return Math.ceil(charCount / 2);
}

// 把 message.content（可能是 string，也可能是 content block 数组）转成纯文本
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const p = part as { type?: string; text?: string };
        return p.type === "text" ? (p.text ?? "") : "";
      })
      .join("");
  }
  return String(content ?? "");
}

// 上下文"有效信号比"：相关关键词命中次数 /（片段数 × 关键词数）。
// 占比越低，模型越容易被噪声淹没（这是上下文污染的核心机制）。
function signalRatio(chunks: RetrievedChunk[]): number {
  const KEYWORDS = ["退货", "退款", "订单", "收货"];
  let hits = 0;
  for (const chunk of chunks) {
    for (const kw of KEYWORDS) {
      if (chunk.text.includes(kw)) hits += 1;
    }
  }
  return hits / (Math.max(1, chunks.length) * KEYWORDS.length);
}

// 模拟模型：基于"信号比"决定回答质量。
// 这不是真的 LLM，而是把"上下文污染 → 答非所问"的机制显式建模出来，
// 让读者不依赖 API key 也能看到对比。
function mockAnswer(chunks: RetrievedChunk[]): string {
  const ratio = signalRatio(chunks);
  if (ratio < 0.3) {
    // 噪声占主导：模型"被带偏"，回答来自不相关的噪声片段
    return (
      `[模拟模型·被噪声污染] 抱歉，我在上下文里看到了太多不相关内容（信号比 ${ratio.toFixed(2)}），` +
      `只找到了这条：${NOISE_CHUNKS[0].text}`
    );
  }
  // 信号充足：模型正确引用退款时效
  const refund = RELEVANT_CHUNKS.find((c) => c.text.includes("退款时效"));
  return (
    `[模拟模型·回答正确] 您的订单签收 3 天，在 7 天无理由退货期内，可申请退货。` +
    `退款将在商家确认收货后 1~3 个工作日内原路退回（${refund?.text.slice(0, 30)}…）`
  );
}

// 组装 messages 并统计结构（教学重点：Message 结构与长度都在这里决定）
function assembleMessages(opts: {
  chunks: RetrievedChunk[];
  history: { role: "user" | "assistant"; text: string }[];
  truncatePerChunk?: number; // 每段最多保留多少字符
  maxHistoryTurns?: number; // 最多保留多少轮历史（user+assistant 算一轮）
}) {
  const { chunks, history } = opts;
  const truncatePerChunk = opts.truncatePerChunk ?? Number.POSITIVE_INFINITY;
  const maxHistoryTurns = opts.maxHistoryTurns ?? Number.POSITIVE_INFINITY;

  // 裁剪后的片段：只保留前 N 个字符，超长加省略号
  const trimmedChunks = chunks.map((c) =>
    c.text.length > truncatePerChunk
      ? c.text.slice(0, truncatePerChunk) + "…[已裁剪]"
      : c.text,
  );

  // 滑动窗口：只取最近 maxHistoryTurns 轮
  const recentHistory = history.slice(-maxHistoryTurns * 2);

  const messages = [
    new SystemMessage(
      "你是电商客服助手。只依据提供的文档片段回答问题；若文档中没有答案，请明确说不知道。",
    ),
    // 检索到的文档片段统一放进一个 HumanMessage（伪用户消息）中，
    // 这是 LangChain 社区处理 RAG 上下文的常见姿势，避免系统提示被撑爆。
    new HumanMessage({
      content: [
        { type: "text", text: "以下是检索到的文档片段：\n\n" },
        ...trimmedChunks.map((t, i) => ({
          type: "text" as const,
          text: `【片段 ${i + 1}】${t}\n`,
        })),
        { type: "text", text: `\n请回答用户问题：${QUESTION}` },
      ],
    }),
    ...recentHistory.map((turn) =>
      turn.role === "user"
        ? new HumanMessage(turn.text)
        : new AIMessage(turn.text),
    ),
  ];

  const totalChars = messages.reduce(
    (sum, m) => sum + contentToText(m.content).length,
    0,
  );
  return { messages, totalChars, totalTokens: estimateTokens(totalChars) };
}

/* ------------------------------------------------------------------ */
/* 3. 坏例子：20 段全塞 + 全量历史 → 上下文污染                          */
/* ------------------------------------------------------------------ */

function badExample() {
  console.log("========== 坏例子：上下文污染 ==========");
  const bad = assembleMessages({
    chunks: ALL_CHUNKS, // 20 段全塞进去
    history: buildFullHistory(), // 20 轮历史全量
    // 不裁剪、不做滑动窗口
  });

  console.log("组装后的 messages 结构：");
  bad.messages.forEach((m, i) => {
    const content = contentToText(m.content);
    console.log(
      `  [${i}] ${m.getType()} 类型，长度 ${content.length} 字符（≈${estimateTokens(content)} tokens）`,
    );
  });
  console.log(`总字符数：${bad.totalChars}，总 token 估算：${bad.totalTokens}`);
  console.log(`有效信号比：${signalRatio(ALL_CHUNKS).toFixed(3)}（< 0.3 = 噪声主导）`);
  console.log("");
  console.log(`用户问题：${QUESTION}`);
  console.log(`模型回答：${mockAnswer(ALL_CHUNKS)}`);
  console.log("");
}

/* ------------------------------------------------------------------ */
/* 4. 好例子：top-3 + 裁剪 + 滑动窗口                                    */
/* ------------------------------------------------------------------ */

function goodExample() {
  console.log("========== 好例子：上下文工程三板斧 ==========");

  // ① 只保留 top-3：按 score 降序取前 3
  const top3 = [...ALL_CHUNKS].sort((a, b) => b.score - a.score).slice(0, 3);
  console.log("① 筛选后保留的片段 id（按相关度排序）：", top3.map((c) => c.id).join(", "));

  // ② 裁剪：每段最多 60 字符，超长截断
  // ③ 历史滑动窗口：只留最近 3 轮
  const good = assembleMessages({
    chunks: top3,
    history: buildFullHistory(),
    truncatePerChunk: 60,
    maxHistoryTurns: 3,
  });

  good.messages.forEach((m, i) => {
    const content = contentToText(m.content);
    console.log(
      `  [${i}] ${m.getType()} 类型，长度 ${content.length} 字符（≈${estimateTokens(content)} tokens）`,
    );
  });
  console.log(`总字符数：${good.totalChars}，总 token 估算：${good.totalTokens}`);
  console.log(`有效信号比：${signalRatio(top3).toFixed(3)}（≥ 0.3 = 信号充足）`);
  console.log("");
  console.log(`用户问题：${QUESTION}`);
  console.log(`模型回答：${mockAnswer(top3)}`);
  console.log("");
}

/* ------------------------------------------------------------------ */
/* 5. 真实 LLM 对照（可选）：需要 OPENAI_API_KEY                          */
/* ------------------------------------------------------------------ */

async function realLLMExample() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log(
      "【真实 LLM 对照】跳过：未设置 OPENAI_API_KEY。设置后可用真实模型对比两个版本的输出。",
    );
    return;
  }

  const model = new ChatOpenAI({
    model: "gpt-4o-mini",
    apiKey,
    temperature: 0,
  });

  try {
    const bad = assembleMessages({
      chunks: ALL_CHUNKS,
      history: buildFullHistory(),
    });
    const good = assembleMessages({
      chunks: [...ALL_CHUNKS].sort((a, b) => b.score - a.score).slice(0, 3),
      history: buildFullHistory(),
      truncatePerChunk: 60,
      maxHistoryTurns: 3,
    });

    console.log("========== 真实 LLM 对照 ==========");
    console.log("--- 坏上下文回答 ---");
    console.log((await model.invoke(bad.messages)).content);
    console.log("--- 好上下文回答 ---");
    console.log((await model.invoke(good.messages)).content);
  } catch (err) {
    // 网络不可用 / key 无效时兜底，不中断演示
    console.log("真实 LLM 调用失败（已兜底，不影响上面的 mock 演示）：", (err as Error).message);
  }
  console.log("");
}

/* ------------------------------------------------------------------ */
/* 6. main：按顺序跑完三部分                                            */
/* ------------------------------------------------------------------ */

async function main() {
  badExample();
  goodExample();
  await realLLMExample();

  console.log("========== 结论 ==========");
  console.log(
    "上下文污染不是提示词写得不够好，而是'放进去的东西不对'：\n" +
      "  坏例子：20 段 + 全量历史 → 噪声稀释信号，模型答非所问；\n" +
      "  好例子：top-3 + 裁剪 + 滑动窗口 → 同样的问题模型能答对。\n" +
      "工程上这三招对应：检索重排（rerank）、片段截断、历史窗口（memory 管理）。",
  );
}

main().catch((err) => {
  console.error("main 执行失败：", err);
  process.exitCode = 1;
});
