/**
 * ReactAgentController - ReAct Agent 流式接口
 *
 * 职责：
 * - POST /api/agent/chat：接收用户消息，返回 Vercel AI SDK Data Stream 流
 * - POST /api/agent/chat/resume：接收用户回答，从中断处继续执行
 * - POST /api/agent/upload：文件上传（multipart/form-data，字段名 file）
 *
 * 关键细节：
 * - POST 场景 @Sse() 只支持 GET，用 @Res() 手动写流
 * - Data Stream 协议（每行一个事件）：
 *   - 0:"text" → LLM 文本增量
 *   - d:{...}  → 结构化数据（session/tool_start/tool_end/interrupt/done/error）
 *   - e:{...}  → 流结束标记
 * - Content-Type 保持 text/event-stream（useChat 用 fetch 读流，兼容）
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  Controller,
  Post,
  Body,
  Res,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ReactAgentService } from "./react-agent.service";
import { uploadPathStore } from "./upload-store";

/**
 * multer 上传文件最小接口（避免引入 @types/express 依赖）
 *
 * 只声明 upload 接口需要的字段，与 multer 实际返回的对象兼容。
 */
interface UploadedFileInfo {
  originalname: string;
  size: number;
  mimetype: string;
  path: string;
}

/** 上传目录：apps/api/uploads/（dev 下 process.cwd() 为 apps/api，gitignore 已忽略） */
const uploadDir = path.resolve(process.cwd(), "uploads");

/**
 * 修复 multipart 文件名乱码
 *
 * 浏览器按 UTF-8 发送 filename，但 busboy（multer 底层）默认按 latin1
 * 解码 multipart 头，中文文件名会变乱码。此处把 latin1 字节序列转回 UTF-8。
 * 纯 ASCII 文件名转换前后不变，天然兼容；
 * 若转换结果包含替换字符 U+FFFD，说明原值并非被错误解码，保留原值。
 *
 * @param name - multer 解析出的原始文件名（可能乱码）
 * @returns 还原后的 UTF-8 文件名
 */
function fixFilenameEncoding(name: string): string {
  const decoded = Buffer.from(name, "latin1").toString("utf8");
  return decoded.includes("\uFFFD") ? name : decoded;
}

// FileInterceptor 的 dest 要求目录已存在，启动时创建
fs.mkdirSync(uploadDir, { recursive: true });

@Controller("api/agent")
export class ReactAgentController {
  private readonly logger = new Logger("HTTP");

  constructor(private readonly agentService: ReactAgentService) {}

  /**
   * 聊天接口（Data Stream 流式返回）
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

    // 入口日志：info 级别，记 session + 消息长度（message 未校验前可能为空，需防御）
    this.logger.log(
      `[HTTP] POST /api/agent/chat session=${sessionId ?? "new"} msgLen=${message?.length ?? 0}`,
    );

    // 基本参数校验
    if (!message || typeof message !== "string") {
      res.setHeader("Content-Type", "text/event-stream");
      res.write(
        `d:${JSON.stringify({ type: "error", message: "message 参数不能为空" })}\n`,
      );
      res.end();
      return;
    }

    await this.agentService.handleChat(sessionId, message, res);
  }

  /**
   * 恢复接口（Data Stream 流式返回，从 interrupt 处继续）
   *
   * @param body - { sessionId: string, answer: string }
   * @param res - Express Response
   */
  @Post("chat/resume")
  async resume(
    @Body() body: { sessionId: string; answer: string; fileIds?: string[] },
    @Res() res: any,
  ): Promise<void> {
    const { sessionId, answer, fileIds } = body;

    // 入口日志：info 级别，记 session
    this.logger.log(`[HTTP] POST /api/agent/chat/resume session=${sessionId}`);

    // 基本参数校验
    if (!sessionId) {
      res.setHeader("Content-Type", "text/event-stream");
      res.write(
        `d:${JSON.stringify({ type: "error", message: "sessionId 参数不能为空" })}\n`,
      );
      res.end();
      return;
    }

    // 纯文件上传（无文字）时 fileIds 必须有值；两者都缺则报错
    if (
      (!answer || typeof answer !== "string") &&
      (!Array.isArray(fileIds) || fileIds.length === 0)
    ) {
      res.setHeader("Content-Type", "text/event-stream");
      res.write(
        `d:${JSON.stringify({ type: "error", message: "answer 参数不能为空" })}\n`,
      );
      res.end();
      return;
    }

    await this.agentService.handleResume(sessionId, answer, fileIds, res);
  }

  /**
   * 文件上传接口（multipart/form-data，字段名 file）
   *
   * 文件保存到 apps/api/uploads/ 目录（gitignore 已忽略），
   * 返回 fileId 供前端在消息中携带引用。
   * 文件内容的实际解析由后续 Sprint（答案表解析）实现，
   * 本接口只负责「能上传、能存储、能返回 fileId」。
   *
   * @param file - multer 解析后的上传文件
   * @returns { fileId, name, size, mimeType, path }
   */
  @Post("upload")
  @UseInterceptors(FileInterceptor("file", { dest: uploadDir }))
  upload(@UploadedFile() file: UploadedFileInfo) {
    if (!file) {
      throw new BadRequestException("file 字段不能为空");
    }

    // 入口日志：info 级别，记文件名 + 大小
    this.logger.log(
      `[HTTP] POST /api/agent/upload name=${file.originalname} size=${file.size}`,
    );

    const fileId = crypto.randomUUID();
    // 还原中文文件名并仅取 basename（防止路径穿越）；read_file 依赖扩展名分派解析
    const safeName = path.basename(fixFilenameEncoding(file.originalname));
    // 以 fileId 为前缀重命名，避免重名覆盖，保留原始扩展名
    let finalPath = path.join(uploadDir, `${fileId}_${safeName}`);
    try {
      fs.renameSync(file.path, finalPath);
    } catch {
      // 重命名失败时退回 multer 生成的随机路径（不影响上传流程）
      finalPath = file.path;
    }

    // 登记 fileId → { 磁盘路径, 文件名 }，resume 时供 LLM 感知文件并定位
    uploadPathStore.set(fileId, { path: finalPath, name: safeName });

    return {
      fileId,
      name: safeName,
      size: file.size,
      mimeType: file.mimetype,
      path: finalPath,
    };
  }
}
