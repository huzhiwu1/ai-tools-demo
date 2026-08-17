import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";
import { Embeddings } from "@langchain/core/embeddings";
import { Document } from "@langchain/core/documents";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";

// 自定义 Embedding：用字符级 n-gram 的 Jaccard 相似度替代余弦相似度
// 这不是生产级 embedding，但能真实演示 RAG 管道：分块→向量化→检索→上下文组装
class SimpleEmbeddings extends Embeddings {
  private dim: number;
  constructor(params?: { dim?: number }) { super(params || {}); this.dim = params?.dim || 256; }

  // 把文本转成固定长度的向量：字符级 bigram 哈希
  private textToVector(text: string): number[] {
    const vec = new Array(this.dim).fill(0);
    const lower = text.toLowerCase();
    for (let i = 0; i < lower.length - 1; i++) {
      const hash = (lower.charCodeAt(i) * 31 + lower.charCodeAt(i + 1)) % this.dim;
      vec[hash] += 1;
    }
    // 归一化
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map(v => v / mag);
  }

  async embedQuery(text: string): Promise<number[]> { return this.textToVector(text); }
  async embedDocuments(texts: string[]): Promise<number[][]> { return texts.map(t => this.textToVector(t)); }
}

const RAW_DOCS = [
  `退货政策 3.0（2026-08-01 修订）
退货期限：签收后 7 天内支持无理由退货，商品需保持完好。
特殊商品：食品、内衣、定制商品、跨境商品不支持无理由退货。
退货流程：订单详情页 → 申请售后 → 选择退货退款 → 填写原因 → 提交申请。
审核时效：商家在 24 小时内审核退货申请，审核通过后系统生成退货单号。
签收确认：商家收到退货商品后 48 小时内完成签收确认。`,

  `退款时效与规则（2026-06-15 生效）
退款触发条件：商家确认收到退货商品后，系统自动发起退款。
退款到账时间：支付宝/微信支付 1-3 个工作日，银行卡 3-7 个工作日，花呗以支付渠道为准。
退款路径：原路退回，不支持更换退款账户。
退款金额：全额退款 = 商品金额 + 原始运费。
退款失败处理：若 7 个工作日未到账，联系人工客服并提供订单号。`,

  `订单查询与物流追踪
订单号格式：ORD-YYYYMMDD-XXX（如 ORD-20260815-001）。
查询入口：我的订单 → 输入订单号或手机号 → 查看订单详情。
物流状态：待发货 / 已发货 / 运输中 / 已签收 / 异常。
发货时效：现货商品下单后 24 小时内发货，预售商品以页面标注为准。`,

  `会员积分体系（2026 版）
积分获取：消费 1 元累计 1 积分，评价商品额外奖励 10 积分。
积分有效期：自获取之日起 12 个月，过期自动清零。
积分使用：100 积分 = 1 元，可在下单时抵扣，单笔订单最多抵扣 50%。
积分等级：普通会员 / 银卡（5000 积分）/ 金卡（20000 积分）/ 钻石（50000 积分）。`,

  `平台支付方式说明
支持支付方式：微信支付、支付宝、花呗、银行卡、Apple Pay。
分期付款：花呗支持 3/6/12 期免息分期（限指定商品）。
支付安全：所有支付链路采用 HTTPS + SSL 加密，PCI DSS 三级认证。
支付异常：扣款成功但订单未生成，系统在 30 分钟内自动退款。`,

  `客服体系与投诉处理
在线客服：9:00-24:00（工作日），10:00-22:00（节假日）。
电话客服：400-XXX-XXXX（工作日 9:00-18:00）。
投诉处理流程：提交投诉 → 客服 2 小时内响应 → 24 小时内给出处理方案 → 72 小时内结案。`,

  `促销活动与优惠券规则
优惠券类型：满减券、折扣券、免邮券、新用户专享券。
使用规则：每笔订单限用一张优惠券，不可与店铺券叠加。
优惠券有效期：领取后 7-30 天不等，过期作废。
退款场景：使用优惠券的订单退款时，优惠券金额按比例退回。`,

  `账号安全与隐私保护
账号注册：手机号实名注册，一个手机号仅限一个账号。
安全设置：建议开启两步验证（短信验证码 + 登录密码）。
异地登录保护：检测到异地登录自动触发短信验证。
隐私政策：用户数据加密存储，不向第三方出售个人信息。`,

  `配送与收货规则
配送范围：全国（港澳台除外），偏远地区加收配送费。
配送时效：一线城市次日达，二三线城市 2-3 天，偏远地区 5-7 天。
签收规则：签收时请当面验货，如有破损可拒收并联系客服。`,

  `售后与维修服务
售后范围：商品质量问题、功能故障、外观损坏（非人为）。
售后期限：签收后 7 天内可退货，15 天内可换货，1 年内保修。
维修费用：保修期内非人为损坏免费维修，人为损坏收取维修费。`,
];

