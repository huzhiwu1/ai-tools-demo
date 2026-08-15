/**
 * PlatformToProject - 平台 schema JSON → 项目 CozeWorkflow 反转换
 *
 * 职责：
 * 将平台工作流 schema（getSchema 返回的 schemaJson，或剪贴板导出的
 * coze-workflow-clipboard-data）逆向转换为项目格式 CozeWorkflow，
 * 供 read_workflow / 说明书渲染 / update 前的缓存刷新使用。
 *
 * 流程：
 * 1. 解析输入 JSON，识别剪贴板格式（type + json 字段）与 schemaJson 格式（nodes/edges）
 * 2. 转换 edges（sourceNodeID/targetNodeID/sourcePortID → source/target/port）
 * 3. 逐节点转换：数字 type → 项目类型、llmParam → config、ref → inputMapping
 * 4. 无法还原的字段存入节点 _temp.externalData.platformRaw（防丢），并记录 warnings
 *
 * 关键细节：
 * - 节点 id 直接用 String(id)（不做语义化映射，保持稳定）
 * - start/end（平台 100001/900001）在剪贴板样本中是隐式的（不在 nodes 里），
 *   nodes 里出现 type=1/2 时才转换；缺失不合成（保持节点数 = 样本原始数）
 * - ref 还原为 "blockID.name" 字符串形式（与 schema-converter 正向 refExpr 约定对齐）
 * - llm 节点 outputs 过滤 reasoning_content/errorBody/isSuccess 平台内置字段
 * - meta.name 从 opts 传入或使用默认值（反转换产物不是新建工作流，名字仅展示用）
 */
import type {
  CozeWorkflow,
  CozeNode,
  CozeEdge,
} from "@coze-workflow/workflow-schema";

/** 平台数字类型 → 项目字符串类型（与 schema-converter.ts 正向映射对照） */
const PLATFORM_TYPE_MAP: Record<string, string> = {
  "1": "start",
  "2": "end",
  "3": "llm",
  "5": "code",
  "8": "condition",
  "15": "text",
  "32": "merge",
  "43": "database_query",
  "45": "http",
};

/** LLM 节点平台内置输出字段（还原 outputs 时过滤） */
const LLM_BUILTIN_OUTPUTS = new Set([
  "reasoning_content",
  "errorBody",
  "isSuccess",
]);

/** llmParam 中能映射到项目 LLM 节点配置的项（其余进透传区） */
const LLM_PARAM_MAPPABLE = new Set([
  "temperature",
  "maxTokens",
  "modleName",
  "prompt",
  "systemPrompt",
]);

/** 反转换结果 */
export interface PlatformToProjectResult {
  /** 项目格式工作流（meta/nodes/edges） */
  workflow: CozeWorkflow;
  /** 无法还原的字段警告 */
  warnings: string[];
  /** 原始平台 schema（透传保留） */
  rawSchema: Record<string, unknown>;
}

/** 平台节点（弱类型，字段以实测样本为准） */
interface PlatformNode {
  id?: unknown;
  type?: unknown;
  meta?: { position?: { x?: number; y?: number } };
  data?: {
    nodeMeta?: { title?: string; description?: string };
    inputs?: Record<string, unknown>;
    outputs?: PlatformOutput[];
  };
  _temp?: unknown;
}

/** 平台输出声明 */
interface PlatformOutput {
  type?: string;
  name?: string;
  schema?: unknown;
  required?: boolean;
  readonly?: boolean;
  defaultValue?: string;
}

/** 平台输入/参数项（inputParameters/llmParam 通用形状） */
interface PlatformParam {
  name?: string;
  input?: {
    type?: string;
    schema?: unknown;
    value?: {
      type?: "literal" | "ref";
      content?: unknown;
      rawMeta?: unknown;
    };
  };
}

/** 平台边 */
interface PlatformEdge {
  sourceNodeID?: string;
  targetNodeID?: string;
  sourcePortID?: string;
}

/** 平台条件分支 */
interface PlatformBranch {
  label?: string;
  condition?: {
    logic?: unknown;
    conditions?: Array<{
      operator?: unknown;
      left?: { input?: { value?: unknown } };
    }>;
  };
}

/**
 * 平台 schema JSON 反转换为项目 CozeWorkflow
 *
 * @param schemaJson - 平台 schema JSON 字符串（getSchema 的 schemaJson，
 *   或剪贴板样本的 json 字段 JSON.stringify 结果）
 * @param opts.workflowName - 工作流名称（可选，说明书展示用；缺省用默认名）
 */
