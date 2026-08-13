// @coze-workflow/web - Data Stream Protocol 解析工具
//
// 职责：
// 1. parseDataStream：手写 fetch + ReadableStream 解析后端 Data Stream 响应
//    （resume 接口使用，方案 A）
// 2. transformToDataProtocolStream：把后端 Data Stream 流转换为 AI SDK 标准
//    Data Stream 协议（useChat 自定义 fetch 适配层）
//
// 后端协议（react-agent.service.ts 输出，每行一个事件）：
// - 0:"text"  → LLM 文本增量
// - d:{...}   → 结构化数据（session/tool_start/tool_end/interrupt/done/error）
// - e:{...}   → 流结束标记
//
// AI SDK 标准协议（useChat 内置解析，d: 事件进 data 数组）：
// - 0:"text"       → 文本增量
// - 2:[{...},...]  → 数据事件（必须是数组）
// - 3:"message"    → 错误
// - d:{...}/e:{...} → finish 事件（可省略，流自然结束即可）

// ============================================
// 类型
// ============================================

/** 后端 d: 事件负载（结构松散，前端按 type 分发） */
export interface DataStreamEvent {
  type: "session" | "tool_start" | "tool_end" | "interrupt" | "done" | "error";
  sessionId?: string;
  name?: string;
  input?: unknown;
  output?: string;
  question?: string;
  context?: string;
  final?: string;
  message?: string;
}

/** parseDataStream 的事件处理器 */
export interface DataStreamHandlers {
  /** LLM 文本增量（每收到一行 0: 调用一次） */
  onText?: (delta: string) => void;
  /** 结构化事件（每收到一行 d: 调用一次） */
  onEvent?: (event: DataStreamEvent) => void;
}

// ============================================
// 解析函数
// ============================================

/**
 * 解析 Data Stream 响应流，逐行分发事件
 *
 * 行格式：`0:"文本"` / `d:{json}` / `e:{json}`（每行一个事件，\n 分隔）。
 * 用 TextDecoder 增量解码，按行切分，兼容 chunk 跨行边界的情况。
 *
 * @param response - fetch 返回的 Response（body 为 Data Stream 流）
 * @param handlers - onText / onEvent 回调
 * @returns 完整文本（所有 0: 增量的拼接结果）
 */
export async function parseDataStream(
  response: Response,
  handlers: DataStreamHandlers = {},
): Promise<string> {
  if (!response.body) {
    throw new Error("响应没有 body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  // 处理一行协议数据
  const processLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;

    if (trimmed.startsWith("0:")) {
      // 文本增量
      const text: unknown = JSON.parse(trimmed.slice(2));
      if (typeof text === "string") {
        fullText += text;
        handlers.onText?.(text);
      }
      return;
    }

    if (trimmed.startsWith("d:")) {
      // 结构化事件
      const event: unknown = JSON.parse(trimmed.slice(2));
      if (typeof event === "object" && event !== null) {
        handlers.onEvent?.(event as DataStreamEvent);
      }
      return;
    }

    // e: 结束标记等其他行忽略
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // 逐行处理（协议保证每个事件以 \n 结尾）
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      processLine(line);
      newlineIndex = buffer.indexOf("\n");
    }
  }

  // 处理最后一行（可能没有结尾换行符）
  if (buffer) {
    processLine(buffer);
  }

  return fullText;
}

// ============================================
// useChat fetch 适配层
// ============================================

/**
 * 把后端 Data Stream 流转换为 AI SDK 标准 Data Stream 协议
 * （供 useChat 的自定义 fetch 使用）
 *
 * 转换规则：
 * - 0:"text" → 0:"text"（直通，useChat 自动流式拼接）
 * - d:{...}  → 2:[{...}]（数据事件，useChat 的 data 数组接收）
 * - d:{"type":"error"} → 3:"message"（触发 useChat 的 error 状态）
 * - e:{...}  → 丢弃（流自然结束，useChat 自动收尾）
 *
 * @param source - 后端返回的 Data Stream 流
 * @returns AI SDK 标准协议流
 */
export function transformToDataProtocolStream(
  source: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  /**
   * 单行转换：返回转换后的行（含 \n），无输出返回 null
   */
  const convertLine = (line: string): string | null => {
    const trimmed = line.trim();
    if (!trimmed) return null;

    if (trimmed.startsWith("0:")) {
      // 文本增量直通
      return `${trimmed}\n`;
    }

    if (trimmed.startsWith("d:")) {
      try {
        const event: unknown = JSON.parse(trimmed.slice(2));
        if (typeof event === "object" && event !== null) {
          const { type, message } = event as DataStreamEvent;
          if (type === "error") {
            // 错误事件 → AI SDK 的 3: 错误行
            return `3:${JSON.stringify(message ?? "未知错误")}\n`;
          }
          // 其余事件 → AI SDK 的 2: 数据数组行
          return `2:${JSON.stringify([event])}\n`;
        }
      } catch {
        // JSON 解析失败，丢弃该行
        return null;
      }
    }

    // e: 结束标记丢弃
    return null;
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let newlineIndex = buffer.indexOf("\n");
          while (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            const out = convertLine(line);
            if (out !== null) {
              controller.enqueue(encoder.encode(out));
            }
            newlineIndex = buffer.indexOf("\n");
          }
        }

        // 处理残留 buffer（最后一行可能没有换行符）
        const out = convertLine(buffer);
        if (out !== null) {
          controller.enqueue(encoder.encode(out));
        }
      } catch (e) {
        controller.error(e);
        return;
      }
      controller.close();
    },
  });
}
