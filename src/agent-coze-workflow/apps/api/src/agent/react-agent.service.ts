/**
 * ReactAgentService - ReAct Agent 核心服务
 *
 * 职责：
 * 管理 createReactAgent 实例的创建、流式对话、会话管理和 interrupt/resume 流程。
 *
 * 流程：
 * 1. 每个会话创建独立的 graph 实例（含 MemorySaver checkpointer）
 * 2. chat()：接收用户消息 → streamEvents 迭代 → 写 Data Stream 协议事件 → 检测 interrupt
 * 3. resume()：Command({ resume: answer }) → 继续 streamEvents
 *
 * 输出协议：Vercel AI SDK Data Stream Protocol
 * - 0:"text"   → LLM 文本增量（前端 useChat 自动拼接）
 * - d:{...}    → 结构化数据（session/tool_start/tool_end/interrupt/done/error）
 * - e:{...}    → 流结束标记（finish）
 * Content-Type 保持 text/event-stream（useChat 用 fetch 读流，兼容）
 *
 * 关键细节：
 * - MemorySaver 不支持跨实例恢复，每个会话必须缓存独立的 graph
 * - 多轮对话：messages 拼入 history，同时 checkpointer 按 thread_id 自动恢复状态
 * - interrupt 检测：stream 结束后通过 graph.getState(config) 读取 interrupt 值
 * - 客户端断开时停止迭代，避免内存泄漏
 */

import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import { MemorySaver, Command } from "@langchain/langgraph";
import {
  SystemMessage,
  HumanMessage,
  AIMessage,
} from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Logger } from "@nestjs/common";
import { ALL_TOOLS } from "./tools";
import { sessionStore } from "./session.store";
import type { Session } from "./session.store";
import { uploadPathStore } from "./upload-store";

/**
 * SSE 响应最小接口（避免引入 @types/express 依赖）
 *
 * 只声明写 SSE 流所需的方法，与 NestJS/Express 的 Response 兼容。
 */
interface SSEResponse {
  setHeader(name: string, value: string): void;
  flushHeaders(): void;
  write(chunk: string): boolean;
  end(): void;
  destroyed: boolean;
}

// ============================================
// 系统提示词
// ============================================