export function platformToProject(
  schemaJson: string,
  opts?: { workflowName?: string },
): PlatformToProjectResult {
  const warnings: string[] = [];

  const parsed = JSON.parse(schemaJson) as Record<string, unknown>;
  // 兼容两种结构：剪贴板格式 {type:"coze-workflow-clipboard-data", json:{nodes,edges}}
  // 与 getSchema 返回的 {versions:{...}, nodes, edges}
  const rawSchema =
    parsed.json && typeof parsed.json === "object"
      ? (parsed.json as Record<string, unknown>)
      : parsed;

  const platformNodes = (rawSchema.nodes ?? []) as PlatformNode[];
  const platformEdges = (rawSchema.edges ?? []) as PlatformEdge[];

  // 1. 先转边（condition 分支需要按「源节点|端口」反查目标节点）
  const edges: CozeEdge[] = platformEdges.map((e, i) => ({
    id: `e${i}`,
    sourceNodeId: String(e.sourceNodeID ?? ""),
    targetNodeId: String(e.targetNodeID ?? ""),
    ...(e.sourcePortID ? { sourcePort: e.sourcePortID } : {}),
  }));

  // 「源节点 id|端口」→ 目标节点 id（condition 分支 targetNodeId 还原用）
  const portTargets = new Map<string, string>();
  for (const e of platformEdges) {
    if (e.sourceNodeID && e.sourcePortID && e.targetNodeID) {
      portTargets.set(`${e.sourceNodeID}|${e.sourcePortID}`, e.targetNodeID);
    }
  }

  // 2. 逐节点转换
  const nodes: CozeNode[] = [];
  for (const raw of platformNodes) {
    nodes.push(convertNode(raw, nodes.length, warnings, portTargets));
  }

  // 3. 合成 start/end（平台剪贴板/部分 schema 里 start/end 是隐式的，不在 nodes 中）
  // 项目格式要求 start/end 唯一（validateWorkflow / checkPlatformCompatibility 都强校验），
  // 缺失会导致说明书验证报告误报“缺 start/end”，且 update→save 链路会被平台校验拦截。
  // 合成规则：无 start → 补 start 节点，入度为 0 的业务节点连到它；
  //          无 end → 补 end 节点，出度为 0 的业务节点连到它。
  const { nodes: finalNodes, edges: finalEdges } = ensureStartEnd(
    nodes,
    edges,
  );

  const workflow: CozeWorkflow = {
    meta: {
      name: opts?.workflowName ?? "platform_imported_workflow",
      description: "由平台 schema 反转换生成",
      version: "1.0.0",
    },
    nodes: finalNodes,
    edges: finalEdges,
  };

  return { workflow, warnings, rawSchema };
}

// ============================================
// 节点转换
// ============================================

/**
 * 转换单个平台节点 → 项目节点
 *
 * @param raw - 平台节点原始 JSON
 * @param index - 节点序号（兜底 id 用）
 * @param warnings - 警告收集器
 * @param portTargets - 「源节点|端口」→ 目标节点映射（condition 分支还原用）
 */
