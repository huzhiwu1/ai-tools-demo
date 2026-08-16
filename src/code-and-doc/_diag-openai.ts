import { ChatOpenAI } from "@langchain/openai";

const model = new ChatOpenAI({
  model: "deepseek-v4-flash",
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com/v1",
  temperature: 0,
});

async function main() {
  // 1) invoke（非流式）
  try {
    const r = await model.invoke("计算 42 * 8");
    console.log("invoke => OK:", String(r.content).slice(0, 60));
  } catch (e: any) {
    console.log("invoke => FAIL:", e.cause?.code ?? e.message);
  }
  // 2) stream（流式，LangGraph 内部常用）
  try {
    let acc = "";
    for await (const chunk of await model.stream("计算 42 * 8")) {
      acc += String(chunk.content ?? "");
    }
    console.log("stream => OK:", acc.slice(0, 60));
  } catch (e: any) {
    console.log("stream => FAIL:", e.cause?.code ?? e.message);
  }
}
main();