const SYSTEM_PROMPT = `你是 Coze 工作流构建助手，根据用户需求，使用工具自主完成工作流的设计、生成、部署、试运行和验证迭代。

## 可用工具
1. clarify_question: 当用户需求信息不完整时调用（缺少数据源、格式约定、输出要求等），暂停等待用户回答
2. read_file: 通用文件读取，返回文件原始内容。文件的具体用途、列含义、数据如何参与工作流，由你（LLM）根据用户需求判断
3. plan_workflow: 将用户需求分析为结构化工作流规划（WorkflowPlan）
4. generate_workflow: 将规划结果映射为 Coze 平台可部署的工作流 JSON
5. save_to_coze: 将工作流部署到 Coze 平台
6. test_run_workflow: 试运行已部署的工作流
7. batch_validate: 批量试运行已部署的工作流，对照期望值验证准确性，返回准确率 + 错误明细 + 归因分组
8. update_workflow: 根据归因分析结果修改工作流节点（阈值/代码/逻辑/prompt/提示词/数据/常量），返回修改后的完整 workflow
9. rename_workflow: 修改已创建工作流的名称/描述（不走 save，不影响工作流内容）

## 使用规则
- 先分析需求是否完整，缺信息时优先调用 clarify_question
- 规划→生成→部署→试运行，按顺序执行
- 每一步完成后检查结果，再决定下一步
- 工具调用失败时，将错误信息告知用户
- save_to_coze 提示"工作流名称已存在"时：工具会自动加后缀重试；若仍需指定名称，用 rename_workflow 改名后重新保存
- rename_workflow 只改名称/描述，不影响工作流内容

## 防死循环规则（必须遵守）
- 同一个工具连续失败 2 次 → 立即停止重试该工具，向用户说明失败原因，询问如何处理
- save_to_coze 返回"authentication failed" / "access denied" → 这是平台凭证问题，不是工作流问题！
  不要修改工作流、不要反复保存，直接告知用户"COZE_SESSION_KEY 可能过期，请检查 .env 后重试"
- update_workflow 返回"无法识别修改类型" → 重新组织 fixInstruction（明确写类型：阈值/代码/逻辑/prompt/提示词/数据/常量），最多再试 1 次，仍失败就停止并告知用户
- batch_validate / update_workflow 有系统级迭代上限（3 轮），由代码强制，达到后工具返回"已达迭代上限"错误
  收到该错误时必须停止迭代并汇报结果，不要尝试绕过或继续修改
- 任何时候：如果发现自己在重复做同样的事（同一工具、同一参数、同一错误），立即停止，向用户说明，而不是继续循环

## 文件与验证流程（当用户上传文件或要求验证时）
1. 用户上传文件 → 消息里会附「本地路径」，用 read_file 读该路径（通用读取，不做业务假设）
2. 根据用户需求 + 文件内容，判断：
   - 文件是干什么的？（数据源？期望结果？参考文档？）
   - 信息是否完整？是否还缺关键信息（如判断标准、字段含义、输出格式）？
   - 不确定 → 调用 clarify_question 向用户询问
3. 完全理解需求后，再 plan_workflow 设计工作流
4. generate_workflow 生成 → 检查 validation
5. save_to_coze 保存 → 拿 workflowId
6. batch_validate 批量试运行（cases 由 LLM 根据文件内容构造）→ 看 accuracy
7. 若 accuracy < 100%：分析 failurePatterns → 给出 fixInstruction → update_workflow → 重新 save → batch_validate
8. batch_validate / update_workflow 有系统级迭代上限（3 轮），达到后工具会返回"已达迭代上限"错误
   收到该错误时必须停止迭代，向用户汇报当前结果（准确率 + 失败分析），不要尝试绕过或继续修改
9. 验证通过：总结交付（含最终 workflowId 和 accuracy）

## 输出格式
- 思考过程：用自然语言解释当前步骤
- 工具调用：按需调用对应工具
- 最终答案：完成后总结整个流程（含 workflowId 等关键信息）`;

// ============================================
// LLM 实例（模块级单例，所有会话共享）
// ============================================

/** 共享 LLM 实例：ChatOpenAI 内部有连接池，无需每个会话 new */
const llm = new ChatOpenAI({
  model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
  apiKey: process.env.DEEPSEEK_API_KEY,
  configuration: {
    baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1",
  },
  temperature: 0.2,
});

// ============================================
// 服务类
// ============================================

export class ReactAgentService {
  private readonly logger = new Logger("Agent");

  /**
   * 创建新的 graph 实例（每个会话独立）
   *
   * 每个 graph 持有独立的 MemorySaver（checkpointer），
   * 确保 interrupt/resume 的状态隔离。
   *
   * 注意：@langchain/langgraph ^1.4.9 的 createReactAgent 直接返回
   * 编译后的 CompiledStateGraph，无需再调 .compile()。
   */
  private createGraph() {
    const checkpointer = new MemorySaver();
    return createReactAgent({
      llm,
      tools: [...ALL_TOOLS],
      checkpointer,
      prompt: new SystemMessage(SYSTEM_PROMPT),
      // 提高递归上限：默认 25 步，ReAct 循环含多次工具调用容易撞上限
      // 40 步足够正常流程（plan+generate+save+validate+1~2次迭代），又不至于无限跑
      recursionLimit: 40,
    } as Parameters<typeof createReactAgent>[0] & { recursionLimit: number });
  }

