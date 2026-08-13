/**
 * [Tool] clarify_question - 澄清提问
 *
 * 职责：
 * 当用户需求信息不完整时调用，通过 interrupt() 暂停图执行，
 * 等待用户回答，收到回答后自动继续。
 *
 * 流程：
 * 1. Agent 调用此工具，传入 question 和可选 context
 * 2. interrupt() 暂停 graph，将问题抛给外部（SSE event: interrupt）
 * 3. 用户提交回答后，resume 接口传入 answer
 * 4. Command({ resume: answer }) 恢复执行，工具返回 "用户回答: ..."
 *
 * @example
 * const result = await clarifyQuestionTool.invoke({
 *   question: "请提供歌曲库的数据表名称",
 *   context: "需要知道歌曲库在哪里以编写数据库查询逻辑",
 * });
 */

import { interrupt } from "@langchain/langgraph";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

export const clarifyQuestionTool = tool(
  async ({ question, context }) => {
    // interrupt 暂停图执行，把问题抛给外部；resume 传入用户回答后继续
    const answer = await interrupt({ question, context });
    return `用户回答: ${answer}`;
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
