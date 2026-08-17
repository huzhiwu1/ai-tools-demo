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
  on(event: "close", listener: () => void): unknown;
  removeListener(event: "close", listener: () => void): unknown;
}

// ============================================
// 系统提示词
// ============================================

const SYSTEM_PROMPT = `你是 Coze 工作流构建助手，根据用户需求，使用工具自主完成工作流的设计、生成、部署、试运行和验证迭代。

## 可用工具
1. clarify_question: 当用户需求信息不完整时调用（缺少数据源、格式约定、输出要求等），暂停等待用户回答
2. read_file: 通用文件读取，返回文件原始内容。文件的具体用途、列含义、数据如何参与工作流，由你（LLM）根据用户需求判断
3. plan_workflow: 将用户需求分析为结构化工作流规划（WorkflowPlan）
4. generate_workflow: 将规划结果映射为 Coze 平台可部署的工作流 JSON（plan 参数可选，优先传 planId 句柄，不背完整 plan）
5. save_to_coze: 将工作流部署到 Coze 平台（workflow JSON 参数可选，优先用 workflowId 句柄）
6. test_run_workflow: 试运行已部署的工作流
7. batch_validate: 批量试运行已部署的工作流，对照期望值验证准确性，返回准确率 + 错误明细 + 归因分组
8. update_workflow: 根据归因分析结果修改工作流节点（阈值/代码/逻辑/prompt/提示词/数据/常量），返回 changes 摘要（不再返回完整 workflow）
9. rename_workflow: 修改已创建工作流的名称/描述（不走 save，不影响工作流内容）
10. list_workflows: 搜索平台已有工作流（按名称关键词），返回摘要列表（workflowId/name/desc）
11. read_workflow: 读取平台已有工作流，输出人类可读说明书（拓扑图/节点清单/数据流/配置详情）

## 使用规则
- 先分析需求是否完整，缺信息时优先调用 clarify_question
- 规划→生成→部署→试运行，按顺序执行
- 每一步完成后检查结果，再决定下一步
- 工具调用失败时，将错误信息告知用户
- **读工作流规则**：
  - 用户没给 workflowId 时，先 list_workflows 按名称搜索拿 ID
  - 用户问「工作流长什么样/为什么错」、或准备修改线上已有工作流时，先 read_workflow 读说明书（读后写入服务端缓存）
  - read_workflow 默认 scope=overview（概览+节点清单+数据流，省 token）；需要完整配置与验证报告时用 scope=full
- **save_to_coze 规则（重要）**：
  - **首次保存**：不传 workflowId，创建新工作流
  - **修复迭代**（校验失败/试运行失败/批量验证失败后 update_workflow 修改过）：
    重新 save_to_coze 时**必须带上原 workflowId**，在原工作流上更新，不要新建！
  - 只有第一次创建工作流本身失败时才重新创建
  - save_to_coze 提示"工作流名称已存在"时：工具会自动加后缀重试；若仍需指定名称，用 rename_workflow 改名后重新保存
- rename_workflow 只改名称/描述，不影响工作流内容
- **句柄化（重要）**：update_workflow / save_to_coze 的 workflow JSON 参数现在可选。
  - 推荐流程：save_to_coze 后拿 workflowId → update_workflow 只传 workflowId + fixInstruction（不传大 JSON）→ 再 save_to_coze 传 workflowId 保存
  - update_workflow 只改服务端缓存不落平台，**修改后必须 save_to_coze（传 workflowId）保存，保存成功才生效**
  - update_workflow 返回「线上工作流已被修改，已重新拉取」时，说明平台侧有人工修改，需基于最新版本重新描述修改指令
- **plan 句柄化**：plan_workflow 返回 planId 后，generate_workflow 只传 planId 即可（不传完整 plan JSON）
- **不要重复规划**：plan_workflow 返回 planningComplete=true 后，直接进入 generate_workflow（传 planId）。除非规划结果与用户需求明显不符（如漏了关键步骤/选错模型），否则不要再次调用 plan_workflow
- **线上工作流找回**：如果用户提到"之前的工作流/已经保存的/改一下刚才那个"，但当前上下文没有 workflowId，先 list_workflows 按名称搜索找回，不要重新创建

## 系统级约束（由代码强制，收到错误时遵守）
- batch_validate / update_workflow 有系统级迭代上限（3 轮），达到后工具会返回"已达迭代上限"错误，此时必须停止并汇报结果，不要尝试绕过或继续修改
- save_to_coze 返回"authentication failed" / "access denied" → 这是平台凭证问题，不是工作流问题！不要修改工作流、不要反复保存，直接告知用户"COZE_SESSION_KEY 可能过期，请检查 .env 后重试"

## 文件与验证流程（当用户上传文件或要求验证时）
1. 用户上传文件 → 消息里会附「本地路径」，用 read_file 读该路径（通用读取，不做业务假设）
2. 根据用户需求 + 文件内容，判断：
   - 文件是干什么的？（数据源？期望结果？参考文档？）
   - 信息是否完整？是否还缺关键信息（如判断标准、字段含义、输出格式）？
   - 不确定 → 调用 clarify_question 向用户询问
3. 完全理解需求后，再 plan_workflow 设计工作流
4. generate_workflow 生成 → 检查 validation。⚠️ 若文件内容是需要内嵌到工作流的参考数据（如歌词库、歌曲列表、常量表），必须将文件内容作为 referenceData 参数传入 generate_workflow（格式：{歌名/键: 内容}），禁止编造或省略——否则代码节点会凭空生成错误数据
5. save_to_coze 保存 → 拿 workflowId
6. batch_validate 批量试运行（cases 由 LLM 根据文件内容构造）→ 看 accuracy
7. 若 accuracy < 100%：分析 failurePatterns → 给出 fixInstruction → update_workflow → 重新 save → batch_validate
8. 若收到"已达迭代上限"错误：停止迭代，向用户汇报当前结果（准确率 + 失败分析）
9. 验证通过：总结交付（含最终 workflowId 和 accuracy）

## 输出格式
- 思考过程：用自然语言解释当前步骤
- 工具调用：按需调用对应工具
- 最终答案：完成后总结整个流程（含 workflowId 等关键信息）`;

