/**
 * 【第四站 - 3/3】AiController —— 暴露 HTTP 与 SSE 流式两条 AI 接口
 *
 * 学习目标：
 *   1. 普通 GET 接口：@Get('chat') 直接 await 拿到完整答案
 *   2. SSE 流式接口：@Sse('chat/stream') 让 Nest 自动按 Server-Sent Events 协议输出
 *   3. 用 RxJS 的 from() + map() 把 AsyncGenerator 适配成 Observable
 *
 * 路由速查表（前缀 /ai）：
 *   GET /ai/chat?query=xxx          一次性返回 { answer: '...' }
 *   GET /ai/chat/stream?query=xxx   SSE 流式输出，每个 chunk 即时到达
 *
 * 知识扩展（什么是 SSE？为什么用它而不是 WebSocket？）：
 *   SSE = Server-Sent Events，HTTP 之上的"服务器单向推送"协议。
 *   - 协议头：Content-Type: text/event-stream
 *   - 消息格式：data: <内容>\n\n
 *   - 浏览器端用 EventSource API 直接消费（自动重连、自动解析）
 *
 *   SSE vs WebSocket：
 *     | 维度       | SSE                    | WebSocket               |
 *     | 方向       | 服务器→客户端 单向      | 双向                    |
 *     | 协议       | HTTP                   | 独立 ws 协议             |
 *     | 复杂度     | 极低（浏览器原生支持）  | 需要心跳/鉴权/连接管理   |
 *     | 适用场景   | LLM 流式输出、行情推送  | 聊天室、协同编辑         |
 *
 *   AI 流式回答只需"服务器→浏览器"单向推送，SSE 是绝配。
 *
 * 知识扩展（@Sse 装饰器做了什么？）：
 *   Nest 在底层会：
 *     ① 设置响应头 Content-Type: text/event-stream
 *     ② 订阅你返回的 Observable，每次 next 时按 SSE 格式写一行 data: <JSON>
 *     ③ Observable complete 时自动关闭连接
 *   所以你要返回的对象形如：{ data: '<本次推送的内容>' }
 *
 * 小白注意：
 *   - @Sse 接口不能 return 普通对象，必须 return 一个 Observable
 *   - 默认浏览器对 SSE 字段名要严格按规范：使用 EventSource，事件名是 'message'
 */
import { Controller, Get, Query, Sse } from "@nestjs/common";
import { from, map, Observable } from "rxjs";
import { AiService } from "./ai.service";

@Controller("ai")
export class AiController {
  constructor(private readonly aiService: AiService) {}

  /** 普通 chat：等模型生成完毕一次性返回 */
  @Get("chat")
  async chat(@Query("query") query: string) {
    if (!query) {
      return { answer: "请通过 ?query=你的问题 传入提问内容" };
    }
    const answer = await this.aiService.runChain(query);
    return { answer };
  }

  /** 流式 chat：浏览器用 new EventSource('/ai/chat/stream?query=...') 消费 */
  @Sse("chat/stream")
  chatStream(@Query("query") query: string): Observable<{ data: string }> {
    return from(this.aiService.streamChain(query)).pipe(
      // SSE 协议要求每条消息形如 { data: '...' }
      map((chunk) => ({ data: chunk })),
    );
  }
}
