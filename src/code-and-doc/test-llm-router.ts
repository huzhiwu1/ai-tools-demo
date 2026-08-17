import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

async function main() {
const key = process.env.DEEPSEEK_API_KEY;
if (!key) { console.log("无 key"); return; }

// 尝试直接用 string prompt 分类
const model = new ChatOpenAI({ model: "deepseek-chat", apiKey: key, temperature: 0, configuration: { baseURL: "https://api.deepseek.com", timeout: 10000 } });

const hardCases = ["订单显示已签收但实际没收到", "退单后多久能收到钱"];
for (const input of hardCases) {
  const rule = (() => { const t = input.toLowerCase(); if (/退|换|退款|退货/.test(t)) return "return"; if (/查.*订单|订单.*查|物流|到哪/.test(t)) return "order"; if (/人工|转人工|客服|投诉/.test(t)) return "human"; return "fallback"; })();
  const resp = await model.invoke(`分类以下用户输入，只回答 order/return/human/fallback 之一：\n"${input}"`);
  const llm = (resp.content as string).trim().toLowerCase();
  console.log(`"${input}" → 规则:${rule} | LLM:${llm}`);
}
}
main().catch(e => { console.error(e.message); process.exit(1); });
