/**
 * WorkflowToDoc - CozeWorkflow → 人类可读 Markdown 说明书
 *
 * 职责：
 * 把项目格式工作流渲染成人类可读的 Markdown 说明书（纯函数、无 LLM 参与写作）。
 * read_workflow 工具的输出产物，同时满足「LLM 读工作流」和「人类看工作流」两个需求。
 *
 * 流程：
 * 1. 头部：名称 / 来源 / 节点数 / 边数
 * 2. 七章节固定结构：概览 → 拓扑图 → 节点清单 → 数据流说明 → 配置详情 → 验证报告 → 透传区
 * 3. 校验状态 = validateWorkflow + checkPlatformCompatibility 真实结果拼接（不编造）
 * 4. 数据流说明由代码遍历 edges 生成（节点注释用 title）
 *
 * 关键细节：
 * - 说明书是即席渲染的派生产物：不落盘、不维护版本，只从源头单向渲染
 * - mermaid 图分层（每张 ≤ 10 节点）由 mermaid-generator 承担，这里负责包围栏
 * - 透传区展示 _temp.externalData.platformRaw（showRaw 时，JSON 摘要）
 */
import type {
  CozeWorkflow,
  CozeNode,
  CozeEdge,
} from "@coze-workflow/workflow-schema";
import { validateWorkflow } from "@coze-workflow/workflow-schema";
import { checkPlatformCompatibility } from "./platform-validator";
import { workflowToMermaid } from "./mermaid-generator";

/** 说明书选项 */
export interface WorkflowDocOptions {
  /** 来源标注（cache/platform/draft） */
  source?: "cache" | "platform" | "draft";
  /** 是否展示透传区原始 JSON */
  showRaw?: boolean;
}

/** 节点类型中文标签（清单/数据流用） */
const TYPE_LABELS: Record<string, string> = {
  start: "开始",
  end: "结束",
  llm: "大模型",
  code: "代码",
  condition: "条件分支",
  text: "文本处理",
  merge: "变量聚合",
  database_query: "查询数据",
  http: "HTTP 请求",
};

/**
 * 工作流 → Markdown 说明书
 *
 * @param workflow - 项目格式工作流
 * @param opts - 来源标注 / 透传区开关
 * @returns 7 章节固定结构的 Markdown 说明书
 */
