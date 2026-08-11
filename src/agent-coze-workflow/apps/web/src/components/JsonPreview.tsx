/**
 * JsonPreview 组件 —— 右侧 JSON 输出预览
 *
 * 职责：展示生成的工作流 JSON 结构 + 校验结果
 */

import type { ValidationResult } from "@coze-workflow/shared";
import type { CozeWorkflow } from "../api/workflow.js";

interface Props {
  workflow: CozeWorkflow | null;
  validation: ValidationResult | null;
}

export function JsonPreview({ workflow, validation }: Props) {
  return (
    <div className="json-preview">
      <h2 className="panel-title">JSON 输出</h2>
      <pre className="json-content">
        <code>
          {workflow
            ? JSON.stringify(workflow, null, 2)
            : "// 点击「生成工作流」后此处展示 Coze 工作流 JSON"}
        </code>
      </pre>

      {validation && (
        <div className="validation-summary">
          <h3 className="panel-title" style={{ marginTop: 12 }}>
            校验结果: {validation.valid ? "通过" : "失败"}
          </h3>

          {validation.errors.length > 0 && (
            <div className="validation-errors">
              <p className="validation-label error-label">
                错误 ({validation.errors.length}):
              </p>
              <ul className="validation-list">
                {validation.errors.map((e, i) => (
                  <li key={i} className="validation-item validation-error">
                    [{e.code}] {e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {validation.warnings.length > 0 && (
            <div className="validation-warnings">
              <p className="validation-label warning-label">
                警告 ({validation.warnings.length}):
              </p>
              <ul className="validation-list">
                {validation.warnings.map((w, i) => (
                  <li key={i} className="validation-item validation-warning">
                    [{w.code}] {w.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
