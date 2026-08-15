/**
 * MermaidGenerator - CozeWorkflow → mermaid flowchart
 *
 * 职责：
 * 把项目格式工作流渲染为一个或多个 mermaid flowchart 代码片段（纯函数、无 LLM）。
 *
 * 流程：
 * 1. 拓扑排序（Kahn，环内节点按原顺序兜底）
 * 2. 按拓扑序分段，每张图 ≤ maxNodesPerGraph 个节点（默认 10）
 * 3. 每段生成一段 flowchart：节点用数字别名 + title 标签（转义特殊字符）
 * 4. 每条边画在「源节点所在段」的图上（目标在后段时 mermaid 自动补空节点）
 *
 * 关键细节：
 * - 节点 id 用 title 做标签，特殊字符转义（引号替换为 #quot;），避免破坏 mermaid 语法
 * - 边带端口注释：condition 分支边标注 "true/false"；llm 的 branch_error 边标注 "branch_error"
 * - 返回值是字符串数组（每个元素是一段完整 flowchart，调用方负责包 ```mermaid 围栏）
 */
import type {
  CozeWorkflow,
  CozeNode,
  CozeEdge,
} from "@coze-workflow/workflow-schema";

/** 每张图默认最大节点数 */
const DEFAULT_MAX_NODES_PER_GRAPH = 10;

/** 端口 → mermaid 边注释（无端口的边不加注释） */
const PORT_LABELS: Record<string, string> = {
  true: "true",
  false: "false",
  default: "default",
  branch_error: "branch_error",
};

/**
 * 工作流 → mermaid flowchart 片段数组
 *
 * @param workflow - 项目格式工作流
 * @param opts.maxNodesPerGraph - 每张图最大节点数（默认 10）
 * @returns mermaid flowchart 片段（每个元素是一张完整图）
 */
export function workflowToMermaid(
  workflow: CozeWorkflow,
  opts?: { maxNodesPerGraph?: number },
): string[] {
  const maxPerGraph = opts?.maxNodesPerGraph ?? DEFAULT_MAX_NODES_PER_GRAPH;
  const nodes = workflow.nodes ?? [];
  const edges = workflow.edges ?? [];

  // 1. 拓扑排序
  const order = topoSort(nodes, edges);

  // 2. 分段：每段 ≤ maxPerGraph 个节点
  const segments: CozeNode[][] = [];
  for (let i = 0; i < order.length; i += maxPerGraph) {
    segments.push(order.slice(i, i + maxPerGraph));
  }

  // 3. 每段生成一张 flowchart
  return segments.map((segment, segIdx) => {
    const lines: string[] = ["flowchart TD"];

    // 节点：数字别名（n{seq}）+ title 标签（转义特殊字符）
    segment.forEach((node, i) => {
      const seq = segIdx * maxPerGraph + i;
      lines.push(`  n${seq}["${escapeLabel(node.title)}"]`);
    });

    // 边：画在源节点所在段（每条边只画一次，保证箭头总数 = 边数）
    for (const edge of edges) {
      const sourceIdx = order.findIndex((n) => n.id === edge.sourceNodeId);
      const segStart = segIdx * maxPerGraph;
      const segEnd = segStart + segment.length;
      if (sourceIdx < segStart || sourceIdx >= segEnd) continue;

      const sourceSeq = sourceIdx;
      const targetIdx = order.findIndex((n) => n.id === edge.targetNodeId);
      // 目标不在节点列表（悬空边）：目标序号用源序号 + 999 占位，保持图可渲染
      const targetSeq = targetIdx >= 0 ? targetIdx : sourceSeq + 999;

      const portLabel = edge.sourcePort
        ? PORT_LABELS[edge.sourcePort]
        : undefined;
      if (portLabel) {
        lines.push(`  n${sourceSeq} -- "${portLabel}" --> n${targetSeq}`);
      } else {
        lines.push(`  n${sourceSeq} --> n${targetSeq}`);
      }
    }

    return lines.join("\n");
  });
}

/**
 * mermaid 节点标签转义：引号会破坏 ["..."] 语法，替换为 #quot;
 * 换行/回车会破坏行结构，折叠为空格。
 */
function escapeLabel(text: string): string {
  return String(text)
    .replace(/"/g, "#quot;")
    .replace(/[\n\r]+/g, " ");
}

/**
 * 拓扑排序（Kahn 算法）
 *
 * 有环时环内节点无法进入队列，最后按原顺序兜底追加，保证所有节点都出现在图中。
 */
function topoSort(nodes: CozeNode[], edges: CozeEdge[]): CozeNode[] {
  const ids = new Set(nodes.map((n) => n.id));
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const n of nodes) {
    inDegree.set(n.id, 0);
    adjacency.set(n.id, []);
  }

  for (const e of edges) {
    if (!ids.has(e.sourceNodeId) || !ids.has(e.targetNodeId)) continue;
    if (e.sourceNodeId === e.targetNodeId) continue;
    adjacency.get(e.sourceNodeId)!.push(e.targetNodeId);
    inDegree.set(e.targetNodeId, (inDegree.get(e.targetNodeId) ?? 0) + 1);
  }

  const queue = nodes.filter((n) => inDegree.get(n.id) === 0);
  const result: CozeNode[] = [];
  const done = new Set<string>();
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (done.has(node.id)) continue;
    done.add(node.id);
    result.push(node);
    for (const target of adjacency.get(node.id) ?? []) {
      const next = (inDegree.get(target) ?? 1) - 1;
      inDegree.set(target, next);
      if (next === 0) {
        const targetNode = nodes.find((n) => n.id === target);
        if (targetNode) queue.push(targetNode);
      }
    }
  }

  // 环内节点按原顺序兜底
  for (const n of nodes) {
    if (!done.has(n.id)) result.push(n);
  }
  return result;
}
