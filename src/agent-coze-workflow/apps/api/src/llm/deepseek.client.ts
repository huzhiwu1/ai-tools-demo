/**
 * DeepSeekClient - DeepSeek API 客户端（基于 LangChain ChatOpenAI）
 *
 * 职责：
 * - 封装 ChatOpenAI 实例，对接 DeepSeek API（OpenAI 兼容协议）
 * - 提供 chatStructured<T>() 方法：zod schema → withStructuredOutput → 类型安全输出
 *
 * 流程：
 * 1. new ChatOpenAI() 创建 LangChain 模型实例
 * 2. withStructuredOutput(schema) 绑定结构化输出能力
 * 3. invoke([SystemMessage, HumanMessage]) 获取类型安全结果
 *
 * 关键细节：
 * - DeepSeek API 的 baseURL 必须带 /v1 后缀（OpenAI 兼容端点）
 * - withStructuredOutput 自动处理 JSON 格式指令和解析，无需手写容错代码
 * - 超时和重试由 ChatOpenAI 内置处理（maxRetries: 1, timeout: 10000）
 */
import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import type { z } from "zod";

export interface DeepSeekConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

export class DeepSeekClient {
  private model: ChatOpenAI;

  constructor(config?: DeepSeekConfig) {
    const apiKey = config?.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "";
    // DeepSeek 兼容端点必须含 /v1
    const baseURL =
      config?.baseUrl ??
      process.env.DEEPSEEK_BASE_URL ??
      "https://api.deepseek.com/v1";
    const modelName =
      config?.model ?? process.env.DEEPSEEK_MODEL ?? "deepseek-chat";

    if (!apiKey) {
      console.warn("[DeepSeekClient] DEEPSEEK_API_KEY 未设置，LLM 调用将失败");
    }

    this.model = new ChatOpenAI({
      apiKey,
      configuration: { baseURL },
      model: modelName,
      temperature: 0.2,
      maxRetries: 1,
      timeout: 10_000,
    });
  }

  /**
   * 发送聊天请求，返回结构化输出
   *
   * 内部用 withStructuredOutput 绑定 zod schema，LLM 按 schema 约束生成，
   * LangChain 自动解析为类型安全的 T。
   *
   * @param schema - zod schema，定义输出结构
   * @param systemPrompt - 系统提示词
   * @param userPrompt - 用户消息
   * @returns schema 类型安全的解析结果
   */
  async chatStructured<T extends z.ZodTypeAny>(
    schema: T,
    systemPrompt: string,
    userPrompt: string,
  ): Promise<z.infer<T>> {
    // 使用 function_calling 模式：DeepSeek 不支持 response_format json_object，
    // 但支持 tool calling，LangChain 会将 zod schema 映射为 function 参数定义
    const structuredModel = this.model.withStructuredOutput(schema, {
      method: "functionCalling",
    });
    const result = await structuredModel.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ]);
    return result as z.infer<T>;
  }
}
