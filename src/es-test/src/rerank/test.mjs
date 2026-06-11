/**
 * [Rerank 功能独立测试]
 *
 * 职责：不依赖 ES/Milvus，单独测试 DashScope Rerank 是否正常工作
 *
 * 流程：
 * 1. 创建 3 个测试文档
 * 2. 用 Rerank 模型对文档按查询相关度排序
 * 3. 打印重排后的文档顺序
 *
 * 关键细节：
 * - 这是验证 Rerank API 是否可用的最小测试
 * - 如果这个脚本能跑通，说明 API Key 和网络都没问题
 * - 运行前确保 .env 中的 OPENAI_API_KEY 已正确配置
 *
 * 运行方式：node src/rerank/test.mjs
 */
import "dotenv/config";
import { Document } from "@langchain/core/documents";
import { DashScopeRerank } from "./dashscope-rerank.mjs";

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;

  // 创建 Rerank 重排序器实例
  const compressor = new DashScopeRerank({ apiKey, topN: 3 });

  // 测试查询
  const query = "什么是文本排序模型";

  // 创建 3 个测试文档
  // 文档1：与查询直接相关
  // 文档2：与查询完全无关
  // 文档3：与查询部分相关
  const docs = [
    new Document({
      pageContent: "预训练语言模型的发展给文本排序模型带来了新的进展",
    }),
    new Document({
      pageContent: "量子计算是计算科学的一个前沿领域",
    }),
    new Document({
      pageContent: "文本排序模型广泛用于搜索引擎和推荐系统中…",
    }),
  ];

  console.log("原始文档顺序：");
  for (let i = 0; i < docs.length; i++) {
    console.log(`  [${i}] ${docs[i].pageContent}`);
  }

  // 执行重排序
  // Rerank 模型会根据 query 对文档重新打分排序
  // 最相关的文档会排在最前面
  const ranked = await compressor.compressDocuments(docs, query);

  console.log("\n重排后顺序（按与查询的相关度从高到低）：");
  for (const d of ranked) {
    console.log(`  - ${d.pageContent}`);
  }

  console.log("\n✅ Rerank 测试完成！");
  console.log("💡 可以看到与「文本排序模型」最相关的文档被排到了最前面");
}

main();
