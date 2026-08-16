import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

const PlanSchema = z.object({
  title: z.string(),
  summary: z.string(),
  steps: z.array(z.string()).min(2),
  risk: z.string(),
});

async function main() {
  const model = new ChatOpenAI({
    model: "gpt-5.4-mini",
    apiKey: process.env.LLM_API_KEY,
    baseURL: "https://llm.gw.dachensky.com/v1",
    temperature: 0,
  });

  const structured = model.withStructuredOutput(PlanSchema, {
    method: "jsonSchema",
    name: "daily_plan",
    strict: true,
  });

  const res = await structured.invoke(
    "把下面这个需求整理成一个小型实施计划：前端页面要接 LangGraph Agent，先做脏状态提示，再做重建恢复。",
  );

  console.log(JSON.stringify(res, null, 2));
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exitCode = 1;
});
