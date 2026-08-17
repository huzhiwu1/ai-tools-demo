/**
 * [Tool] clarify_question - 澄清提问
 *
 * 职责：
 * 当用户需求信息不完整时调用，返回 __clarify 标记（不阻塞）。
 * 服务层检测到标记后挂起当前 turn，向用户推送问题（SSE interrupt 事件），
 * 用户回答后通过 resume 接口把回答写回工具结果，turn 继续执行。
 *
 * 流程：
 * 1. Agent 调用此工具，传入 question 和可选 context
 * 2. 工具返回 { __clarify: true, question, context }（立即返回，不等待）
 * 3. 服务层检测 __clarify → 挂起 turn（pendingClarify）→ 推送 interrupt 事件
 * 4. 用户回答 → POST /api/agent/chat/resume → 服务层把回答写回 ToolMessage
 * 5. turn 继续：clarify_question 的工具结果即「用户回答: xxx」
 *
 * @example
 * const result = await clarifyQuestionTool.invoke({
 *   question: "请提供歌曲库的数据表名称",
 *   context: "需要知道歌曲库在哪里以编写数据库查询逻辑",
 * });
 * // => { __clarify: true, question: "...", context: "..." }
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";

export const clarifyQuestionTool = tool(
  async ({ question, context }) => {
    // 不阻塞：返回标记，由服务层主循环驱动挂起/恢复
    // （自建主循环协议，替代 LangGraph interrupt——后者在打断场景下
    // 经由 combineAbortSignals 同步转发链导致 unhandled rejection 崩溃）
    return { __clarify: true, question, context };
  },
  {
    name: "clarify_question",
    description:
      "当用户需求信息不完整时调用（例如缺少数据源、格式约定、输出要求、验收标准等）。" +
      "调用后工作流暂停，等待用户回答，收到回答后自动继续。",
    schema: z.object({
      question: z
        .string()
        .describe("向用户提出的具体问题（一次只问一个最关键的）"),
      context: z.string().optional().describe("补充说明为什么需要这个信息"),
    }),
  },
);
