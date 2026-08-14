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
 *
 * 日志约定（便于排查“被谁调用 / 输入是什么 / 为啥失败”）：
 * - info：调用开始摘要（caller/model/schema 概要/prompt 长度）与成功记录
 * - verbose：完整 systemPrompt / userPrompt 原文
 * - warn：单次 attempt 失败（仍会重试）
 * - error：重试耗尽，含失败原因摘要
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
      // 关闭思考：reasoning_content 与正文共享 completion tokens，思考会吃掉
      // 大半预算导致长 JSON 截断。thinking disabled 后预算全部留给 JSON 输出。
      // 注意：若网关不支持该参数（静默忽略或 400），需回退为调大 maxTokens 方案。
      modelKwargs: { thinking: { type: "disabled" } },
      // 关闭思考后 JSON 独占预算，8192 足够规划输出（实测官网接受此值）
      maxTokens: 8192,
      // 默认 60 秒：规划/代码生成耗时长，需足够超时
      timeout: config?.timeout ?? 60_000,
    });
  }

  /**
   * 从当前调用栈解析出调用方代码位置，用于日志定位“被谁调用”
   *
   * 跳过本文件（deepseek.client）与 node_modules 内部帧，取第一个业务代码帧；
   * 若调用链全在框架内（如 LangGraph 异步调度丢失原始栈），退回首个非本文件帧。
   * 必须在 await 之前同步调用，await 之后调用栈已丢失。
   *
   * @returns “文件路径:行号”，无法解析时返回 “unknown”
   */
  private resolveCaller(): string {
    const stack = new Error().stack ?? "";
    let fallback = "";
    for (const frame of stack.split("\n").slice(1)) {
      const match =
        frame.match(/\((.*):(\d+):(\d+)\)$/) ??
        frame.match(/at (.*):(\d+):(\d+)$/);
      if (!match) continue;
      const file = match[1];
      if (file.includes("deepseek.client")) continue; // 本文件内部帧
      if (file.includes("node_modules")) {
        // 框架帧：记作兜底，继续向上找业务帧
        if (!fallback) fallback = `${file}:${match[2]}`;
        continue;
      }
      return `${file}:${match[2]}`;
    }
    return fallback || "unknown";
  }

  /**
   * 生成 schema 的日志概要：顶层描述 + 顶层字段名列表
   *
   * toJsonSchema 转换仅作日志展示，不参与请求（请求走 withStructuredOutput）。
   * @param schema - zod schema
   * @returns 如 `“LLM 规划输出” fields=[mode,name,steps,contracts]`
   */
  private describeSchema(schema: z.ZodTypeAny): string {
    try {
      const jsonSchema = toJsonSchema(schema) as {
        description?: string;
        properties?: Record<string, unknown>;
      };
      const fields = jsonSchema.properties
        ? Object.keys(jsonSchema.properties).join(",")
        : "";
      const desc = jsonSchema.description ?? "";
      return `${desc ? `${desc} ` : ""}fields=[${fields}]`;
    } catch {
      return "schema 不可序列化";
    }
  }

  /**
   * 把异常转成可读的失败原因摘要（日志与抛错共用）
   *
   * 处理三类信息：
   * 1. 错误类型与 HTTP 状态码（如 OpenAI APIError status=400）
   * 2. LangChain “Failed to parse. Text: ...” 格式：提取 JSON 头部并做截断
   *    启发式判断（以 { / [ 开头但未闭合 → 疑似 max_tokens 截断）
   * 3. 其余错误：消息前 500 字符
   *
   * @param e - 捕获的异常
   * @returns 管道符分隔的原因摘要
   */
  private describeError(e: unknown): string {
    const err = e as Error & { status?: number };
    const raw = err?.message ?? String(e);
    const parts: string[] = [];
    if (err?.name) parts.push(`type=${err.name}`);
    if (typeof err?.status === "number") parts.push(`status=${err.status}`);

    // LangChain StructuredOutputParser 失败格式：Failed to parse. Text: "...". Error: xxx
    // 注意：Text 是原始 JSON，内部引号未转义，不能用正则按引号配对提取，
    // 否则会在 JSON 内部第一个引号处提前终止（实测导致 zod 失败被误报成截断）。
    // 正确做法：以 "Failed to parse. Text: " 前缀定位 + 固定长度切片展示头部，
    // 以 ". Error: " 后缀提取失败原因，再按原因分类。
    const headIdx = raw.indexOf("Failed to parse. Text: ");
    if (headIdx >= 0) {
      const jsonHead = raw
        .slice(headIdx + 'Failed to parse. Text: "'.length, headIdx + 120)
        .replace(/\s+/g, " ");
      const causeMatch = raw.match(/\. Error: ([\s\S]*)$/);
      const cause = causeMatch
        ? causeMatch[1].slice(0, 300).replace(/\s+/g, " ")
        : "";
      // JSON.parse 阶段失败（JSON 未闭合）才是截断嫌疑；
      // zod 校验失败说明 JSON 完整但内容不符合 schema
      const isJsonParseError =
        /Unexpected (end|token)|in JSON at position|is not valid JSON/i.test(
          cause,
        );
      parts.push(
        `jsonHead=${jsonHead}`,
        isJsonParseError
          ? "疑似输出被截断（JSON 未闭合）"
          : "JSON 完整但内容不符（zod 校验失败）",
      );
      if (cause) parts.push(`cause=${cause}`);
    } else {
      parts.push(raw.slice(0, 500));
    }
    return parts.join(" | ");
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
    // 调用方位置：必须在 await 之前同步解析，await 后调用栈已丢失
    const caller = this.resolveCaller();

    // 调用开始：info 摘要（caller/model/schema 概要/prompt 长度）
    this.logger.log(
      `[DeepSeek] -> caller=${caller} model=${this.modelName} schema=${this.describeSchema(schema)} maxRetries=${maxRetries} systemLen=${systemPrompt.length} userLen=${userPrompt.length}`,
    );
    // 完整输入：verbose 级别（排查失败时查看原文）
    this.logger.verbose(
      `[DeepSeek] 完整输入 caller=${caller}\n--- systemPrompt ---\n${systemPrompt}\n--- userPrompt ---\n${userPrompt}`,
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
      const attemptStart = Date.now();
      try {
        const result = await structured.invoke([
          new SystemMessage(
            systemPrompt +
              "\n必须输出 JSON 对象，不要输出其他内容。constraints/riskHints 必须是字符串数组；steps 节点类型字段名是 nodeType；contracts 输入字段是 inputs、输出是 outputs。",
          ),
          new HumanMessage(userPrompt),
        ]);

        // 调用成功：info 级别，记单次/总耗时 + 调用方
        this.logger.log(
          `[DeepSeek] chatStructured ok caller=${caller} attempt=${attempt + 1}/${maxRetries + 1} ${Date.now() - attemptStart}ms total=${Date.now() - start}ms model=${this.modelName}`,
        );
        return result as z.infer<T>;
      } catch (e) {
        // 单次失败：warn 级别（后续仍会重试），原因含类型/状态码/截断判断
        lastError = this.describeError(e);
        this.logger.warn(
          `[DeepSeek] chatStructured 失败 caller=${caller} attempt=${attempt + 1}/${maxRetries + 1} ${Date.now() - attemptStart}ms ${lastError}`,
        );
      }
    }

    // 重试耗尽：error 级别 + 抛错（消息含调用方与原因摘要）
    this.logger.error(
      `[DeepSeek] chatStructured ✗ caller=${caller} total=${Date.now() - start}ms model=${this.modelName} ${lastError}`,
    );
    throw new Error(
      `chatStructured 结构化输出失败（已重试 ${maxRetries} 次，caller=${caller}，model=${this.modelName}）：${lastError}`,
    );
  }
}
