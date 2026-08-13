/**
 * ReactAgentService - ReAct Agent 核心服务
 *
 * 职责：
 * 管理 createReactAgent 实例的创建、SSE 流式对话、会话管理和 interrupt/resume 流程。
 *
 * 流程：
 * 1. 每个会话创建独立的 graph 实例（含 MemorySaver checkpointer）
 * 2. chat()：接收用户消息 → streamEvents 迭代 → 写 SSE 事件 → 检测 interrupt
 * 3. resume()：Command({ resume: answer }) → 继续 streamEvents
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
import { ALL_TOOLS } from "./tools";
import { sessionStore } from "./session.store";
import type { Session } from "./session.store";

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

const SYSTEM_PROMPT = `你是 Coze 工作流构建助手，根据用户需求，使用工具自主完成工作流的设计、生成、部署和试运行。

## 可用工具
1. clarify_question: 当用户需求信息不完整时调用（缺少数据源、格式约定、输出要求等），暂停等待用户回答
2. plan_workflow: 将用户需求分析为结构化工作流规划（WorkflowPlan）
3. generate_workflow: 将规划结果映射为 Coze 平台可部署的工作流 JSON
4. save_to_coze: 将工作流部署到 Coze 平台
5. test_run_workflow: 试运行已部署的工作流

## 使用规则
- 先分析需求是否完整，缺信息时优先调用 clarify_question
- 规划→生成→部署→试运行，按顺序执行
- 每一步完成后检查结果，再决定下一步
- 工具调用失败时，将错误信息告知用户

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
    });
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

    // 发送 sessionId 给前端
    res.write(
      `event: session\ndata: ${JSON.stringify({ sessionId: finalSessionId })}\n\n`,
    );

    // 5. 流式执行
    const config: RunnableConfig = {
      configurable: { thread_id: finalSessionId },
    };

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
   * @param res - Express Response 对象
   */
  async handleResume(
    sessionId: string,
    answer: string,
    res: SSEResponse,
  ): Promise<void> {
    const session = sessionStore.get(sessionId);
    if (!session) {
      this.setSSEHeaders(res);
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: "会话不存在或已过期" })}\n\n`,
      );
      res.end();
      return;
    }

    this.setSSEHeaders(res);

    const config: RunnableConfig = {
      configurable: { thread_id: sessionId },
    };

    // 使用 Command API 恢复执行
    const command = new Command({ resume: answer });

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
   */
  private setSSEHeaders(res: SSEResponse): void {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
  }

  /**
   * 流式迭代 graph 事件，写入 SSE
   *
   * 事件类型：
   * - on_chat_model_stream → event: message
   * - on_tool_start → event: tool_start
   * - on_tool_end → event: tool_end
   * - 流结束后检查 interrupt → event: interrupt 或 event: done
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
                res.write(
                  `event: message\ndata: ${JSON.stringify({ content })}\n\n`,
                );
              }
            }
            break;
          }

          case "on_tool_start": {
            // 工具开始
            const toolName = event.name ?? "unknown";
            const toolInput = event.data?.input ?? {};
            res.write(
              `event: tool_start\ndata: ${JSON.stringify({ name: toolName, input: toolInput })}\n\n`,
            );
            break;
          }

          case "on_tool_end": {
            // 工具结束
            const toolName = event.name ?? "unknown";
            const toolOutput = event.data?.output ?? "";
            res.write(
              `event: tool_end\ndata: ${JSON.stringify({ name: toolName, output: toolOutput })}\n\n`,
            );
            break;
          }
        }
      }

      complete = true;
    } catch (e) {
      // 流异常
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: (e as Error).message })}\n\n`,
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
        res.write(
          `event: interrupt\ndata: ${JSON.stringify({ ...interruptData, sessionId })}\n\n`,
        );
        res.end();
        return;
      }

      // 无 interrupt，提取最终消息
      const finalContent = this.extractFinalContent(stateValues);
      if (session) {
        session.messages.push({ role: "assistant", content: finalContent });
      }

      res.write(
        `event: done\ndata: ${JSON.stringify({ final: finalContent })}\n\n`,
      );
    } catch (e) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: `状态检测失败: ${(e as Error).message}` })}\n\n`,
      );
    }

    res.end();
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
