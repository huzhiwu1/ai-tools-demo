/**
 * Schema Converter - CozeWorkflow → 平台内部格式转换
 *
 * 职责：
 * 将项目公开的 CozeWorkflow 格式（meta/nodes/edges）转换为
 * Coze 私有平台 save 接口所需的内部 schema JSON 字符串。
 *
 * 关键细节：
 * - 节点类型映射：字符串 type → 数字 type（start=1, end=2, database_query=43）
 * - 节点 ID 重映射：start → 100001, end → 900001（平台固定约定）
 * - 边 ID 大写：sourceNodeId → sourceNodeID
 * - 顶层包裹 versions: { loop: "v2" }
 * - 输出为 JSON 字符串（save 的 schema 参数要求）
 *
 * TODO: llm/code/condition/http 的类型映射待实测确认，
 *       当前暂用占位数字，并在注释标注。
 */
import type { CozeWorkflow, CozeNode } from "@coze-workflow/workflow-schema";

// ============================================
// 类型映射
// ============================================

/**
 * 节点类型字符串 → 平台数字 ID 映射
 *
 * - start=1、end=2、database_query=43 已实测确认
 * - 其余类型待下一步实测（TODO），当前填占位值避免 save 报类型错误
 */
function mapNodeType(type: CozeNode["type"]): string {
  // 2026-08-12 实测（node_template_list）：3=大模型 5=代码 8=选择器 45=HTTP 43=查询数据
  const map: Record<string, string> = {
    start: "1",
    end: "2",
    llm: "3", // 大模型（实测）
    code: "5", // 代码（实测）
    condition: "8", // 选择器（实测）
    http: "45", // HTTP 请求（实测）
    database_query: "43", // 查询数据（实测）
  };
  return map[type] ?? "3"; // 未知类型降级为 llm
}

/** 节点类型 → Coze 平台主题色 */
function nodeColor(type: CozeNode["type"]): string {
  const colors: Record<string, string> = {
    start: "#52c41a",
    end: "#ff4d4f",
    llm: "#5C62FF",
    code: "#722ed1",
    condition: "#fa8c16",
    http: "#13c2c2",
    database_query: "#eb2f96",
  };
  return colors[type] ?? "#5C62FF";
}

/**
 * 构造平台字面量输入项（llmParam 等用）
 *
 * rawMeta.type：1=string 2=integer 3=boolean 4=float
 */
function literal(name: string, type: string, content: unknown) {
  const rawType =
    type === "boolean" ? 3 : type === "float" ? 4 : type === "integer" ? 2 : 1;
  return {
    name,
    input: {
      type,
      value: { type: "literal", content, rawMeta: { type: rawType } },
    },
  };
}

// ============================================
// 主转换函数
// ============================================

/**
 * 将 CozeWorkflow 转为平台内部 schema JSON 字符串
 *
 * @param workflow - 项目的 CozeWorkflow（含 nodes / edges）
 * @returns 平台 save 接口所需的 schema JSON 字符串
 */
export function convertToPlatformSchema(workflow: CozeWorkflow): string {
  // ID 重映射：平台约定 start=100001, end=900001
  const idMap = new Map<string, string>();
  for (const node of workflow.nodes) {
    if (node.type === "start") idMap.set(node.id, "100001");
    if (node.type === "end") idMap.set(node.id, "900001");
  }

  // 转换节点
  // 平台要求：start 必须带 outputs/trigger_parameters；end 必须带 inputs(terminatePlan + 引用上游)
  // 缺失会导致平台后端解析 panic（exit.go 空指针）
  const platformNodes = workflow.nodes.map((node, index) => {
    const isStart = node.type === "start";
    const isEnd = node.type === "end";

    // end 节点：引用上游最后一个节点（edges 中指向 end 的 source，或倒数第二个节点）
    // 注意：只有 end 节点需要算 upstream（start 的 fallback nodes[-1] 是 undefined）
    const upstreamNode = isEnd
      ? (workflow.nodes.find((n) =>
          workflow.edges.some(
            (e) => e.targetNodeId === node.id && e.sourceNodeId === n.id,
          ),
        ) ?? workflow.nodes[index - 1])
      : undefined;
    const upstreamId = upstreamNode
      ? (idMap.get(upstreamNode.id) ?? upstreamNode.id)
      : "100001";
    const upstreamOutput =
      upstreamNode?.type === "start"
        ? "input"
        : ((upstreamNode as
            | { outputs?: Array<{ name: string }> }
            | undefined)?.outputs?.[0]?.name ?? "output");

    const data: Record<string, unknown> = {
      nodeMeta: {
        title: node.title,
        icon: "",
        description: node.desc ?? "",
        mainColor: nodeColor(node.type),
        subTitle: "",
      },
    };

    if (isStart) {
      data.outputs = [{ type: "string", name: "input", required: false }];
      data.trigger_parameters = [];
    }
    if (isEnd) {
      data.inputs = {
        terminatePlan: "returnVariables",
        inputParameters: [
          {
            name: "output",
            input: {
              type: "string",
              value: {
                type: "ref",
                content: {
                  source: "block-output",
                  blockID: upstreamId,
                  name: upstreamOutput,
                },
              },
            },
          },
        ],
      };
    }
    if (node.type === "llm") {
      // 大模型节点（type 3）：llmParam 结构见 docs/coze-platform/coze-llm-node-sample.json
      const llm = node as { userPrompt?: string; systemPrompt?: string; config?: { temperature?: number; maxTokens?: number } };
      data.inputs = {
        inputParameters: [],
        llmParam: [
          literal("modelType", "integer", "201"),
          literal("modleName", "string", "Doubao-Seed-2.0-Lite"),
          literal("generationDiversity", "string", "balance"),
          literal("apiType", "integer", "1"),
          literal("temperature", "float", String(llm.config?.temperature ?? 1)),
          literal("maxTokens", "integer", String(llm.config?.maxTokens ?? 16384)),
          literal("topP", "float", "0.95"),
          literal("responseFormat", "integer", "2"),
          literal("supportThinking", "boolean", true),
          literal("enableThinking", "boolean", true),
          literal("prompt", "string", llm.userPrompt ?? ""),
          literal("enableChatHistory", "boolean", false),
          literal("chatHistoryRound", "integer", "3"),
          literal("systemPrompt", "string", llm.systemPrompt ?? ""),
        ],
        settingOnError: {
          processType: 1,
          timeoutMs: 600000,
          singleTimeoutMs: 120000,
          retryTimes: 0,
        },
      };
      data.outputs = [{ type: "string", name: "output" }];
      data.version = "3";
    }

    return {
      id: idMap.get(node.id) ?? node.id,
      type: mapNodeType(node.type),
      meta: { position: { x: 100 + index * 200, y: 100 } },
      data,
      _temp: {
        bounds: { x: 0, y: 0, width: 200, height: 80 },
        externalData: {},
      },
    };
  });

  // 转换边（ID 大写 + ID 重映射）
  const platformEdges = workflow.edges.map((edge) => ({
    sourceNodeID: idMap.get(edge.sourceNodeId) ?? edge.sourceNodeId,
    targetNodeID: idMap.get(edge.targetNodeId) ?? edge.targetNodeId,
  }));

  const platformSchema = {
    versions: { loop: "v2" },
    nodes: platformNodes,
    edges: platformEdges,
  };

  return JSON.stringify(platformSchema);
}
