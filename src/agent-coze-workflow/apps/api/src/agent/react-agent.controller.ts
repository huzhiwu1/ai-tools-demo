/**
 * ReactAgentController - ReAct Agent SSE 接口
 *
 * 职责：
 * - POST /api/agent/chat：接收用户消息，返回 SSE 流
 * - POST /api/agent/chat/resume：接收用户回答，从中断处继续执行
 *
 * 关键细节：
 * - POST 场景 @Sse() 只支持 GET，用 @Res() 手动写 SSE
 * - SSE 事件格式：
 *   - event: session     → data: { sessionId }
 *   - event: message     → data: { content }
 *   - event: tool_start  → data: { name, input }
 *   - event: tool_end    → data: { name, output }
 *   - event: interrupt   → data: { question, context?, sessionId }
 *   - event: done        → data: { final }
 *   - event: error       → data: { message }
 */

import { Controller, Post, Body, Res } from "@nestjs/common";
import { ReactAgentService } from "./react-agent.service";

@Controller("api/agent")
export class ReactAgentController {
  constructor(private readonly agentService: ReactAgentService) {}

  /**
   * 聊天接口（SSE 流式返回）
   *
   * @param body - { sessionId?: string, message: string }
   * @param res - Express Response
   */
  @Post("chat")
  async chat(
    @Body() body: { sessionId?: string; message: string },
    @Res() res: any,
  ): Promise<void> {
    const { sessionId, message } = body;

    // 基本参数校验
    if (!message || typeof message !== "string") {
      res.setHeader("Content-Type", "text/event-stream");
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: "message 参数不能为空" })}\n\n`,
      );
      res.end();
      return;
    }

    await this.agentService.handleChat(sessionId, message, res);
  }

  /**
   * 恢复接口（SSE 流式返回，从 interrupt 处继续）
   *
   * @param body - { sessionId: string, answer: string }
   * @param res - Express Response
   */
  @Post("chat/resume")
  async resume(
    @Body() body: { sessionId: string; answer: string },
    @Res() res: any,
  ): Promise<void> {
    const { sessionId, answer } = body;

    // 基本参数校验
    if (!sessionId) {
      res.setHeader("Content-Type", "text/event-stream");
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: "sessionId 参数不能为空" })}\n\n`,
      );
      res.end();
      return;
    }

    if (!answer || typeof answer !== "string") {
      res.setHeader("Content-Type", "text/event-stream");
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: "answer 参数不能为空" })}\n\n`,
      );
      res.end();
      return;
    }

    await this.agentService.handleResume(sessionId, answer, res);
  }
}
