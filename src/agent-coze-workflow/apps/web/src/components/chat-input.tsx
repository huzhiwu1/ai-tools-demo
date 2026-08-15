/**
 * ChatInput 组件 —— 底部输入区
 *
 * 职责：需求输入（textarea 自适应高度）+ 文件上传（按钮/拖拽）+ 发送
 *
 * 关键细节：
 * - 文件上传走 workflowApi.uploadFile，成功后展示文件 chip（可移除）
 * - 发送时把文件引用以文本形式附加到消息末尾，发送后清空文件列表
 * - 拖拽上传：dragover 高亮 + drop 处理
 */

import { useRef, useState } from "react";
import type { DragEvent, FormEvent } from "react";
import { workflowApi } from "../api/workflow.js";
import type { UploadedFileInfo } from "../api/workflow.js";

interface Props {
  /** 输入框内容（由 App 通过 useChat 的 input 状态控制） */
  input: string;
  onInputChange: (value: string) => void;
  /** 发送回调（App 负责拼接文件引用后提交） */
  onSend: (text: string) => void;
  /** 回答回调（reply 模式，App 调用 resume 接口） */
  onAnswer?: (answer: string, fileIds: string[]) => void;
  /** 输入模式：normal 普通需求输入 / reply 回复 AI 问题 */
  mode?: "normal" | "reply";
  /** 当前 AI 问题摘要（reply 模式显示在输入框上方） */
  pendingQuestionText?: string;
  loading: boolean;
}

/** 上传图标（SVG 矢量，替代 emoji 保证各平台渲染一致） */
function UploadIcon() {
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

export function ChatInput({
  input,
  onInputChange,
  onSend,
  onAnswer,
  mode = "normal",
  pendingQuestionText,
  loading,
}: Props) {
  const isReply = mode === "reply";
  const [files, setFiles] = useState<UploadedFileInfo[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** 上传单个文件，成功后追加到文件列表 */
  async function handleUpload(file: File) {
    if (uploading) return;
    setUploading(true);
    try {
      const info = await workflowApi.uploadFile(file);
      setFiles((prev) => [...prev, info]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 上传失败通过 alert 提示（保持组件无外部依赖）
      alert(msg);
    } finally {
      setUploading(false);
    }
  }

  /** 移除已上传文件 */
  function removeFile(fileId: string) {
    setFiles((prev) => prev.filter((f) => f.fileId !== fileId));
  }

  /** 拖拽事件：只负责高亮与取文件 */
  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const dropped = e.dataTransfer.files;
    for (const file of Array.from(dropped)) {
      handleUpload(file);
    }
  }

  /** 发送：拼接文件引用 + 清空输入与文件列表（支持纯文件上传，无文字也可发送） */
  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    const hasFiles = files.length > 0;
    // 文字和文件都为空时无内容可发
    // 注意：loading 时不阻止发送，用户可以在 LLM 思考时继续输入
    if (!text && !hasFiles) return;

    const fileIds = files.map((f) => f.fileId);
    const fileBlock = hasFiles
      ? `[用户上传了文件]\n${files
          .map((f) => `- ${f.name} (fileId: ${f.fileId}, 本地路径: ${f.path})`)
          .join("\n")}`
      : "";

    if (isReply && onAnswer) {
      // reply 模式：调用 onAnswer，文件引用由后端拼接
      onAnswer(text, fileIds);
    } else {
      // normal 模式：文件引用拼到消息文本中；纯文件上传时消息只有文件引用
      onSend(text ? (fileBlock ? `${text}\n\n${fileBlock}` : text) : fileBlock);
    }
    setFiles([]);
  }

  return (
    <div
      className={`chat-input-wrap ${dragOver ? "drag-over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {/* 已上传文件 chips */}
      {files.length > 0 && (
        <div className="file-chips">
          {files.map((f) => (
            <span key={f.fileId} className="file-chip">
              {f.name}
              <button
                type="button"
                className="file-chip-remove"
                onClick={() => removeFile(f.fileId)}
                title="移除文件"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* 回复模式：输入框上方显示当前问题摘要 */}
      {isReply && pendingQuestionText && (
        <div className="reply-question">
          <span className="reply-question-icon">🤔</span>
          <span className="reply-question-text">{pendingQuestionText}</span>
        </div>
      )}

      {/* 输入行：上传按钮在输入框左侧外侧，不随输入行数变化 */}
      <div className="chat-input-row">
        <button
          type="button"
          className="btn btn-icon"
          title="上传文件"
          aria-label="上传文件"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
        >
          {uploading ? <span className="btn-icon-spinner" /> : <UploadIcon />}
        </button>

        <form className="chat-input" onSubmit={handleSubmit}>
          {/* 隐藏的文件选择框 */}
          <input
            ref={fileInputRef}
            type="file"
            hidden
            multiple
            onChange={(e) => {
              const selected = e.target.files;
              if (selected) {
                for (const file of Array.from(selected)) {
                  handleUpload(file);
                }
              }
              // 允许重复选择同一文件
              e.target.value = "";
            }}
          />

          {/* 需求输入框（自适应高度由 CSS field-sizing 实现） */}
          <textarea
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            placeholder={
              isReply
                ? "回复 AI 的问题…（Ctrl+Enter 发送）"
                : "描述你的工作流需求…（Ctrl+Enter 发送）"
            }
            rows={1}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                handleSubmit(e);
              }
            }}
          />

          <button
            type="submit"
            className="btn btn-primary"
            disabled={!input.trim() && files.length === 0}
          >
            {isReply ? "回复" : loading ? "打断并发送" : "发送"}
          </button>
        </form>
      </div>

      <p className="input-hint">
        {isReply
          ? "正在回复 AI 的问题，上传按钮仍可用于提供补充文件"
          : loading
            ? "AI 处理中… 发送新消息将打断当前思考"
            : "支持拖拽上传文件，发送后文件引用会附加到消息中"}
      </p>
    </div>
  );
}