  /**
   * 处理聊天请求（SSE 流）
   *
   * @param sessionId - 会话 ID（可选，首次自动生成）
   * @param message - 用户消息
   * @param res - Express Response 对象
   */
  async handleChat(
    sessionId: string | undefined,
    message: string,
    res: SSEResponse,
  ): Promise<void> {
    // 入口日志：info 级别，记 session + 消息前 100 字符
    this.logger.log(
      `[Agent] chat session=${sessionId ?? "new"} msg=${message.slice(0, 100)}`,
    );

    // 1. 获取或创建会话
    let session = sessionId ? sessionStore.get(sessionId) : undefined;

    if (!session) {
      const graph = this.createGraph();
      const newId = sessionStore.create(graph, sessionId);
      session = sessionStore.get(newId)!;
      sessionId = newId;
    }

    // 2. 添加用户消息到历史
    session.messages.push({ role: "user", content: message });

    // 3. 将历史消息转换为 LangChain BaseMessage 数组
    const langchainMessages: BaseMessage[] = session.messages.map((m) =>
      m.role === "user"
        ? new HumanMessage(m.content)
        : new AIMessage(m.content),
    );

    // 4. 设置 SSE 响应头
    this.setSSEHeaders(res);

    // 会话创建后 sessionId 必存在
    const finalSessionId = sessionId!;

    // 发送 sessionId 给前端（d: 结构化事件）
    res.write(
      `d:${JSON.stringify({ type: "session", sessionId: finalSessionId })}\n`,
    );

    // 5. 流式执行
    const config = {
      configurable: { thread_id: finalSessionId },
      recursionLimit: 40,
    } as RunnableConfig & { recursionLimit: number };

    await this.streamAgentEvents(
      session.graph,
      { messages: langchainMessages },
      config,
      session,
      finalSessionId,
      res,
    );
  }

  /**
   * 处理 resume 请求（SSE 流，从 interrupt 处继续）
   *
   * @param sessionId - 会话 ID
   * @param answer - 用户回答
   * @param fileIds - 可选的文件 ID 列表（resume 时附带的上传文件引用）
   * @param res - Express Response 对象
   */
  async handleResume(
    sessionId: string,
    answer: string,
    fileIds: string[] | undefined,
    res: SSEResponse,
  ): Promise<void> {
    // 入口日志：info 级别，记 session + 回答前 100 字符
    this.logger.log(
      `[Agent] resume session=${sessionId} answer=${(answer ?? "").slice(0, 100)}`,
    );

    const session = sessionStore.get(sessionId);
    if (!session) {
      this.setSSEHeaders(res);
      res.write(
        `d:${JSON.stringify({ type: "error", message: "会话不存在或已过期" })}\n`,
      );
      res.end();
      return;
    }

    this.setSSEHeaders(res);

    const config = {
      configurable: { thread_id: sessionId },
      recursionLimit: 40,
    } as RunnableConfig & { recursionLimit: number };

    // 若有 fileIds，还原文件名与磁盘路径拼入 answer 文本让 LLM 感知文件并
    // 用 read_file 直接读取；纯文件上传时不以空文本开头
    const fileRefs = fileIds?.length
      ? `[用户上传了文件]\n${fileIds
          .map((id) => {
            const record = uploadPathStore.get(id);
            if (!record) {
              return `- (fileId: ${id})`;
            }
            return `- ${record.name} (fileId: ${id}, 本地路径: ${record.path})`;
          })
          .join("\n")}`
      : "";
    const resumeText = answer
      ? fileRefs
        ? `${answer}\n\n${fileRefs}`
        : answer
      : fileRefs || answer;

    // 使用 Command API 恢复执行
    const command = new Command({ resume: resumeText });

    await this.streamAgentEvents(
      session.graph,
      command,
      config,
      session,
      sessionId,
      res,
    );
  }

  // ============================================
  // 私有方法
  // ============================================

  /**
   * 设置 SSE 响应头
   *
   * Content-Type 保持 text/event-stream：Vercel AI SDK 的 useChat
   * 内部用 fetch 读流按行解析，兼容此格式。
   */
  private setSSEHeaders(res: SSEResponse): void {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
  }

