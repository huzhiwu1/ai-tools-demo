import { OpenAIEmbeddings } from "@langchain/openai";
import dotenv from "dotenv";
dotenv.config();

async function main() {
  const apiKey = process.env.API_KEY!;
  const baseUrl = process.env.BASE_URL!;
  const model = process.env.EMBEDDINGS_MODEL_NAME ?? "text-embedding-v3";

  console.log(`测试: ${model} @ ${baseUrl}`);
  const embeddings = new OpenAIEmbeddings({
    apiKey,
    model,
    configuration: { baseURL: baseUrl },
  });

  const vec = await embeddings.embedQuery("退货退款多久到账");
  console.log(`维度: ${vec.length}`);
  console.log(`前 5 个值: ${vec.slice(0, 5).map(v => v.toFixed(4)).join(", ")}`);
  console.log("✅ 生产级 embedding 可用");
}
main().catch(e => { console.error("❌", e.message); process.exit(1); });