// ============================================
// LLM 实例（模块级单例，所有会话共享）
// ============================================

/** 共享 LLM 实例：ChatOpenAI 内部有连接池，无需每个会话 new */
// 优先用 dachensky 网关（LLM_*，支持思考+工具调用），fallback 官方 DeepSeek（DEEPSEEK_*）
const llm = new ChatOpenAI({
  model: process.env.LLM_MODEL ?? process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
  apiKey: process.env.LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY,
  configuration: {
    baseURL:
      process.env.LLM_BASE_URL ??
      process.env.DEEPSEEK_BASE_URL ??
      "https://api.deepseek.com/v1",
  },
  temperature: 0.2,
  // 思考模型（deepseek-v4-flash）的 reasoning 与正文共用 completion tokens，
  // 官网默认 4K 上限会把含工具调用参数的输出截断，导致工具参数解析失败后
  // 错误反馈给 LLM 反复重试（观感死循环）。实测官网接受 8192，显式放大。
  // 注意：若模型切回 deepseek-chat 等非思考模型，此值同样安全。
  // 2026-08-16 修复：主 LLM 漏了关思考配置（DeepSeekClient 已关，主 Agent 循环没关）——
  // plan_workflow 输出大 JSON 后，主 LLM 下一步要重新背诵 plan 作为工具参数，
  // reasoning 吃掉 8192 大半预算 → 正文截断 → 无 tool_calls → Agent 静默 done。
  // 2026-08-16 尝试恢复思考（去掉 disabled），实测：打断并发送后前端仍不显示 reasoning，
  // 且思考吃预算导致长工具参数截断风险。结论：关闭思考保稳定（前端已用“处理中”文案兜底）。
  maxTokens: 16384,
  modelKwargs: { thinking: { type: "disabled" } },
  // 显式限制超时与重试：默认 maxRetries=6 会把单次失败放大为
  // 6 次静默重试（每次等满超时），前端表现为长时间无事件、一直转圈
  timeout: 60_000,
  maxRetries: 1,
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
      // 提高递归上限：默认 25 步，ReAct 循环含多次工具调用容易撞上限。
      // 100 步容纳内部用户场景（update 失败→重建→save 超时重试→validate 多用例叠加步数），40 太紧
      recursionLimit: 100,
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

    // 2. Phase 状态机：如果 session 正在 running（上一轮还没跑完），
    // 先 abort 旧 driver 并等它收敛退出，保证同一时刻只有一个 driver。
    // （借鉴 DeepSeek Harness 的 kick/wake 模式：steer = 打断当前步，立刻处理新消息）
    const wasInterrupted = session.phase === "running";
    if (wasInterrupted) {
      this.logger.log(`[Agent] 打断旧 driver (session=${sessionId})`);
      // 发出 abort 信号：AbortSignal 全程传递到 LLM 调用/工具调用边界
      session.abortController?.abort("user-interrupt");
      // 等待旧 driver 完全退出（最多等 5 秒，防止卡死在无法 abort 的系统调用中）
      try {
        await Promise.race([
          session.runningPromise ?? Promise.resolve(),
          new Promise((r) => setTimeout(r, 5000)),
        ]);
      } catch {
        // 旧 driver 可能已经抛异常，忽略
      }
      // 重建 graph：旧 execution 被 abort，checkpoint 残留半截状态，必须重建清空；
      // 对话记忆由 session.messages 保留，AI 仍记得之前的对话
      session.graph = this.createGraph();
      this.logger.log(
        `[Agent] 旧 driver 已退出，graph 已重建 (session=${sessionId})`,
      );
    }

    // 3. 设置新 driver 的 phase 和 AbortController
    session.phase = "running";
    session.abortController = new AbortController();

    // 4. 添加用户消息到历史
    session.messages.push({ role: "user", content: message });

    // 5. 将历史消息转换为 LangChain BaseMessage 数组
    const langchainMessages: BaseMessage[] = [];

    // 打断恢复记忆：把此前会话的工具结果摘要作为上下文注入（纯文本 SystemMessage，
    // 不做 ToolMessage，避免 LangGraph 消息配对校验失败）。
    // 所有 chat 请求都注入（正常链路 tool 消息不存在，代价可忽略）。
    const toolSummaries = session.messages.filter((m) => m.role === "tool");
    if (toolSummaries.length > 0) {
      const contextText =
        "【系统记录：以下是此前会话已完成的工具操作结果（用于恢复上下文，不是用户新消息）】\n" +
        toolSummaries.map((m) => `- ${m.content}`).join("\n");
      langchainMessages.push(new SystemMessage(contextText));
    }

    // 原有 user/assistant 消息
    for (const m of session.messages) {
      if (m.role === "user")
        langchainMessages.push(new HumanMessage(m.content));
      if (m.role === "assistant")
        langchainMessages.push(new AIMessage(m.content));
    }

    // 6. 设置 SSE 响应头
    this.setSSEHeaders(res);

    // 会话创建后 sessionId 必存在
    const finalSessionId = sessionId!;

    // 发送 sessionId 给前端（d: 结构化事件）
    res.write(
      `d:${JSON.stringify({ type: "session", sessionId: finalSessionId })}\n`,
    );

    // 7. 打断场景：告知前端上一轮任务已被打断，正在处理新消息
    if (wasInterrupted) {
      res.write(
        `d:${JSON.stringify({ type: "aborted", message: "已打断上一轮任务，正在处理新消息..." })}\n`,
      );
    }

    // 8. 发送 turn 事件（前端可展示「第 N 轮对话」）
    const turnCount = session.messages.filter((m) => m.role === "user").length;
    res.write(`d:${JSON.stringify({ type: "turn_start", turn: turnCount })}\n`);

    // 9. 创建 runningPromise：下一个 handleChat 打断时用它等旧 driver 退出
    let resolvePromise: () => void;
    session.runningPromise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });

    // 关键：把 AbortSignal 传给 LangGraph，config.signal 会传递到
    // 底层 LLM 调用/工具调用边界，打断时立即中止而非等当前步跑完
    const config: RunnableConfig = {
      configurable: { thread_id: finalSessionId },
      recursionLimit: 100,
      signal: session.abortController.signal,
    };

    // 10. 流式执行：无论正常结束还是异常退出，都收敛到 idle
    try {
      await this.streamAgentEvents(
        session.graph,
        { messages: langchainMessages },
        config,
        session,
        finalSessionId,
        res,
      );
    } finally {
      // 收敛：phase 回 idle、释放 AbortController、resolve runningPromise
      // （等待中的下一个 handleChat 由此被唤醒）
      session.phase = "idle";
      session.abortController = null;
      resolvePromise!();
    }
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

    // Phase 状态机：如果 session 正在 running（用户在上一轮还没跑完时
    // 又发了新消息/新回答），先 abort 旧 driver 并等它收敛，再重建 graph
    if (session.phase === "running") {
      this.logger.log(`[Agent] resume 打断旧 driver (session=${sessionId})`);
      session.abortController?.abort("user-interrupt");
      try {
        await Promise.race([
          session.runningPromise ?? Promise.resolve(),
          new Promise((r) => setTimeout(r, 5000)),
        ]);
      } catch {
        // 旧 driver 可能已经抛异常，忽略
      }
      session.graph = this.createGraph();
    }

    // 设置新 phase 与 AbortController
    session.phase = "running";
    session.abortController = new AbortController();

    this.setSSEHeaders(res);

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

    // 创建 runningPromise：下一个打断者用 await 等旧 driver 退出
    let resolvePromise: () => void;
    session.runningPromise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });

    const config: RunnableConfig = {
      configurable: { thread_id: sessionId },
      recursionLimit: 100,
      signal: session.abortController.signal,
    };

    try {
      await this.streamAgentEvents(
        session.graph,
        command,
        config,
        session,
        sessionId,
        res,
      );
    } finally {
      // 收敛：phase 回 idle、释放 AbortController、resolve runningPromise
      session.phase = "idle";
      session.abortController = null;
      resolvePromise!();
    }
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
    // 主路径打断信号：handleChat/handleResume 打断时 abort 此 signal，
    // AbortSignal 会全程传递到 LLM 调用/工具调用边界
    const signal = config.signal;
    let complete = false;
    // 服务端主动结束标记：true 表示流由服务端正常完成（非客户端打断）
    let finished = false;

    // close 事件兑底：用户直接关浏览器标签页时没有新的 handleChat 调用来发
    // abort，close 事件由事件循环立即触发（for await 循环里等下一事件时
    // res.destroyed 检测会延迟），这里只负责补发 abort 信号。
    // 不再依赖它打 graphDirty 标记——脏状态检测已被 phase 状态机替代。
    const onClose = () => {
      if (!finished) {
        session.abortController?.abort("client-disconnect");
      }
    };
    res.on("close", onClose);

    try {
      // 外层 try：确保 finally 在一切退出路径（含提前 return）前执行，
      // 移除 close 监听器避免泄漏
      try {
        // PregelOptions extends RunnableConfig，config 字段直接平铺进 options
        const stream = graph.streamEvents(input, {
          version: "v2",
          ...config,
        });

        for await (const event of stream) {
          // 检查点 1：AbortSignal（主路径，比 res.destroyed 更及时）——
          // 「打断并发送」时 handleChat 先 abort 再等旧 driver 退出，
          // 这里立即停止迭代
          if (signal?.aborted) {
            // 主动取消底层 graph 执行：streamEvents 返回的流支持 cancel()，
            // 终止后台执行。否则被放弃的执行会继续在后台跑完，
            // 到达 recursionLimit 时抛出的异常无处理器 → 未捕获异常崩溃整个服务
            try {
              await (
                stream as unknown as {
                  cancel?: (reason: string) => Promise<void>;
                }
              ).cancel?.(String(signal.reason ?? "aborted"));
            } catch {
              // cancel 失败可忽略：signal 已发，底层 LLM 调用也会响应 abort
            }
            break;
          }

          // 检查点 2：res.destroyed（兑底，客户端已经断开但没发 abort）
          if (res.destroyed) {
            session.abortController?.abort("client-disconnect");
            try {
              await (
                stream as unknown as {
                  cancel?: (reason: string) => Promise<void>;
                }
              ).cancel?.("client-disconnect");
            } catch {
              // cancel 失败可忽略
            }
            break;
          }

          switch (event.event) {
            case "on_chat_model_stream": {
              // LLM 文本增量
              const chunk = event.data?.chunk as
                | ({
                    content?: unknown;
                    additional_kwargs?: Record<string, unknown>;
                  } & Record<string, unknown>)
                | undefined;

              // DeepSeek 思考内容（reasoning_content，流式增量）
              // 单独输出 reasoning_delta 事件，前端在思考气泡里流式展示
              const reasoning = chunk?.additional_kwargs?.reasoning_content;
              if (typeof reasoning === "string" && reasoning.length > 0) {
                res.write(
                  `d:${JSON.stringify({ type: "reasoning_delta", content: reasoning })}\n`,
                );
              }

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
              // info 级别：默认可见，用于定位 Agent 循环/卡住的步骤（debug 不输出）
              this.logger.log(
                `[Agent] tool_start ${toolName} ${JSON.stringify(toolInput).slice(0, 200)}`,
              );
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
              // info 级别：默认可见，用于定位 Agent 循环/卡住的步骤（debug 不输出）
              this.logger.log(
                `[Agent] tool_end ${toolName} ${toolContent.slice(0, 200)}`,
              );
              res.write(
                `d:${JSON.stringify({ type: "tool_end", name: toolName, output: toolContent })}\n`,
              );
              // 打断恢复记忆：关键工具结果以摘要形式记入 session.messages（role:"tool"）
              const summary = this.summarizeToolResult(toolName, toolContent);
              if (summary) {
                session.messages.push({
                  role: "tool",
                  toolName,
                  content: summary,
                });
              }
              break;
            }
          }
        }

        complete = true;
      } catch (e) {
        // 被 abort 打断视为正常打断：发送 aborted 事件，不报错
        if (signal?.aborted || (e as Error).name === "AbortError") {
          if (!res.destroyed) {
            res.write(`d:${JSON.stringify({ type: "aborted" })}\n`);
            res.end();
          }
          return;
        }
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

      // 被 abort 打断的流：发送 aborted 事件并退出
      // （新消息由新的 handleChat 响应处理，这里只负责收尾旧流）
      if (signal?.aborted) {
        if (!res.destroyed) {
          res.write(`d:${JSON.stringify({ type: "aborted" })}\n`);
          res.end();
        }
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

        res.write(
          `d:${JSON.stringify({ type: "done", final: finalContent })}\n`,
        );
        // 流结束标记（Data Stream 协议 e: 事件）
        res.write(`e:${JSON.stringify({ type: "finish" })}\n`);
      } catch (e) {
        res.write(
          `d:${JSON.stringify({ type: "error", message: `状态检测失败: ${(e as Error).message}` })}\n`,
        );
      }

      res.end();
    } finally {
      // 无论正常结束还是中断退出：标记服务端流程已结束并移除 close 监听
      // 注意：res.end() 到 close 事件触发之间存在异步延迟，finished 须在
      // 函数退出（finally）前置 true，确保正常结束不会误标脏
      finished = true;
      res.removeListener("close", onClose);
    }
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
   * 为打断恢复记忆生成工具结果摘要
   *
   * 按工具名定制摘要策略，控制体积（≤1500 字符），只保留 LLM 恢复上下文
   * 必需的关键信息（如 save 的 workflowId、read_file 的内容前几行）。
   * 返回 null 表示该工具结果不需要记忆（如 get_platform_facts 每次可重查）。
   *
   * @param toolName - 工具名（如 read_file / save_to_coze）
   * @param toolContent - 工具返回的完整文本（由 extractToolContent 提取）
   * @returns 摘要字符串；无需记忆时返回 null
   */
  private summarizeToolResult(
    toolName: string,
    toolContent: string,
  ): string | null {
    const MAX_LEN = 1500;
    const trunc = (s: string, max: number) =>
      s.length > max ? s.slice(0, max) + "…（已截断）" : s;

    // 尝试 JSON 解析，提取关键字段
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(toolContent) as Record<string, unknown>;
    } catch {
      // 不是 JSON，走纯文本截断
    }

    switch (toolName) {
      case "read_file": {
        // 保留文件内容前 1500 字符
        return trunc(`[read_file] ${toolContent.slice(0, MAX_LEN)}`, MAX_LEN);
      }

      case "get_platform_facts":
        // 平台事实每次可重查，且本身已瘦身，无需记忆
        return null;

      case "plan_workflow": {
        if (parsed?.steps && Array.isArray(parsed.steps)) {
          const steps = parsed.steps as Array<{
            nodeType?: string;
            description?: string;
          }>;
          const stepSummary = steps
            .map((s) => `${s.nodeType ?? "?"}(${s.description ?? ""})`)
            .join("→");
          return `[plan_workflow] ${(parsed.name as string) ?? "?"}，${steps.length} 步: ${stepSummary}`;
        }
        return trunc(`[plan_workflow] ${toolContent.slice(0, 800)}`, MAX_LEN);
      }

      case "generate_workflow": {
        if (parsed?.workflow) {
          const wf = parsed.workflow as Record<string, unknown>;
          const meta = wf.meta as Record<string, unknown> | undefined;
          const name = meta?.name ?? "?";
          const valid = (parsed.validation as Record<string, boolean>)?.valid
            ? "通过"
            : "失败";
          return `[generate_workflow] ${name} 生成完成，结构校验${valid}`;
        }
        return trunc(
          `[generate_workflow] ${toolContent.slice(0, 500)}`,
          MAX_LEN,
        );
      }

      case "save_to_coze": {
        // 最关键：必须完整保留 workflowId + name + saved 状态
        if (parsed) {
          const id = parsed.workflowId ?? parsed.id ?? "?";
          const name = parsed.name ?? "?";
          const saved = parsed.saved ?? true;
          return `[save_to_coze] workflowId=${id} name=${name} saved=${saved}`;
        }
        return trunc(`[save_to_coze] ${toolContent}`, MAX_LEN);
      }

      case "update_workflow": {
        if (parsed?.changes) {
          const changes =
            typeof parsed.changes === "string"
              ? parsed.changes
              : JSON.stringify(parsed.changes);
          return trunc(`[update_workflow] ${changes}`, MAX_LEN);
        }
        return trunc(`[update_workflow] ${toolContent.slice(0, 500)}`, MAX_LEN);
      }

      case "batch_validate": {
        if (parsed) {
          const accuracy = parsed.accuracy ?? "?";
          const failed = parsed.failedCount ?? parsed.failed ?? "?";
          const total = parsed.totalCount ?? parsed.total ?? "?";
          return `[batch_validate] 通过 ${total}，accuracy=${accuracy}，${failed} 个失败`;
        }
        return trunc(`[batch_validate] ${toolContent.slice(0, 500)}`, MAX_LEN);
      }

      case "test_run_workflow": {
        if (parsed?.executeId) {
          return `[test_run_workflow] executeId=${parsed.executeId}`;
        }
        return trunc(
          `[test_run_workflow] ${toolContent.slice(0, 300)}`,
          MAX_LEN,
        );
      }

      case "read_workflow": {
        // 说明书内容很长，只取概览信息
        const nodeMatch = toolContent.match(/节点数[：:]\s*(\d+)/);
        const nameMatch = toolContent.match(/^#\s*工作流说明书[：:]\s*(.+)/m);
        const name = nameMatch?.[1]?.trim() ?? "?";
        const nodeCount = nodeMatch?.[1] ?? "?";
        return `[read_workflow] 已读取 ${name}（${nodeCount} 节点）`;
      }

      case "list_workflows": {
        if (parsed?.workflows && Array.isArray(parsed.workflows)) {
          const wfs = parsed.workflows as Array<{
            workflowId?: string;
            name?: string;
          }>;
          const names = wfs
            .slice(0, 5)
            .map((w) => w.name ?? w.workflowId)
            .join(", ");
          return `[list_workflows] 找到 ${wfs.length} 个工作流: ${names}`;
        }
        return trunc(`[list_workflows] ${toolContent.slice(0, 500)}`, MAX_LEN);
      }

      case "clarify_question":
        // interrupt 场景不走 on_tool_end 正常流，无需记录
        return null;

      case "rename_workflow": {
        if (parsed?.name) {
          return `[rename_workflow] 已改名 ${parsed.name}`;
        }
        return trunc(`[rename_workflow] ${toolContent.slice(0, 300)}`, MAX_LEN);
      }

      default:
        // 未知工具：截断 500 字符
        return trunc(`[${toolName}] ${toolContent.slice(0, 500)}`, MAX_LEN);
    }
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