  /**
   * 流式迭代 graph 事件，写入 Data Stream 协议
   *
   * 事件类型：
   * - on_chat_model_stream → 0:"text"（LLM 文本增量）
   * - on_tool_start → d:{"type":"tool_start",...}
   * - on_tool_end → d:{"type":"tool_end",...}
   * - 流结束后检查 interrupt → d:{"type":"interrupt",...} 或 d:{"type":"done",...} + e:finish
   */
  private async streamAgentEvents(
    graph: Session["graph"],
    input: any,
    config: RunnableConfig,
    session: Session,
    sessionId: string,
    res: SSEResponse,
  ): Promise<void> {
    let complete = false;

    try {
      // PregelOptions extends RunnableConfig，config 字段直接平铺进 options
      const stream = graph.streamEvents(input, {
        version: "v2",
        ...config,
      });

      for await (const event of stream) {
        // 客户端断开时停止迭代
        if (res.destroyed) {
          break;
        }

        switch (event.event) {
          case "on_chat_model_stream": {
            // LLM 文本增量
            const chunk = event.data?.chunk;
            if (chunk?.content) {
              const content =
                typeof chunk.content === "string"
                  ? chunk.content
                  : Array.isArray(chunk.content)
                    ? chunk.content
                        .map((c: unknown) =>
                          typeof c === "object" &&
                          c !== null &&
                          "text" in (c as Record<string, unknown>)
                            ? (c as Record<string, unknown>).text
                            : "",
                        )
                        .join("")
                    : "";
              if (content) {
                res.write(`0:${JSON.stringify(content)}\n`);
              }
            }
            break;
          }

          case "on_tool_start": {
            // 工具开始
            const toolName = event.name ?? "unknown";
            const toolInput = event.data?.input ?? {};
            this.logger.debug(`[Agent] tool_start ${toolName}`);
            res.write(
              `d:${JSON.stringify({ type: "tool_start", name: toolName, input: toolInput })}\n`,
            );
            break;
          }

          case "on_tool_end": {
            // 工具结束
            const toolName = event.name ?? "unknown";
            const output = event.data?.output;
            const toolContent = this.extractToolContent(output);
            this.logger.debug(
              `[Agent] tool_end ${toolName} ${toolContent.slice(0, 200)}`,
            );
            res.write(
              `d:${JSON.stringify({ type: "tool_end", name: toolName, output: toolContent })}\n`,
            );
            break;
          }
        }
      }

      complete = true;
    } catch (e) {
      // 流异常
      const msg = (e as Error).message;
      this.logger.error(`[Agent] ✗ ${msg}`);
      // 识别递归上限错误 → 提示用户 Agent 循环过深
      const isRecursion =
        msg.includes("Recursion limit") || msg.includes("recursion_limit");
      res.write(
        `d:${JSON.stringify({
          type: "error",
          message: isRecursion
            ? "Agent 执行步骤过多（可能陷入循环），已停止。请简化需求或提供更明确的信息后重试。"
            : msg,
        })}\n`,
      );
      res.end();
      return;
    }

    // 客户端断开时不继续处理
    if (res.destroyed) {
      return;
    }

    if (!complete) {
      return;
    }

    // 6. 流结束后检查是否处于 interrupt 状态
    try {
      const state = await graph.getState(config);
      const stateValues = state.values as Record<string, unknown> | undefined;

      // 检查 interrupt 值：LangGraph 将 interrupt 数据存储在 state.tasks 中
      // （实测：state.tasks[].interrupts[].value 含 interrupt 传入的值）
      const interruptData = this.extractInterruptData(state);

      if (interruptData) {
        // 处于 interrupt 状态，推送问题给前端
        this.logger.log(
          `[Agent] interrupt: ${interruptData.question.slice(0, 100)}`,
        );
        res.write(
          `d:${JSON.stringify({ type: "interrupt", ...interruptData, sessionId })}\n`,
        );
        res.end();
        return;
      }

      // 无 interrupt，提取最终消息
      this.logger.log("[Agent] done");
      const finalContent = this.extractFinalContent(stateValues);
      if (session) {
        session.messages.push({ role: "assistant", content: finalContent });
      }

      res.write(`d:${JSON.stringify({ type: "done", final: finalContent })}\n`);
      // 流结束标记（Data Stream 协议 e: 事件）
      res.write(`e:${JSON.stringify({ type: "finish" })}\n`);
    } catch (e) {
      res.write(
        `d:${JSON.stringify({ type: "error", message: `状态检测失败: ${(e as Error).message}` })}\n`,
      );
    }

    res.end();
  }