function convertNode(
  raw: PlatformNode,
  index: number,
  warnings: string[],
  portTargets: Map<string, string>,
): CozeNode {
  const id = String(raw.id ?? `node_${index}`);
  const nodeMeta = raw.data?.nodeMeta ?? {};
  const title = String(nodeMeta.title ?? id);
  const desc = nodeMeta.description ? String(nodeMeta.description) : undefined;
  const typeNumber = String(raw.type ?? "");
  const typeName = PLATFORM_TYPE_MAP[typeNumber];

  // 公共字段
  const base = {
    id,
    title,
    ...(desc ? { desc } : {}),
    ...(raw.meta?.position
      ? {
          position: {
            x: raw.meta.position.x ?? 0,
            y: raw.meta.position.y ?? 0,
          },
        }
      : {}),
  };

  // 未知节点类型：warning + 保留数字，整个 data 进透传区防丢
  if (!typeName) {
    warnings.push(
      `节点「${title}」类型 ${typeNumber} 未知，已保留数字类型，原始数据存入透传区`,
    );
    const platformRaw: Record<string, unknown> = {};
    if (raw.data) platformRaw.data = raw.data;
    return {
      ...base,
      type: typeNumber,
      _temp: { externalData: { platformRaw } },
    } as unknown as CozeNode;
  }

  const inputs = raw.data?.inputs ?? {};
  const outputs = raw.data?.outputs ?? [];

  // 平台无法还原的节点级字段收集器（进 _temp.externalData.platformRaw）
  const platformRaw: Record<string, unknown> = {};

  // 各类型专属转换
  let converted: Record<string, unknown> = {};

  switch (typeName) {
    case "llm": {
      const llmParam = (inputs.llmParam ?? []) as PlatformParam[];
      const literalOf = (name: string): unknown =>
        llmParam.find((p) => p.name === name)?.input?.value?.content;

      // llmParam → config（modleName/temperature/maxTokens）
      const model = String(literalOf("modleName") ?? "Doubao-Seed-2.0-Lite");
      const temperature = Number(literalOf("temperature"));
      const maxTokens = Number(literalOf("maxTokens"));
      converted.config = {
        model,
        ...(Number.isFinite(temperature) ? { temperature } : {}),
        ...(Number.isFinite(maxTokens) ? { maxTokens } : {}),
      };

      // prompt / systemPrompt
      converted.userPrompt = String(literalOf("prompt") ?? "");
      const systemPrompt = String(literalOf("systemPrompt") ?? "");
      if (systemPrompt) converted.systemPrompt = systemPrompt;

      // inputParameters（ref）→ inputMapping（"blockID.name" 形式）
      const inputMapping = paramsToMapping(
        (inputs.inputParameters ?? []) as PlatformParam[],
      );
      if (Object.keys(inputMapping).length > 0) {
        converted.inputMapping = inputMapping;
      }

      // outputs：过滤平台内置字段（reasoning_content/errorBody/isSuccess）
      converted.outputs = outputs
        .filter((o) => !LLM_BUILTIN_OUTPUTS.has(String(o.name)))
        .map((o) => outputToProject(o));

      // 无法映射的 llmParam 项 + settingOnError → 透传区
      const unmappedParams = llmParam.filter(
        (p) => !LLM_PARAM_MAPPABLE.has(String(p.name)),
      );
      if (unmappedParams.length > 0) platformRaw.llmParam = unmappedParams;
      if (inputs.settingOnError !== undefined) {
        platformRaw.settingOnError = inputs.settingOnError;
      }
      break;
    }

    case "code": {
      converted.code = String(inputs.code ?? "");
      // language：1=JavaScript，其余按 Python（平台约定 3=Python）
      converted.language = inputs.language === 1 ? "javascript" : "python";

      const inputMapping = paramsToMapping(
        (inputs.inputParameters ?? []) as PlatformParam[],
      );
      if (Object.keys(inputMapping).length > 0) {
        converted.inputMapping = inputMapping;
      }

      // outputs：schema 原样保留（正向 normalizeSchema 兼容数组/对象两种形态）
      converted.outputs = outputs.map((o) => outputToProject(o));
      if (inputs.settingOnError !== undefined) {
        platformRaw.settingOnError = inputs.settingOnError;
      }
      break;
    }

    case "condition": {
      const branches = (inputs.branches ?? []) as PlatformBranch[];
      // 分支 targetNodeId：按端口反查边（true → 分支目标，false/default → 默认分支）
      const convertedBranches = branches.map((b, i) => {
        const rendered = renderBranchCondition(b, title, warnings, i);
        const port = i === 0 ? "true" : `true_${i + 1}`;
        const targetNodeId =
          portTargets.get(`${id}|${port}`) ??
          portTargets.get(`${id}|true`) ??
          "";
        return {
          label: b.label ?? `分支${i + 1}`,
          condition: rendered,
          expression: rendered,
          targetNodeId,
        };
      });
      const defaultTarget =
        portTargets.get(`${id}|false`) ??
        portTargets.get(`${id}|default`) ??
        "";
      converted.branches = convertedBranches;
      converted.defaultBranch = defaultTarget;
      // 条件内部结构（logic/operator 细节）无法完整还原 → 透传区
      platformRaw.branches = branches;
      break;
    }

    case "text": {
      converted.method = "concat";
      // concatParams：只还原 concatResult 模板（其余平台默认值不还原）
      const concatParams = (inputs.concatParams ?? []) as PlatformParam[];
      const concatResult = concatParams.find((p) => p.name === "concatResult")
        ?.input?.value?.content;
      converted.concatParams = [
        { name: "concatResult", value: String(concatResult ?? "") },
      ];

      const inputMapping = paramsToMapping(
        (inputs.inputParameters ?? []) as PlatformParam[],
      );
      if (Object.keys(inputMapping).length > 0) {
        converted.inputMapping = inputMapping;
      }
      if (outputs.length > 0) {
        converted.outputs = outputs.map((o) => outputToProject(o));
      }
      break;
    }

    case "merge": {
      const groups = (inputs.mergeGroups ?? []) as Array<{
        name?: string;
        variables?: Array<{ value?: unknown }>;
      }>;
      converted.mergeGroups = groups.map((g) => ({
        name: String(g.name ?? "Group1"),
        variables: (g.variables ?? []).map((v) =>
          valueToRefExpr(v.value, "output"),
        ),
      }));
      break;
    }

    case "database_query": {
      const dbList = (inputs.databaseInfoList ?? []) as Array<{
        databaseInfoID?: unknown;
      }>;
      converted.connection = String(dbList[0]?.databaseInfoID ?? "");
      // 平台查询条件是结构化 selectParam（非 SQL 语句），无法还原为 query 字符串，
      // 序列化为 JSON 展示 + 原样进透传区防丢
      converted.query = inputs.selectParam
        ? JSON.stringify(inputs.selectParam)
        : "";
      if (inputs.selectParam !== undefined) {
        platformRaw.selectParam = inputs.selectParam;
      }
      if (inputs.settingOnError !== undefined) {
        platformRaw.settingOnError = inputs.settingOnError;
      }
      if (outputs.length > 0) {
        converted.outputs = outputs.map((o) => outputToProject(o));
      }
      break;
    }

    case "http": {
      const apiInfo = (inputs.apiInfo ?? {}) as {
        method?: unknown;
        url?: unknown;
      };
      converted.method = String(apiInfo.method ?? "GET");
      converted.url = String(apiInfo.url ?? "");

      const inputMapping = paramsToMapping(
        (inputs.inputParameters ?? []) as PlatformParam[],
      );
      if (Object.keys(inputMapping).length > 0) {
        converted.inputMapping = inputMapping;
      }
      if (outputs.length > 0) {
        converted.outputs = outputs.map((o) => outputToProject(o));
      }
      // body/headers/params/auth/setting 无法映射到项目字段 → 透传区
      for (const key of ["body", "headers", "params", "auth", "setting"]) {
        if (inputs[key] !== undefined) platformRaw[key] = inputs[key];
      }
      break;
    }

    case "start": {
      // data.outputs → inputVariables（正向 inputVariables → outputs 的逆向）
      converted.inputVariables = outputs.map((o) => ({
        name: String(o.name ?? "input"),
        type: String(o.type ?? "string"),
        required: o.required ?? true,
        ...(o.defaultValue !== undefined ? { default: o.defaultValue } : {}),
      }));
      break;
    }

    case "end": {
      // data.inputs.inputParameters（ref）→ outputVariables
      const inputParameters = (inputs.inputParameters ?? []) as PlatformParam[];
      converted.outputVariables = inputParameters.map((p) => ({
        name: String(p.name ?? "output"),
        type: String(p.input?.type ?? "string"),
        value: valueToRefExpr(p.input?.value, "output"),
      }));
      break;
    }
  }

  const node: Record<string, unknown> = {
    ...base,
    type: typeName,
    ...converted,
  };

  // 无法还原的节点级字段 → _temp.externalData.platformRaw（原样保留防丢）
  if (Object.keys(platformRaw).length > 0) {
    node._temp = { externalData: { platformRaw } };
  }

  return node as unknown as CozeNode;
}

