/**
 * [DashScope Rerank 重排序器]
 *
 * 职责：封装阿里云 DashScope Rerank API，实现文档重排序
 *       继承 LangChain 的 BaseDocumentCompressor 接口
 *
 * 流程：
 * 1. 接收一组文档和用户查询
 * 2. 将所有文档的 pageContent 和查询发送给 Rerank API
 * 3. Rerank 模型返回按相关度排序的索引列表
 * 4. 按索引重新排列文档，返回 topN 个最相关的文档
 *
 * 关键细节：
 * - Rerank 的作用：ES/Milvus 检索出来的文档相关度可能参差不齐
 *   Rerank 模型可以"二次打分"，把真正相关的文档排到前面
 * - topN 控制返回的文档数量，一般设为 3-5
 * - 继承 BaseDocumentCompressor 使其可以无缝集成到 LangChain 检索链中
 *
 * 为什么需要 Rerank？
 *   ES 按 BM25 评分，Milvus 按向量距离评分，两者评分不可比
 *   混合检索合并后顺序可能不合理，需要 Rerank 模型统一打分重排
 *
 * 运行方式：被 hybrid-retrieval.mjs 引用，或通过 test.mjs 单独测试
 */
import "dotenv/config";
import { BaseDocumentCompressor } from "@langchain/core/retrievers/document_compressors";

export class DashScopeRerank extends BaseDocumentCompressor {
  /**
   * @param {Object} options
   * @param {string} options.apiKey  - DashScope API Key
   * @param {string} [options.model] - Rerank 模型名称，默认 qwen3-rerank
   * @param {number} [options.topN]  - 返回最相关的 topN 个文档，默认 3
   * @param {string} [options.baseUrl] - Rerank API 地址
   */
  constructor({ apiKey, model = "qwen3-rerank", topN = 3, baseUrl } = {}) {
    super();
    this.apiKey = apiKey;
    this.model = model;
    this.topN = topN;
    this.baseUrl = baseUrl ?? process.env.RERANK_URL;
  }

  /**
   * 重排序文档
   *
   * @param {Document[]} documents - 待排序的文档列表
   * @param {string} query - 用户查询
   * @returns {Document[]} - 按 Rerank 分数排序后的 topN 文档
   */
  async compressDocuments(documents, query, _callbacks) {
    // 调用 DashScope Rerank API
    const res = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: {
          query,
          // 只传文档的文本内容，不传 metadata
          documents: documents.map((d) => d.pageContent),
        },
        parameters: {
          return_documents: false, // 不需要返回文档原文，只需要索引
          top_n: this.topN, // 返回最相关的 topN 个
        },
      }),
    });

    const json = await res.json();
    if (!res.ok) {
      throw new Error(
        `DashScope rerank ${res.status}: ${JSON.stringify(json)}`,
      );
    }

    // Rerank API 返回 results 数组，每个元素包含 index 和 relevance_score
    // index 是原始文档数组的下标
    const results = json?.output?.results;
    if (!Array.isArray(results)) {
      throw new Error(`unexpected rerank response: ${JSON.stringify(json)}`);
    }

    // 按返回的索引从原始文档数组中取出对应文档
    return results.map((item) => documents[item.index]);
  }
}
