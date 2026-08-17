import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage, AIMessage } from "@langchain/core/messages";

interface RetrievedChunk { id: string; text: string; score: number; }

const QUESTION = "订单 ORD-20260815-001 发货 3 天后想退货，退款多久到账？";

const RELEVANT: RetrievedChunk[] = [
  { id: "doc-001", score: 0.92, text: "退货政策：签收后 7 天内支持无理由退货，商品需保持完好。退货申请通过后，商家会在 48 小时内确认收货。" },
  { id: "doc-002", score: 0.88, text: "退款时效：商家确认收货后，退款会在 1~3 个工作日内原路退回。使用花呗支付的订单，退款时效以支付渠道为准。" },
  { id: "doc-003", score: 0.85, text: "订单查询：在「我的订单」页面输入订单号（ORD- 开头）可查看物流与售后状态。发货后 3 天内可申请退货。" },
  { id: "doc-004", score: 0.79, text: "退货入口：订单详情页 → 申请售后 → 选择退货退款，填写原因后提交，系统自动生成退货单号。" },
  { id: "doc-005", score: 0.71, text: "常见问题：若超过 7 天未收到退款，请联系人工客服，并提供订单号与退款流水号以便核查。" },
];

const NOISE: RetrievedChunk[] = [
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
].map((text, i) => ({ id: `noise-${String(i + 1).padStart(3, "0")}`, score: 0.05 + i * 0.01, text }));

const ALL = [...RELEVANT, ...NOISE];

function buildHistory() { const h = []; for (let i = 1; i <= 20; i++) { h.push({ role: "user" as const, text: `第${i}轮问题` }); h.push({ role: "assistant" as const, text: `第${i}轮回答` }); } return h; }

function signalRatio(chunks: RetrievedChunk[]): number {
  const KW = ["退货", "退款", "订单", "收货"]; let hits = 0;
  for (const c of chunks) for (const kw of KW) if (c.text.includes(kw)) hits++;
  return hits / (Math.max(1, chunks.length) * KW.length);
}

function mockAnswer(chunks: RetrievedChunk[]): string {
  const ratio = signalRatio(chunks);
  if (ratio < 0.3) return `[被噪声污染] 信号比 ${ratio.toFixed(2)}，模型被大量无关内容淹没，答非所问`;
  return `[回答正确] 信号比 ${ratio.toFixed(2)}，您签收 3 天，在 7 天无理由退货期内，可申请退货。退款将在商家确认收货后 1~3 个工作日原路退回。`;
}

function contentToText(c: unknown): string { if (typeof c === "string") return c; if (Array.isArray(c)) return (c as any[]).map(p => p.type === "text" ? p.text ?? "" : "").join(""); return String(c ?? ""); }
function estTokens(s: string | number): number { return Math.ceil((typeof s === "number" ? s : s.length) / 2); }

function assemble(opts: { chunks: RetrievedChunk[]; history: any[]; truncate?: number; maxTurns?: number }) {
  const { chunks, history } = opts;
  const trunc = opts.truncate ?? Infinity;
  const mt = opts.maxTurns ?? Infinity;
  const trimmed = chunks.map(c => c.text.length > trunc ? c.text.slice(0, trunc) + "…[已裁剪]" : c.text);
  const recent = history.slice(-mt * 2);
  const msgs = [
    new SystemMessage("你是电商客服助手。只依据提供的文档片段回答问题；若文档中没有答案，请明确说不知道。"),
    new HumanMessage({ content: [{ type: "text", text: "以下是检索到的文档片段：\n\n" }, ...trimmed.map((t, i) => ({ type: "text" as const, text: `【片段 ${i + 1}】${t}\n` })), { type: "text", text: `\n请回答用户问题：${QUESTION}` }] }),
    ...recent.map(t => t.role === "user" ? new HumanMessage(t.text) : new AIMessage(t.text)),
  ];
  const total = msgs.reduce((s, m) => s + contentToText(m.content).length, 0);
  return { msgs, total, tokens: estTokens(total) };
}

async function main() {
  console.log("===== 坏例子：20 段全塞 + 全量历史 =====");
  const bad = assemble({ chunks: ALL, history: buildHistory() });
  console.log(`总字符: ${bad.total}, 约 ${bad.tokens} tokens`);
  console.log(`信号比: ${signalRatio(ALL).toFixed(2)}`);
  console.log(`回答: ${mockAnswer(ALL)}\n`);

  console.log("===== 好例子：top-3 + 裁剪 + 滑动窗口 =====");
  const top3 = [...ALL].sort((a, b) => b.score - a.score).slice(0, 3);
  const good = assemble({ chunks: top3, history: buildHistory(), truncate: 60, maxTurns: 3 });
  console.log(`总字符: ${good.total}, 约 ${good.tokens} tokens`);
  console.log(`信号比: ${signalRatio(top3).toFixed(2)}`);
  console.log(`回答: ${mockAnswer(top3)}\n`);
  console.log(`token 节省: ${Math.round((1 - good.tokens / bad.tokens) * 100)}%`);
}
main().catch(e => { console.error(e); process.exit(1); });