// ============================================
// 小工具函数
// ============================================

/**
 * inputParameters → inputMapping（"blockID.name" 字符串形式）
 *
 * ref 项还原为 "blockID.name"；literal 项还原为字符串值。
 */
function paramsToMapping(params: PlatformParam[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const p of params) {
    const name = String(p.name ?? "");
    if (!name) continue;
    mapping[name] = valueToRefExpr(p.input?.value, "output");
  }
  return mapping;
}

/**
 * 平台输入 value（ref/literal）→ 项目字符串形式
 *
 * ref → "blockID.name"（blockID 缺省时返回空字符串）；
 * literal → String(content)。
 */
function valueToRefExpr(value: unknown, fallbackOutputName: string): string {
  const v = value as
    | { type?: string; content?: { blockID?: string; name?: string } }
    | undefined;
  if (v && v.type === "ref" && v.content && v.content.blockID) {
    return `${v.content.blockID}.${v.content.name ?? fallbackOutputName}`;
  }
  if (v && v.type === "literal") {
    return String(v.content ?? "");
  }
  return "";
}

/**
 * 平台输出声明 → 项目 outputs 元素（schema 原样透传）
 */
function outputToProject(o: PlatformOutput): Record<string, unknown> {
  return {
    type: o.type ?? "string",
    name: o.name ?? "output",
    ...(o.schema !== undefined ? { schema: o.schema } : {}),
    ...(o.required !== undefined ? { required: o.required } : {}),
  };
}

