/**
 * DeepSeekClient - DeepSeek 官网 API 客户端（基于 LangChain ChatOpenAI）
 *
 * 职责：
 * - 封装 ChatOpenAI 实例，对接 DeepSeek 官网 API（OpenAI 兼容协议）
 * - 提供 chatStructured<T>() 方法：基于 withStructuredOutput 输出 zod 校验结果
 *
 * 流程：
 * 1. new ChatOpenAI() 创建 LangChain 模型实例
 * 2. withStructuredOutput(schema, { method: "jsonMode" }) 生成结构化 Runnable
 * 3. invoke(SystemMessage + HumanMessage) → LangChain 自动 JSON.parse + zod 校验
 * 4. 解析/校验失败自动重试（默认 1 次），重试耗尽抛错
 *
 * 为什么只能用 method: "jsonMode"（官网实测）：
 * - functionCalling：内部 tool_choice 强制指定函数，思考模型返回 400
 *   "Thinking mode does not support this tool_choice"
 * - jsonSchema（对非 OpenAI 模型还是默认值）：response_format json_schema
 *   官网返回 400 "This response_format type is unavailable now"
 * - jsonMode：response_format json_object，官网 200 支持，是唯一可行方案
 *
 * 关键细节：
 * - DeepSeek 官网 baseURL 必须带 /v1 后缀（OpenAI 兼容端点）
 * - 1.5.6 的 jsonMode 不会把 schema 注入 prompt，字段约束依赖调用方
 *   systemPrompt 中的字段描述 + 输出端 zod 校验
 * - 超时和重试由 ChatOpenAI 内置处理（maxRetries: 1, timeout: 60000，
 *   思考模型需要更长时间）
 */
import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { Logger } from "@nestjs/common";
import type { z } from "zod";

export interface DeepSeekConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /** 请求超时（毫秒），默认 60000；思考模型生成复杂 JSON 耗时较长 */
  timeout?: number;
}

export class DeepSeekClient {
  private readonly model: ChatOpenAI;
  /** 模型名提升为类字段，供日志打印 */
  private readonly modelName: string;
  private readonly logger = new Logger("DeepSeekClient");

  constructor(config?: DeepSeekConfig) {
    // 优先 LLM_*（官网 key/baseURL/model），fallback DEEPSEEK_*
    const apiKey =
      config?.apiKey ??
      process.env.LLM_API_KEY ??
      process.env.DEEPSEEK_API_KEY ??
      "";
    // DeepSeek 兼容端点必须含 /v1
    const baseURL =
      config?.baseUrl ??
      process.env.LLM_BASE_URL ??
      process.env.DEEPSEEK_BASE_URL ??
      "https://api.deepseek.com/v1";
    const modelName =
      config?.model ??
      process.env.LLM_MODEL ??
      process.env.DEEPSEEK_MODEL ??
      "deepseek-chat";

    if (!apiKey) {
      this.logger.warn(
        "[DeepSeekClient] DEEPSEEK_API_KEY 未设置，LLM 调用将失败",
      );
    }

    this.modelName = modelName;
    this.model = new ChatOpenAI({
      apiKey,
      configuration: { baseURL },
      model: modelName,
      temperature: 0.2,
      maxRetries: 1,
      // 默认 60 秒：思考模型（deepseek-v4-flash）规划/代码生成耗时常超 10 秒
      timeout: config?.timeout ?? 60_000,
    });
  }

  /**
   * 发送聊天请求，返回结构化输出
   *
   * 基于 withStructuredOutput(schema, { method: "jsonMode" })：LangChain 内部
   * 传 response_format json_object（官网唯一支持的模式），返回后自动
   * JSON.parse + zod 校验，失败抛错，由本方法捕获后重试。
   *
   * 为什么不走其他 method（官网实测）：
   * 1. functionCalling：tool_choice 强制指定函数，思考模型 400 拒绝
   * 2. jsonSchema：response_format json_schema，官网 400 不支持
   *
   * @param schema - zod schema，定义输出结构
   * @param systemPrompt - 系统提示词（需包含字段描述，jsonMode 不注入 schema）
   * @param userPrompt - 用户消息
   * @param maxRetries - 解析失败自动重试次数，默认 1（共最多 2 次调用）
   * @returns schema 类型安全的解析结果
   */
  async chatStructured<T extends z.ZodTypeAny>(
    schema: T,
    systemPrompt: string,
    userPrompt: string,
    maxRetries = 1,
  ): Promise<z.infer<T>> {
    const start = Date.now();
    // 调用前：debug 级别，记 model + 两端 prompt 前 100 字符（不打印完整 prompt）
    this.logger.debug(
      `[DeepSeek] -> ${this.modelName} system=${systemPrompt.slice(0, 100)} user=${userPrompt.slice(0, 100)}`,
    );

    // 显式指定 jsonMode：对非 OpenAI 模型默认 method 是 jsonSchema，官网会 400
    const structured = this.model.withStructuredOutput(schema, {
      method: "jsonMode",
      name: "extract",
    });

    // 记录最后一次失败原因，重试耗尽时拼进异常消息（给调用方排查线索）
    let lastError = "";

    // 循环重试：最多 maxRetries + 1 次（LangChain 已内置 JSON.parse + zod 校验）
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await structured.invoke([
          new SystemMessage(
            systemPrompt +
              "\n必须输出 JSON 对象，不要输出其他内容。constraints/riskHints 必须是字符串数组；steps 节点类型字段名是 nodeType；contracts 输入字段是 inputs、输出是 outputs。",
          ),
          new HumanMessage(userPrompt),
        ]);

        // 调用成功：info 级别，记耗时 + 模型
        this.logger.log(
          `[DeepSeek] chatStructured ok ${Date.now() - start}ms model=${this.modelName}`,
        );
        return result as z.infer<T>;
      } catch (e) {
        // JSON 解析失败 / zod 校验失败 / 网络错误：记录原因，继续重试
        lastError = (e as Error).message.slice(0, 200);
        this.logger.debug(
          `[DeepSeek] chatStructured 解析失败 (attempt ${attempt + 1}): ${lastError}`,
        );
      }
    }

    // 重试耗尽：error 级别日志 + 抛错（消息含最后失败摘要，前 200 字符）
    this.logger.error(
      `[DeepSeek] chatStructured ✗ ${Date.now() - start}ms ${lastError.slice(0, 200)}`,
    );
    throw new Error(
      `chatStructured 结构化输出失败（已重试 ${maxRetries} 次）：${lastError.slice(0, 200)}`,
    );
  }
}