  /**
   * 从 tool_end 事件的 output 中提取工具结果纯文本
   *
   * 实测（@langchain/langgraph ^1.4.9）：event.data.output 是 ToolMessage
   * 的 JSON 字符串（LangChain 序列化格式），需解析后取 kwargs.content。
   * 兼容三种形态：对象 / JSON 字符串 / 普通字符串。
   *
   * @param output - tool_end 事件的原始 output 值
   * @returns 纯文本内容（工具返回的字符串，如 JSON 文本或错误信息）
   */
  private extractToolContent(output: unknown): string {
    // 对象形态：可能是 ToolMessage 实例（content 平铺）或序列化形态（kwargs.content）
    if (typeof output === "object" && output !== null) {
      const obj = output as Record<string, unknown>;

      // 序列化形态：{ lc, type, id, kwargs: { content } }
      const kwargs = obj.kwargs;
      if (
        typeof kwargs === "object" &&
        kwargs !== null &&
        "content" in kwargs
      ) {
        return String((kwargs as Record<string, unknown>).content ?? "");
      }

      // ToolMessage 实例形态：content 属性直接平铺在实例上
      if ("content" in obj && typeof obj.content === "string") {
        return obj.content;
      }

      return JSON.stringify(output);
    }

    // 字符串形态：可能是 ToolMessage 的 JSON 序列化文本，尝试解析
    if (typeof output === "string") {
      try {
        const parsed = JSON.parse(output) as Record<string, unknown>;
        const kwargs = parsed.kwargs;
        if (
          typeof kwargs === "object" &&
          kwargs !== null &&
          "content" in kwargs
        ) {
          return String((kwargs as Record<string, unknown>).content ?? "");
        }
      } catch {
        // 不是 JSON 字符串，原样返回
      }
      return output;
    }

    return JSON.stringify(output ?? "");
  }

  /**
   * 从 state 中提取 interrupt 数据
   *
   * 实测（@langchain/langgraph ^1.4.9）：interrupt() 的值存在
   * state.tasks[].interrupts[].value 中，而非 state.values.__interrupt__。
   */
  private extractInterruptData(state: {
    tasks?: Array<{
      interrupts?: Array<{
        value?: unknown;
      }>;
    }>;
  }): { question: string; context?: string } | null {
    // 遍历 tasks 中的 interrupts，找到 clarify_question 抛出的问题
    for (const task of state.tasks ?? []) {
      for (const item of task.interrupts ?? []) {
        const value = item.value as
          | { question?: string; context?: string }
          | undefined;
        if (value && typeof value.question === "string") {
          return {
            question: value.question,
            context: value.context,
          };
        }
      }
    }

    return null;
  }

  /**
   * 从 state 中提取最终消息内容
   */
  private extractFinalContent(
    stateValues: Record<string, unknown> | undefined,
  ): string {
    if (!stateValues) return "处理完成";

    const messages = stateValues.messages as Array<{
      type?: string;
      content?: string;
    }>;
    if (Array.isArray(messages) && messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.type === "ai" && lastMsg?.content) {
        return lastMsg.content;
      }
    }

    return "处理完成";
  }
}