/**
 * 平台条件分支 → 项目可读条件表达式
 *
 * operator 11 = 布尔为真（样本实测），left ref → "blockID.name == true"；
 * 无法还原的 operator/结构 → 简化描述 + warning（原始结构进透传区）。
 */
function renderBranchCondition(
  branch: PlatformBranch,
  title: string,
  warnings: string[],
  index: number,
): string {
  const first = (branch.condition?.conditions ?? [])[0];
  const operator = first?.operator;
  const value = first?.left?.input?.value as
    | { type?: string; content?: { blockID?: string; name?: string } }
    | undefined;

  if (value?.type === "ref" && value.content?.blockID) {
    const ref = `${value.content.blockID}.${value.content.name ?? "output"}`;
    return operator === 11
      ? `${ref} == true`
      : `${ref}（operator=${String(operator)}）`;
  }
  if (value?.type === "literal") {
    const content = String(value.content ?? "");
    return operator === 11 ? `${content} == true` : content;
  }

  warnings.push(
    `节点「${title}」分支 ${index + 1} 的条件结构无法还原（operator=${String(operator)}），已保留原始结构到透传区`,
  );
  return `条件（operator=${String(operator)}）`;
}

// ============================================
// start/end 合成
// ============================================

/** 项目格式约定：start/end 的固定 id（与 schema-converter 正向 100001/900001 对应） */
const START_NODE_ID = "100001";
const END_NODE_ID = "900001";

/**
 * 确保工作流包含唯一 start / end 节点
 *
 * 平台剪贴板导出 / 部分 schema 中 start/end 是隐式的（不在 nodes 列表），
 * 但项目格式（validateWorkflow / checkPlatformCompatibility）强校验 start/end 唯一。
 * 缺失时自动合成：
 * - start：入度为 0 的业务节点连到它（无输入边 = 入口）
 * - end：出度为 0 的业务节点连到它（无输出边 = 出口）
 *
 * @returns 补全后的节点列表与边列表（原数组不修改）
 */
function ensureStartEnd(
  nodes: CozeNode[],
  edges: CozeEdge[],
): { nodes: CozeNode[]; edges: CozeEdge[] } {
  const hasStart = nodes.some((n) => n.type === "start");
  const hasEnd = nodes.some((n) => n.type === "end");
  if (hasStart && hasEnd) return { nodes, edges };

  const nodeIds = new Set(nodes.map((n) => n.id));
  // 入度/出度：只统计指向真实存在节点的边
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  for (const n of nodes) {
    inDegree.set(n.id, 0);
    outDegree.set(n.id, 0);
  }
  for (const e of edges) {
    if (!nodeIds.has(e.sourceNodeId) || !nodeIds.has(e.targetNodeId)) continue;
    if (e.sourceNodeId === e.targetNodeId) continue;
    outDegree.set(e.sourceNodeId, (outDegree.get(e.sourceNodeId) ?? 0) + 1);
    inDegree.set(e.targetNodeId, (inDegree.get(e.targetNodeId) ?? 0) + 1);
  }

  const resultNodes = [...nodes];
  const resultEdges = [...edges];
  let edgeSeq = edges.length;

  if (!hasStart) {
    resultNodes.push({
      id: START_NODE_ID,
      type: "start",
      title: "开始",
      inputVariables: [],
    } as unknown as CozeNode);
    // 入度为 0 的业务节点 → start 出边
    for (const n of nodes) {
      if ((inDegree.get(n.id) ?? 0) === 0) {
        resultEdges.push({
          id: `e${edgeSeq++}`,
          sourceNodeId: START_NODE_ID,
          targetNodeId: n.id,
        });
      }
    }
  }

  if (!hasEnd) {
    resultNodes.push({
      id: END_NODE_ID,
      type: "end",
      title: "结束",
      outputVariables: [],
    } as unknown as CozeNode);
    // 出度为 0 的业务节点 → end 入边
    for (const n of nodes) {
      if ((outDegree.get(n.id) ?? 0) === 0) {
        resultEdges.push({
          id: `e${edgeSeq++}`,
          sourceNodeId: n.id,
          targetNodeId: END_NODE_ID,
        });
      }
    }
  }

  return { nodes: resultNodes, edges: resultEdges };
}
