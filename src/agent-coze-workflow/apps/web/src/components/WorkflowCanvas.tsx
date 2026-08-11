/**
 * WorkflowCanvas 组件 —— 中间工作流草图展示区
 *
 * 职责：可视化展示工作流节点和连线
 *
 * TODO: 后续使用 ReactFlow 实现可拖拽节点编辑器
 */

const MOCK_NODES = [
  { id: "start", type: "start", label: "开始", x: 160, y: 30 },
  { id: "llm_1", type: "llm", label: "LLM 处理", x: 160, y: 150 },
  { id: "end", type: "end", label: "结束", x: 160, y: 270 },
];

const MOCK_EDGES = [
  { from: "start", to: "llm_1" },
  { from: "llm_1", to: "end" },
];

const NODE_COLORS: Record<string, string> = {
  start: "#4caf50",
  end: "#e94560",
  llm: "#7c4dff",
  code: "#ff9800",
  condition: "#ffc107",
  http: "#2196f3",
  database_query: "#00bcd4",
};

function NodeCard({
  node,
  isActive = false,
}: {
  node: (typeof MOCK_NODES)[number];
  isActive?: boolean;
}) {
  const color = NODE_COLORS[node.type] ?? "#888";

  return (
    <div
      className="canvas-node"
      style={{
        left: node.x,
        top: node.y,
        borderColor: isActive ? color : "var(--color-border)",
      }}
    >
      <div className="node-header" style={{ background: color }}>
        <span className="node-type-badge">{node.type.toUpperCase()}</span>
      </div>
      <div className="node-body">
        <span className="node-label">{node.label}</span>
        <span className="node-id">{node.id}</span>
      </div>
    </div>
  );
}

export function WorkflowCanvas() {
  return (
    <div className="workflow-canvas">
      <h2 className="panel-title">工作流草图</h2>
      <div className="canvas-placeholder">
        {/* mock 节点渲染 */}
        <div className="canvas-svg-area">
          {MOCK_EDGES.map((edge, i) => {
            const fromNode = MOCK_NODES.find((n) => n.id === edge.from);
            const toNode = MOCK_NODES.find((n) => n.id === edge.to);
            if (!fromNode || !toNode) return null;
            return (
              <svg
                key={i}
                className="canvas-edge-svg"
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width: "100%",
                  height: "100%",
                  pointerEvents: "none",
                }}
              >
                <line
                  x1={fromNode.x + 80}
                  y1={fromNode.y + 70}
                  x2={toNode.x + 80}
                  y2={toNode.y + 10}
                  stroke="var(--color-text-muted)"
                  strokeWidth={2}
                  markerEnd="url(#arrowhead)"
                />
              </svg>
            );
          })}
          <svg width="0" height="0">
            <defs>
              <marker
                id="arrowhead"
                markerWidth="8"
                markerHeight="6"
                refX="8"
                refY="3"
                orient="auto"
              >
                <polygon
                  points="0 0, 8 3, 0 6"
                  fill="var(--color-text-muted)"
                />
              </marker>
            </defs>
          </svg>

          {MOCK_NODES.map((node) => (
            <NodeCard key={node.id} node={node} />
          ))}
        </div>
        <p className="hint-text canvas-hint">
          TODO: 后续使用 ReactFlow 实现拖拽式节点编辑器
        </p>
      </div>
    </div>
  );
}