async function main() {
  // 1. 文档分块：RecursiveCharacterTextSplitter
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 150, chunkOverlap: 20,
    separators: ["\n\n", "\n", "。", "；", "，", " ", ""],
  });
  const chunks = await splitter.splitDocuments(
    RAW_DOCS.map((t, i) => new Document({ pageContent: t, metadata: { docId: `doc-${i + 1}` } }))
  );
  console.log(`分块: ${RAW_DOCS.length} 篇文档 → ${chunks.length} 个 chunk\n`);

  // 2. Embedding + 向量库
  const embeddings = new SimpleEmbeddings({ dim: 256 });
  const vectorStore = await MemoryVectorStore.fromDocuments(chunks, embeddings);

  const QUESTION = "我的订单 ORD-20260815-001 发货 3 天了，想退货，退款多久能到账？";
  const rawResults = await vectorStore.similaritySearchWithScore(QUESTION, 20);

  // 3. 坏上下文：20 段全塞
  const badContext = rawResults.map((r, i) => `【${i + 1}】${r[0].pageContent}`).join("\n\n");
  const badMessages = [
    new SystemMessage("你是电商客服助手。只依据提供的文档片段回答问题。"),
    new HumanMessage(`以下是检索到的文档片段：\n\n${badContext}\n\n请回答用户问题：${QUESTION}`),
  ];
  const badTokens = badMessages.reduce((s, m) => s + Math.ceil(String(m.content).length / 2), 0);

  // 4. 好上下文：top-3 + 裁剪
  const top3 = rawResults.slice(0, 3);
  const goodContext = top3.map((r, i) => {
    const t = r[0].pageContent;
    return `【${i + 1}】${t.length > 120 ? t.slice(0, 120) + "…" : t}`;
  }).join("\n\n");
  const goodMessages = [
    new SystemMessage("你是电商客服助手。只依据提供的文档片段回答问题。"),
    new HumanMessage(`以下是检索到的文档片段：\n\n${goodContext}\n\n请回答用户问题：${QUESTION}`),
  ];
  const goodTokens = goodMessages.reduce((s, m) => s + Math.ceil(String(m.content).length / 2), 0);

  // 5. 输出对比
  console.log("===== 坏上下文（20 段全塞）=====");
  console.log(`chunk: ${rawResults.length}, ~${badTokens} tokens`);
  console.log(`Top-3 相似度: ${top3.map(r => r[1].toFixed(3)).join(", ")}`);
  console.log(`剩余 17 段平均: ${(rawResults.slice(3).reduce((s, r) => s + r[1], 0) / 17).toFixed(3)}`);
  console.log(`\n检索到的 chunk 来源分布:`);
  const sourceCount: Record<string, number> = {};
  rawResults.forEach(r => { const s = (r[0].metadata as any).docId; sourceCount[s] = (sourceCount[s] || 0) + 1; });
  Object.entries(sourceCount).sort().forEach(([k, v]) => console.log(`  ${k}: ${v} chunk(s)`));

  console.log("\n===== 好上下文（top-3 + 裁剪）=====");
  console.log(`chunk: ${top3.length}, ~${goodTokens} tokens`);
  top3.forEach((r, i) => console.log(`  [${i + 1}] ${r[0].pageContent.slice(0, 60)}... (${r[1].toFixed(3)})`));
  console.log(`\n📊 token 节省: ${Math.round((1 - goodTokens / badTokens) * 100)}%`);

  // 6. LLM 对比
  const key = process.env.DEEPSEEK_API_KEY;
  if (key) {
    const model = new ChatOpenAI({ model: "deepseek-chat", apiKey: key, temperature: 0, configuration: { baseURL: "https://api.deepseek.com", timeout: 15000 } });
    console.log("\n===== LLM 对比 =====");
    const [badResp, goodResp] = await Promise.all([model.invoke(badMessages), model.invoke(goodMessages)]);
    console.log("坏上下文:\n", String(badResp.content).slice(0, 300));
    console.log("\n好上下文:\n", String(goodResp.content).slice(0, 300));
  }
}
main().catch(e => { console.error(e.message); process.exit(1); });
