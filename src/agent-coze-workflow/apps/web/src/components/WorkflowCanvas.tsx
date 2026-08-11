/**
 * WorkflowCanvas 组件 —— 中间工作流草图展示区
 *
 * 职责：可视化展示 WorkflowDraft 的节点和连线
 *
 * TODO: 后续使用 ReactFlow 或自定义 Canvas 实现图形化展示
 */
export function WorkflowCanvas() {
  return (
    <div className="workflow-canvas">
      <h2 className="panel-title">工作流草图</h2>
      <div className="canvas-placeholder">
        <div className="placeholder-content">
          <span className="placeholder-icon">📋</span>
          <p>工作流草图将在此展示</p>
          <p className="hint-text">
            TODO: 后续使用 ReactFlow 实现拖拽式节点编辑器
          </p>
        </div>
      </div>
    </div>
  );
}
