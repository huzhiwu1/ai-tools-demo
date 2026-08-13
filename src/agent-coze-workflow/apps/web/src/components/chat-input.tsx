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

export function ChatInput({ input, onInputChange, onSend, loading }: Props) {
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

  /** 发送：拼接文件引用 + 清空输入与文件列表 */
  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading) return;

    const fileNote =
      files.length > 0
        ? `\n\n[用户上传了文件]\n${files
            .map((f) => `- ${f.name} (fileId: ${f.fileId})`)
            .join("\n")}`
        : "";

    onSend(text + fileNote);
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
            placeholder="描述你的工作流需求…（Ctrl+Enter 发送）"
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
            disabled={loading || !input.trim()}
          >
            {loading ? "思考中…" : "发送"}
          </button>
        </form>
      </div>

      <p className="input-hint">支持拖拽上传文件，发送后文件引用会附加到消息中</p>
    </div>
  );
}
