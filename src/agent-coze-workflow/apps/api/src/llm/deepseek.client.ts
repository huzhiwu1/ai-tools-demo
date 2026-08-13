/**
 * DeepSeekClient - DeepSeek API 客户端（基于 LangChain ChatOpenAI）
 *
 * 职责：
 * - 封装 ChatOpenAI 实例，对接 DeepSeek API（OpenAI 兼容协议）
 * - 提供 chatStructured<T>() 方法：zod schema → 手动 json_schema → JSON.parse + safeParse 校验
 *
 * 流程：
 * 1. new ChatOpenAI() 创建 LangChain 模型实例
 * 2. toJsonSchema(schema) 转纯 JSON schema（绕开 zod helper 的 tool_choice 路径）
 * 3. invoke(response_format json_schema + strict) → JSON.parse → schema.safeParse 校验
 * 4. 校验失败自动重试（默认 1 次），重试耗尽抛错
 *
 * 关键细节：
 * - DeepSeek API 的 baseURL 必须带 /v1 后缀（OpenAI 兼容端点）
 * - 网关 deepseek-v4-flash 是思考模式：不支持 tool_choice，jsonMode 字段漂移，仅手动 json_schema + strict 稳定
 * - 超时和重试由 ChatOpenAI 内置处理（maxRetries: 1, timeout: 60000，思考模型需要更长时间）
 */
import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
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
    // 优先 dachensky 网关（LLM_*，支持思考+工具调用），fallback 官方 DeepSeek（DEEPSEEK_*）
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
   * 手动 json_schema 流程：toJsonSchema 转纯 JSON schema，通过 response_format
   * （type=json_schema + strict）约束 LLM 输出，返回后 JSON.parse + safeParse 校验，
   * 失败自动重试。
   *
   * 为什么不走 withStructuredOutput：
   * 1. jsonMode 只保证是 JSON，不保证 schema，字段漂移率高
   * 2. jsonSchema 方法内部走 OpenAI SDK 的 zod helper，转成 tool_choice，网关思考模式拒绝
   * 3. functionCalling 同理（tool_choice=required 实测 400 InvalidParameter）
   *
   * @param schema - zod schema，定义输出结构
   * @param systemPrompt - 系统提示词
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

    // 1. zod schema → 纯 JSON schema
    //    不传 zod 对象给 OpenAI SDK，绕开 zod helper 的 tool_choice 路径
    const asJsonSchema = toJsonSchema(schema) as Record<string, unknown>;

    // 记录最后一次失败原因，重试耗尽时拼进异常消息（给调用方排查线索）
    let lastError = "";

    // 2. 循环重试：最多 maxRetries + 1 次
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // 手动传 response_format（json_schema + strict）
        // 网关实测：strict 模式字段约束最强，是三种方案中唯一稳定通过 safeParse 的
        const res = await this.model.invoke(
          [
            new SystemMessage(
              systemPrompt +
                "\n必须输出 JSON 对象，不要输出其他内容。constraints/riskHints 必须是字符串数组；steps 节点类型字段名是 nodeType；contracts 输入字段是 inputs、输出是 outputs。",
            ),
            new HumanMessage(userPrompt),
          ],
          {
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "extract",
                description: "结构化输出",
                schema: asJsonSchema,
                strict: true,
              },
            },
          } as unknown as any, // response_format 不是标准 CallOptions 字段，但 OpenAI 兼容端接受
        );

        // 3. 提取 content → JSON.parse → schema.safeParse
        const content =
          typeof res.content === "string"
            ? res.content
            : JSON.stringify(res.content);
        const parsed = JSON.parse(content.trim());
        const checked = schema.safeParse(parsed);
        if (checked.success) {
          // 调用成功：info 级别，记耗时 + 模型
          this.logger.log(
            `[DeepSeek] chatStructured ok ${Date.now() - start}ms model=${this.modelName}`,
          );
          return checked.data as z.infer<T>;
        }
        // zod 校验失败：记录原因（前 3 条 issue），继续重试
        lastError = JSON.stringify(checked.error.issues.slice(0, 3));
        this.logger.debug(
          `[DeepSeek] chatStructured zod 校验失败 (attempt ${attempt + 1}): ${lastError}`,
        );
      } catch (e) {
        // JSON.parse 失败 / 网络错误：记录原因，继续重试
        lastError = (e as Error).message.slice(0, 200);
        this.logger.debug(
          `[DeepSeek] chatStructured 解析失败 (attempt ${attempt + 1}): ${lastError}`,
        );
      }
    }

    // 4. 重试耗尽：error 级别日志 + 抛错（消息含最后失败摘要，前 200 字符）
    this.logger.error(
      `[DeepSeek] chatStructured ✗ ${Date.now() - start}ms ${lastError.slice(0, 200)}`,
    );
    throw new Error(
      `chatStructured 结构化输出失败（已重试 ${maxRetries} 次）：${lastError.slice(0, 200)}`,
    );
  }
}
