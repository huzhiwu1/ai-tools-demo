/**
 * InputPanel 组件 —— 左侧输入面板
 *
 * 职责：接收用户自然语言需求输入，点击生成按钮触发工作流生成
 */

import { useState } from "react";

const EXAMPLE_REQUIREMENTS = [
  "我需要一个工作流，先接收用户问题，然后调用 GPT-4 分析问题，最后根据分析结果给出建议。",
  "创建一个数据管道：从 API 拉取数据 → 清洗转换 → 写入数据库 → 通知用户。",
  "构建客服机器人：识别用户意图 → 转接对应部门 → LLM 生成回复 → 记录日志。",
];

interface Props {
  onGenerate: (description: string) => void;
  loading: boolean;
}

export function InputPanel({ onGenerate, loading }: Props) {
  const [requirement, setRequirement] = useState("");

  return (
    <div className="input-panel">
      <h2 className="panel-title">需求输入</h2>

      <textarea
        className="input-textarea"
        placeholder="请用自然语言描述你的工作流需求..."
        rows={8}
        value={requirement}
        onChange={(e) => setRequirement(e.target.value)}
        disabled={loading}
      />

      <div className="example-section">
        <p className="example-label">示例需求（点击填入）：</p>
        {EXAMPLE_REQUIREMENTS.map((text, i) => (
          <button
            key={i}
            className="btn-example"
            onClick={() => setRequirement(text)}
            type="button"
            disabled={loading}
          >
            示例 {i + 1}
          </button>
        ))}
      </div>

      <button
        className="btn btn-primary"
        type="button"
        disabled={!requirement.trim() || loading}
        onClick={() => onGenerate(requirement)}
      >
        {loading ? "生成中..." : "生成工作流"}
      </button>
      <p className="hint-text">
        当前为 mock 链路：需求 → 规划 → 草图 → JSON → 校验
      </p>
    </div>
  );
}
