/**
 * WorkflowCanvas 组件 —— 中间工作流草图展示区
 *
 * 职责：展示工作流草图的节点列表
 *
 * TODO: 后续使用 ReactFlow 实现可拖拽节点编辑器
 */

import type { WorkflowSketch } from "@coze-workflow/shared";

const NODE_COLORS: Record<string, string> = {
  start: "#4caf50",
  end: "#e94560",
  llm: "#7c4dff",
  code: "#ff9800",
  condition: "#ffc107",
  http: "#2196f3",
  database_query: "#00bcd4",
};

interface Props {
  sketch: WorkflowSketch | null;
}

export function WorkflowCanvas({ sketch }: Props) {
  return (
    <div className="workflow-canvas">
      <h2 className="panel-title">工作流草图</h2>
      <div className="canvas-placeholder">
        {sketch ? (
          <div className="sketch-list">
            {sketch.nodes.map((node, i) => {
              const color = NODE_COLORS[node.type] ?? "#888";
              return (
                <div key={node.id} className="sketch-node">
                  <div
                    className="sketch-node-type"
                    style={{ background: color }}
                  >
                    {node.type.toUpperCase()}
                  </div>
                  <div className="sketch-node-info">
                    <span className="sketch-node-label">{node.label}</span>
                    <span className="sketch-node-purpose">{node.purpose}</span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="placeholder-content">
            <span className="placeholder-icon">📋</span>
            <p>工作流草图将在此展示</p>
          </div>
        )}

        <p className="hint-text canvas-hint">
          TODO: 后续使用 ReactFlow 实现拖拽式节点编辑器
        </p>
      </div>
    </div>
  );
}