export function workflowToDoc(
  workflow: CozeWorkflow,
  opts?: WorkflowDocOptions,
): string {
  const source = opts?.source ?? "draft";
  const showRaw = opts?.showRaw ?? false;
  const nodes = workflow.nodes ?? [];
  const edges = workflow.edges ?? [];

  // 校验结果（真实计算一次，概览 + 验证报告两处复用，不编造）
  const structValidation = validateWorkflow(workflow);
  const compatResult = checkPlatformCompatibility(workflow);
  const danglingEdges = findDanglingEdges(nodes, edges);
  const validationSummary = summarizeValidation(
    structValidation,
    compatResult,
    danglingEdges,
  );

  const lines: string[] = [];

  // 头部
  lines.push(`# 工作流说明书：${workflow.meta?.name ?? "未命名"}`);
  lines.push("");
  lines.push(
    `> 来源：${source}｜节点数：${nodes.length}｜边数：${edges.length}｜渲染于本次调用`,
  );
  lines.push("");

  // ============ 1. 概览 ============
  lines.push("## 1. 概览");
  lines.push("");
  lines.push(`- 名称：${workflow.meta?.name ?? "未命名"}`);
  lines.push(`- 描述：${workflow.meta?.description || "无"}`);
  lines.push(`- 输入：${describeInputs(workflow)}`);
  lines.push(`- 输出：${describeOutputs(workflow)}`);
  lines.push(`- 节点数：${nodes.length}`);
  lines.push(`- 边数：${edges.length}`);
  lines.push(`- 校验状态：${validationSummary}`);
  lines.push("");

  // ============ 2. 拓扑图 ============
  lines.push("## 2. 拓扑图");
  lines.push("");
  const graphs = workflowToMermaid(workflow);
  graphs.forEach((graph, i) => {
    if (graphs.length > 1) {
      lines.push(`<!-- graph ${i + 1}/${graphs.length} -->`);
    }
    lines.push("```mermaid");
    lines.push(graph);
    lines.push("```");
    lines.push("");
  });

  // ============ 3. 节点清单 ============
  lines.push("## 3. 节点清单");
  lines.push("");
  lines.push("| # | id | 类型 | title | 输入 | 输出 |");
  lines.push("|---|---|---|---|---|---|");
  nodes.forEach((node, i) => {
    const io = describeNodeIO(node);
    lines.push(
      `| ${i + 1} | ${escapeCell(node.id)} | ${escapeCell(typeLabel(node.type))} | ${escapeCell(node.title)} | ${escapeCell(io.inputs)} | ${escapeCell(io.outputs)} |`,
    );
  });
  lines.push("");

  // ============ 4. 数据流说明 ============
  lines.push("## 4. 数据流说明");
  lines.push("");
  const flow = describeDataFlow(nodes, edges);
  if (flow.length > 0) {
    lines.push(`数据流向：${flow.join(" → ")}`);
  } else {
    lines.push("（无数据流：节点间没有连线）");
  }
  lines.push("");

  // ============ 5. 配置详情 ============
  lines.push("## 5. 配置详情");
  lines.push("");
  for (const node of nodes) {
    lines.push(`### ${escapeHeading(node.title)}（${typeLabel(node.type)}）`);
    lines.push("");
    const configLines = describeNodeConfig(node);
    if (configLines.length === 0) {
      lines.push("无");
    } else {
      for (const c of configLines) {
        lines.push(c);
      }
    }
    lines.push("");
  }

  // ============ 6. 验证报告 ============
  lines.push("## 6. 验证报告");
  lines.push("");
  if (structValidation.valid) {
    lines.push("- 结构校验：通过");
  } else {
    lines.push("- 结构校验：未通过");
    for (const e of structValidation.errors) {
      lines.push(`  - ${e.message}`);
    }
  }
  if (compatResult.valid) {
    lines.push(
      `- 平台兼容：通过${compatResult.warnings.length > 0 ? `（警告 ${compatResult.warnings.length} 条）` : ""}`,
    );
  } else {
    lines.push("- 平台兼容：未通过");
    for (const e of compatResult.errors) {
      lines.push(`  - ${e}`);
    }
  }
  if (danglingEdges.length === 0) {
    lines.push("- 悬空边检查：无悬空边（所有边引用的节点均存在）");
  } else {
    lines.push(`- 悬空边检查：${danglingEdges.length} 条边引用了不存在的节点`);
    for (const d of danglingEdges) {
      lines.push(`  - ${d}`);
    }
  }
  lines.push("");

  // ============ 7. 透传区 ============
  const rawSections = collectPlatformRaw(nodes);
  if (showRaw && rawSections.length > 0) {
    lines.push("## 7. 透传区");
    lines.push("");
    lines.push("反转换时无法映射到项目字段的原始平台数据（原样保留，防丢）：");
    lines.push("");
    for (const section of rawSections) {
      lines.push(`### ${escapeHeading(section.title)}`);
      lines.push("");
      lines.push("```json");
      lines.push(section.json);
      lines.push("```");
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}

// ============================================
// 校验状态
// ============================================

/** 概览用校验状态一句话（真实结果拼接，不编造） */
function summarizeValidation(
  struct: { valid: boolean; errors: Array<{ message: string }> },
  compat: { valid: boolean; errors: string[] },
  danglingEdges: string[],
): string {
  const parts: string[] = [];
  parts.push(
    struct.valid
      ? "结构校验通过"
      : `结构校验失败（${struct.errors.length} 个错误）`,
  );
  parts.push(
    compat.valid
      ? "平台兼容通过"
      : `平台兼容失败（${compat.errors.length} 个错误）`,
  );
  parts.push(
    danglingEdges.length === 0
      ? "无悬空边"
      : `悬空边 ${danglingEdges.length} 条`,
  );
  return parts.join("；");
}

/** 悬空边检查：边引用的节点 id 不存在 */
function findDanglingEdges(nodes: CozeNode[], edges: CozeEdge[]): string[] {
  const ids = new Set(nodes.map((n) => n.id));
  const dangling: string[] = [];
  for (const edge of edges) {
    if (edge.sourceNodeId && !ids.has(edge.sourceNodeId)) {
      dangling.push(`边 "${edge.id}" 源节点 "${edge.sourceNodeId}" 不存在`);
    }
    if (edge.targetNodeId && !ids.has(edge.targetNodeId)) {
      dangling.push(`边 "${edge.id}" 目标节点 "${edge.targetNodeId}" 不存在`);
    }
  }
  return dangling;
}

// ============================================
// 概览辅助
// ============================================

/** 工作流输入描述（start 节点 inputVariables） */
function describeInputs(workflow: CozeWorkflow): string {
  const start = workflow.nodes.find((n) => n.type === "start");
  const vars = (
    start as unknown as { inputVariables?: Array<{ name: string }> }
  )?.inputVariables;
  if (!vars || vars.length === 0) return "无（未声明开始节点输入）";
  return vars.map((v) => v.name).join("、");
}

/** 工作流输出描述（end 节点 outputVariables） */
function describeOutputs(workflow: CozeWorkflow): string {
  const end = workflow.nodes.find((n) => n.type === "end");
  const vars = (end as unknown as { outputVariables?: Array<{ name: string }> })
    ?.outputVariables;
  if (!vars || vars.length === 0) return "无（未声明结束节点输出）";
  return vars.map((v) => v.name).join("、");
}

// ============================================
// 节点辅助
// ============================================

/** 节点类型 → 中文标签（未知类型原样展示数字） */
function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type;
}

/** 节点输入/输出摘要（节点清单表格用） */
function describeNodeIO(node: CozeNode): { inputs: string; outputs: string } {
  const n = node as unknown as Record<string, unknown>;
  switch (node.type) {
    case "start": {
      const vars =
        (n.inputVariables as Array<{ name: string }> | undefined) ?? [];
      return {
        inputs: "—",
        outputs: vars.map((v) => v.name).join("、") || "—",
      };
    }
    case "end": {
      const vars =
        (n.outputVariables as Array<{ name: string }> | undefined) ?? [];
      return {
        inputs: vars.map((v) => v.name).join("、") || "—",
        outputs: "—",
      };
    }
    case "condition": {
      const branches =
        (n.branches as Array<{ label?: string }> | undefined) ?? [];
      return {
        inputs: "—",
        outputs:
          branches
            .map((b) => b.label ?? "")
            .filter(Boolean)
            .join("、") || "分支",
      };
    }
    case "merge": {
      const groups =
        (n.mergeGroups as Array<{ name: string }> | undefined) ?? [];
      return {
        inputs: "—",
        outputs: groups.map((g) => g.name).join("、") || "—",
      };
    }
    default: {
      const mapping =
        (n.inputMapping as Record<string, string> | undefined) ?? {};
      const outputs = (n.outputs as Array<{ name?: string }> | undefined) ?? [];
      return {
        inputs: Object.keys(mapping).join("、") || "—",
        outputs:
          outputs
            .map((o) => o.name ?? "")
            .filter(Boolean)
            .join("、") || "—",
      };
    }
  }
}

/** 节点配置详情（配置详情章节用，无配置返回空数组 → 显示"无"） */
function describeNodeConfig(node: CozeNode): string[] {
  const n = node as unknown as Record<string, unknown>;
  const lines: string[] = [];

  switch (node.type) {
    case "start": {
      const vars =
        (n.inputVariables as
          | Array<{ name: string; type?: string }>
          | undefined) ?? [];
      for (const v of vars) {
        lines.push(`- 输入变量：${v.name}（${v.type ?? "string"}）`);
      }
      return lines;
    }
    case "end": {
      const vars =
        (n.outputVariables as
          | Array<{ name: string; value?: string }>
          | undefined) ?? [];
      for (const v of vars) {
        lines.push(`- 输出变量：${v.name} = ${v.value ?? ""}`);
      }
      return lines;
    }
    case "llm": {
      const config = n.config as
        | { model?: string; temperature?: number; maxTokens?: number }
        | undefined;
      if (config?.model) lines.push(`- 模型：${config.model}`);
      if (config?.temperature !== undefined)
        lines.push(`- temperature：${config.temperature}`);
      if (config?.maxTokens !== undefined)
        lines.push(`- maxTokens：${config.maxTokens}`);
      if (typeof n.userPrompt === "string" && n.userPrompt) {
        lines.push(`- 提示词：${n.userPrompt}`);
      }
      if (typeof n.systemPrompt === "string" && n.systemPrompt) {
        lines.push(`- 系统提示词：${n.systemPrompt}`);
      }
      return lines;
    }
    case "code": {
      if (n.language) lines.push(`- 语言：${String(n.language)}`);
      if (typeof n.code === "string" && n.code) {
        lines.push("- 代码：");
        lines.push("```python");
        lines.push(n.code);
        lines.push("```");
      }
      return lines;
    }
    case "condition": {
      const branches =
        (n.branches as
          | Array<{ label?: string; condition?: string; targetNodeId?: string }>
          | undefined) ?? [];
      branches.forEach((b, i) => {
        lines.push(
          `- 分支 ${i + 1}：${b.condition ?? ""}${b.targetNodeId ? ` → ${b.targetNodeId}` : ""}`,
        );
      });
      if (n.defaultBranch)
        lines.push(`- 默认分支 → ${String(n.defaultBranch)}`);
      return lines;
    }
    case "text": {
      const params =
        (n.concatParams as
          | Array<{ name: string; value: string }>
          | undefined) ?? [];
      const template = params.find((p) => p.name === "concatResult")?.value;
      if (template) lines.push(`- 拼接模板：${template}`);
      return lines;
    }
    case "merge": {
      const groups =
        (n.mergeGroups as
          | Array<{ name: string; variables: string[] }>
          | undefined) ?? [];
      for (const g of groups) {
        lines.push(
          `- 分组 ${g.name}：${(g.variables ?? []).join("、") || "无变量"}`,
        );
      }
      return lines;
    }
    case "database_query": {
      if (n.connection) lines.push(`- 数据库连接：${String(n.connection)}`);
      if (typeof n.query === "string" && n.query) {
        lines.push(`- 查询条件（平台 selectParam JSON）：${n.query}`);
      }
      return lines;
    }
    case "http": {
      if (n.method) lines.push(`- 方法：${String(n.method)}`);
      if (n.url) lines.push(`- URL：${String(n.url)}`);
      return lines;
    }
    default: {
      // 未知类型：透传区有原始 JSON，这里给类型提示
      lines.push(`- 节点类型：${String(n.type)}（原始数据见透传区）`);
      return lines;
    }
  }
}

// ============================================
// 数据流说明
// ============================================

/**
 * 按拓扑序遍历生成数据流描述（简单句：title（类型））
 *
 * 起点取入度为 0 的节点，其后按边走向深度优先铺开；
 * 环内节点按原顺序兜底，保证所有节点都被提及。
 */
function describeDataFlow(nodes: CozeNode[], edges: CozeEdge[]): string[] {
  const ids = new Set(nodes.map((n) => n.id));
  const adjacency = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const n of nodes) {
    adjacency.set(n.id, []);
    inDegree.set(n.id, 0);
  }
  for (const e of edges) {
    if (!ids.has(e.sourceNodeId) || !ids.has(e.targetNodeId)) continue;
    if (e.sourceNodeId === e.targetNodeId) continue;
    adjacency.get(e.sourceNodeId)!.push(e.targetNodeId);
    inDegree.set(e.targetNodeId, (inDegree.get(e.targetNodeId) ?? 0) + 1);
  }

  const order: CozeNode[] = [];
  const visited = new Set<string>();
  const queue = nodes.filter((n) => inDegree.get(n.id) === 0);
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (visited.has(node.id)) continue;
    visited.add(node.id);
    order.push(node);
    for (const target of adjacency.get(node.id) ?? []) {
      const next = (inDegree.get(target) ?? 1) - 1;
      inDegree.set(target, next);
      if (next === 0) {
        const targetNode = nodes.find((n) => n.id === target);
        if (targetNode) queue.push(targetNode);
      }
    }
  }
  for (const n of nodes) {
    if (!visited.has(n.id)) order.push(n);
  }

  return order.map((n) => `${n.title}（${typeLabel(n.type)}）`);
}

// ============================================
// 透传区
// ============================================

/** 收集各节点 _temp.externalData.platformRaw */
function collectPlatformRaw(
  nodes: CozeNode[],
): Array<{ title: string; json: string }> {
  const sections: Array<{ title: string; json: string }> = [];
  for (const node of nodes) {
    const platformRaw = (
      node as unknown as {
        _temp?: { externalData?: { platformRaw?: unknown } };
      }
    )?._temp?.externalData?.platformRaw;
    if (platformRaw === undefined) continue;
    sections.push({
      title: `${node.title}（${node.id}）`,
      json: JSON.stringify(platformRaw, null, 2),
    });
  }
  return sections;
}

// ============================================
// 转义辅助（Markdown 表格/标题安全）
// ============================================

/** 表格单元格转义：竖线/换行替换，避免破坏表格结构 */
function escapeCell(text: string): string {
  return String(text)
    .replace(/\|/g, "\\|")
    .replace(/[\n\r]+/g, " ");
}

/** 标题转义：换行折叠，避免破坏标题行 */
function escapeHeading(text: string): string {
  return String(text).replace(/[\n\r]+/g, " ");
}
