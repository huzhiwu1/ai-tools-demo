import { ChatOpenAI } from "@langchain/openai";

async function main() {
  const model = new ChatOpenAI({
    model: "gpt-5.4-mini",
    apiKey: process.env.LLM_API_KEY,
    baseURL: "https://llm.gw.dachensky.com/v1",
    temperature: 0,
  });

  const res = await model.invoke("只回复 ok");
  console.log(String(res.content));
}

main().catch((err) => {
  console.error("FAILED:", err?.message ?? err);
  process.exitCode = 1;
});
