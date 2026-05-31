/**
 * 【第四站 - 2/3】AiService —— LangChain LCEL 链 + 流式输出
 *
 * 学习目标：
 *   1. 用 PromptTemplate.fromTemplate() 构造提示词
 *   2. 用 LCEL 的 .pipe() 把"提示词 → 模型 → 解析器"串成一条 Runnable 链
 *   3. 同一条链支持两种调用：invoke（一次性）和 stream（流式）
 *
 * 关键步骤：
 *   1. 通过 @Inject('CHAT_MODEL') 拿到 AiModule 工厂创建的 ChatOpenAI
 *   2. 在构造函数里"组装一次"链，作为类的私有字段保存（避免每次请求重建）
 *   3. runChain：返回完整字符串答案
 *   4. streamChain：用 async generator (`async function*`) 把 LangChain 流转成 JS 流
 *
 * 知识扩展（LCEL 是什么？为什么用 .pipe()？）：
 *   LCEL = LangChain Expression Language。它把 PromptTemplate / ChatModel /
 *   OutputParser 等都抽象成 Runnable，并暴露统一接口（invoke / stream / batch）。
 *   .pipe() 类似 Linux 管道：A.pipe(B) 表示 A 的输出作为 B 的输入。
 *
 *   类型流：
 *     prompt:  { query: string }       →  ChatPromptValue
 *     model:   ChatPromptValue          →  AIMessage（包含 content + 元数据）
 *     parser:  AIMessage                →  string
 *
 * 小白注意：
 *   - 千万不要在每个请求里重新 new PromptTemplate / 重新 .pipe()，性能浪费
 *   - StringOutputParser 只取 AIMessage.content；想要完整对象用 RunnablePassthrough
 *   - 流式输出的每个 chunk 都是字符串片段，前端自己拼起来即可
 */
import { Inject, Injectable } from "@nestjs/common";
import type { ChatOpenAI } from "@langchain/openai";
import { PromptTemplate } from "@langchain/core/prompts";
import type { Runnable } from "@langchain/core/runnables";
import { StringOutputParser } from "@langchain/core/output_parsers";

@Injectable()
export class AiService {
  private readonly chain: Runnable;

  constructor(@Inject("CHAT_MODEL") model: ChatOpenAI) {
    // 1) 提示词模板：{query} 是一个占位符，invoke 时传入 { query: '...' } 替换
    const prompt = PromptTemplate.fromTemplate(
      "你是一个友好的中文助手，请用简洁清晰的语言回答以下问题：\n\n{query}",
    );

    // 2) LCEL 链：提示词 → 模型 → 字符串解析
    this.chain = prompt.pipe(model).pipe(new StringOutputParser());
  }

  /**
   * 普通一次性调用：等模型完整生成后一次性返回字符串
   * 适用：后台任务、邮件生成、定时报表等不需要"边出边看"的场景
   */
  async runChain(query: string): Promise<string> {
    return this.chain.invoke({ query });
  }

  /**
   * 流式调用：用 async generator 把每个 chunk 逐个 yield 出去
   * 适用：聊天机器人、实时打字机效果，提升用户体感
   *
   * 调用方（Controller）会用 RxJS 的 from(...) 把 AsyncGenerator 转为 Observable
   */
  async *streamChain(query: string): AsyncGenerator<string> {
    const stream = await this.chain.stream({ query });
    for await (const chunk of stream) {
      yield chunk;
    }
  }
}
