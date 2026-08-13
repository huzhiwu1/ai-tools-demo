/**
 * Schema Converter - CozeWorkflow → 平台内部格式转换
 *
 * 职责：
 * 将项目公开的 CozeWorkflow 格式（meta/nodes/edges）转换为
 * Coze 私有平台 save 接口所需的内部 schema JSON 字符串。
 *
 * 关键细节：
 * - 节点类型映射：字符串 type → 数字 type（start=1, end=2, llm=3, code=5,
 *   condition=8 选择器, text=15, merge=32, database_query=43, http=45）
 * - 节点 ID 重映射：start → 100001, end → 900001（平台固定约定）
 * - 边 ID 大写：sourceNodeId → sourceNodeID，sourcePort → sourcePortID
 * - 数据流靠 data.inputs 里 {type:"ref", content:{source:"block-output", blockID, name}}
 *   引用（edges 只是展示）
 * - 顶层包裹 versions: { loop: "v2" }
 * - 输出为 JSON 字符串（save 的 schema 参数要求）
 *
 * 节点 data 结构依据 docs/coze-platform/coze-node-fields-guide.md
 * （health-workflow-103-nosnack-sample.json 21 节点实测样本）；
 * 数据库连接 res_id、模型列表等平台事实依据 docs/coze-platform/platform-facts.md。
 */
import type { CozeWorkflow, CozeNode } from "@coze-workflow/workflow-schema";

// ============================================
// 类型映射
// ============================================

/**
 * 节点类型字符串 → 平台数字 ID 映射
 *
 * 2026-08-12 实测（node_template_list + 工作流样本）：
 * 1=start 2=end 3=大模型 5=代码 8=选择器 15=文本处理 32=变量聚合
 * 43=查询数据 45=HTTP 21=循环 28=批处理 1300=人工任务
 */
function mapNodeType(type: CozeNode["type"]): string {
  const map: Record<string, string> = {
    start: "1",
    end: "2",
    llm: "3", // 大模型（实测）
    code: "5", // 代码（实测）
    condition: "8", // 选择器（实测）
    text: "15", // 文本处理（实测）
    merge: "32", // 变量聚合（实测）
    database_query: "43", // 查询数据（实测）
    http: "45", // HTTP 请求（实测）
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
    text: "#13c2c2",
    merge: "#2f54eb",
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

/**
 * 构造平台 ref 引用项（数据流核心）
 *
 * @param name - 输入项名称
 * @param blockID - 上游节点 ID（平台格式）
 * @param outputName - 上游节点输出字段名
 * @param rawType - rawMeta.type（默认 1=string）
 */
function refInput(
  name: string,
  blockID: string,
  outputName: string,
  rawType = 1,
) {
  return {
    name,
    input: {
      type: rawType === 6 ? "object" : rawType === 2 ? "integer" : "string",
      value: {
        type: "ref",
        content: { source: "block-output", blockID, name: outputName },
        rawMeta: { type: rawType },
      },
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

  const platformId = (id: string) => idMap.get(id) ?? id;

  // 数据库节点缺少连接 ID（res_id）时会被跳过，记录其原始 ID 供 edges 过滤
  const skippedNodeIds = new Set(
    workflow.nodes
      .filter(
        (n) =>
          n.type === "database_query" &&
          !(n as { connection?: string }).connection,
      )
      .map((n) => n.id),
  );

  // 转换节点
  const platformNodes = workflow.nodes
    .map((node, index) => {
      const isStart = node.type === "start";
      const isEnd = node.type === "end";

      // end 节点：引用上游最后一个节点（edges 中指向 end 的 source，或倒数第二个节点）
      // 上游节点若属于被跳过的数据库节点，回退为 start（100001）
      const fallbackUpstream = workflow.nodes[index - 1];
      const upstreamNode = isEnd
        ? (workflow.nodes.find(
            (n) =>
              !skippedNodeIds.has(n.id) &&
              workflow.edges.some(
                (e) => e.targetNodeId === node.id && e.sourceNodeId === n.id,
              ),
          ) ??
          (fallbackUpstream && !skippedNodeIds.has(fallbackUpstream.id)
            ? fallbackUpstream
            : undefined))
        : undefined;
      const upstreamId = upstreamNode
        ? (idMap.get(upstreamNode.id) ?? upstreamNode.id)
        : "100001";
      const upstreamOutput =
        upstreamNode?.type === "start"
          ? "input"
          : ((upstreamNode as { outputs?: Array<{ name: string }> } | undefined)
              ?.outputs?.[0]?.name ?? "output");

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
        const llm = node as {
          userPrompt?: string;
          systemPrompt?: string;
          config?: {
            temperature?: number;
            maxTokens?: number;
            model?: string;
          };
          inputMapping?: Record<string, string>;
        };
        const inputParameters = Object.entries(llm.inputMapping ?? {}).map(
          ([name, refExpr]) => {
            // refExpr 形如 "nodeId.outputName" 或 "{{var}}"
            const match = /^([^.{}]+)\.(.+)$/.exec(refExpr);
            if (match) {
              return refInput(name, platformId(match[1]), match[2]);
            }
            return literal(name, "string", refExpr);
          },
        );
        data.inputs = {
          inputParameters,
          llmParam: [
            literal("modelType", "integer", "201"),
            literal(
              "modleName",
              "string",
              llm.config?.model ?? "Doubao-Seed-2.0-Lite",
            ),
            literal("generationDiversity", "string", "balance"),
            literal("apiType", "integer", "1"),
            literal(
              "temperature",
              "float",
              String(llm.config?.temperature ?? 1),
            ),
            literal(
              "maxTokens",
              "integer",
              String(llm.config?.maxTokens ?? 16384),
            ),
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
      if (node.type === "code") {
        // 代码节点（type 5）：结构见 coze-node-fields-guide.md
        // language: 3=Python（平台约定），1=JavaScript
        // outputs 从节点声明读取，缺失用默认（防止平台 SetOutputTypesForNodeSchema panic）
        const code = node as {
          code?: string;
          language?: "javascript" | "python";
          inputMapping?: Record<string, string>;
          outputs?: Array<{ type?: string; name?: string; schema?: unknown }>;
        };
        const codeOutputs =
          code.outputs && code.outputs.length > 0
            ? code.outputs.map((o) => ({
                type: o.type ?? "object",
                name: o.name ?? "output",
                schema: o.schema ?? {},
              }))
            : [{ type: "object", name: "output", schema: {} }];
        const inputParameters = Object.entries(code.inputMapping ?? {}).map(
          ([name, refExpr]) => {
            const match = /^([^.{}]+)\.(.+)$/.exec(refExpr);
            if (match) {
              return refInput(name, platformId(match[1]), match[2]);
            }
            return literal(name, "string", refExpr);
          },
        );
        data.inputs = {
          inputParameters,
          code:
            code.code ??
            "async def main(args: Args) -> Output:\n    params = args.params\n    ret: Output = {}\n    return ret",
          language: code.language === "javascript" ? 1 : 3,
          settingOnError: {
            processType: 1,
            timeoutMs: 60000,
            retryTimes: 0,
          },
        };
        data.outputs = codeOutputs;
      }
      if (node.type === "condition") {
        // 选择器节点（type 8）：branches → 平台条件结构
        // 平台条件：logic 2=AND；operator 11=布尔为真
        const condition = node as {
          branches?: Array<{ expression?: string }>;
        };
        data.inputs = {
          branches: (condition.branches ?? []).map((branch) => ({
            condition: {
              logic: 2,
              conditions: [
                {
                  operator: 11,
                  left: {
                    input: {
                      type: "boolean",
                      value: {
                        type: "ref",
                        content: {
                          source: "block-output",
                          blockID: "100001",
                          name: "input",
                        },
                      },
                    },
                  },
                },
              ],
            },
          })),
        };
      }
      if (node.type === "text") {
        // 文本处理节点（type 15）：method=concat
        const text = node as {
          method?: "concat";
          concatParams?: Array<{ name: string; value: string }>;
          inputMapping?: Record<string, string>;
        };
        const inputParameters = Object.entries(text.inputMapping ?? {}).map(
          ([name, refExpr]) => {
            const match = /^([^.{}]+)\.(.+)$/.exec(refExpr);
            if (match) {
              return refInput(name, platformId(match[1]), match[2]);
            }
            return literal(name, "string", refExpr);
          },
        );
        // 若没有显式 concatParams，从 inputParameters 推断模板
        const concatParams = text.concatParams ?? [];
        const inferredConcat =
          inputParameters.length > 0
            ? inputParameters.map((p) => `{{${p.name}}}`).join("")
            : "{{String1}}";
        data.inputs = {
          method: text.method ?? "concat",
          inputParameters,
          concatParams:
            concatParams.length > 0
              ? concatParams.map((p) => ({
                  name: p.name,
                  input: {
                    type: "string",
                    value: {
                      type: "literal",
                      content: p.value,
                      rawMeta: { type: 1 },
                    },
                  },
                }))
              : [
                  {
                    name: "concatResult",
                    input: {
                      type: "string",
                      value: {
                        type: "literal",
                        content: inferredConcat,
                        rawMeta: { type: 1 },
                      },
                    },
                  },
                ],
        };
        data.outputs = [{ type: "string", name: "output", required: true }];
      }
      if (node.type === "merge") {
        // 变量聚合节点（type 32）：mergeGroups 分组聚合上游输出
        const merge = node as {
          mergeGroups?: Array<{ name: string; variables: string[] }>;
        };
        const mergeGroups = (
          merge.mergeGroups ?? [{ name: "Group1", variables: [] }]
        ).map((group) => ({
          name: group.name,
          variables: (group.variables ?? []).map((refExpr) => {
            const match = /^([^.{}]+)\.(.+)$/.exec(refExpr);
            if (match) {
              return {
                type: "string",
                value: {
                  type: "ref",
                  content: {
                    source: "block-output",
                    blockID: platformId(match[1]),
                    name: match[2],
                  },
                  rawMeta: { type: 1 },
                },
              };
            }
            return {
              type: "string",
              value: {
                type: "literal",
                content: refExpr,
                rawMeta: { type: 1 },
              },
            };
          }),
        }));
        data.inputs = { mergeGroups };
        data.outputs = mergeGroups.map((g) => ({
          type: "string",
          name: g.name,
        }));
      }
      if (node.type === "database_query") {
        // 查询数据节点（type 43）：databaseInfoList + selectParam
        const db = node as {
          connection?: string;
          query?: string;
          params?: Array<string | number>;
          inputMapping?: Record<string, string>;
        };
        // 无连接 ID（res_id）时跳过该节点：平台禁止空 databaseInfoID，
        // 空字符串会导致 save 报错（generator 层已跳过，此处是最后防线）
        if (!db.connection) {
          return null;
        }
        data.inputs = {
          databaseInfoList: [{ databaseInfoID: db.connection ?? "" }],
          selectParam: {
            condition: {
              conditionList: [[]],
              logic: "AND",
            },
            orderByList: [],
            limit: 100,
          },
          settingOnError: {
            processType: 1,
            timeoutMs: 60000,
            retryTimes: 0,
          },
        };
        data.outputs = [
          {
            type: "list",
            name: "outputList",
            schema: { type: "object", schema: [] },
          },
          { type: "integer", name: "rowNum" },
        ];
      }
      if (node.type === "http") {
        // HTTP 请求节点（type 45）：结构未实测，先按字段推断
        const http = node as {
          method?: string;
          url?: string;
          headers?: Record<string, string>;
          body?: Record<string, unknown>;
        };
        data.inputs = {
          method: http.method ?? "GET",
          url: http.url ?? "",
          headers: http.headers ?? {},
          body: http.body ?? {},
          settingOnError: {
            processType: 1,
            timeoutMs: 60000,
            retryTimes: 0,
          },
        };
        data.outputs = [{ type: "object", name: "response", schema: {} }];
      }

      return {
        id: platformId(node.id),
        type: mapNodeType(node.type),
        meta: { position: { x: 100 + index * 200, y: 100 } },
        data,
        _temp: {
          bounds: { x: 0, y: 0, width: 200, height: 80 },
          externalData: {},
        },
      };
    })
    .filter((n): n is NonNullable<typeof n> => n !== null);

  // 转换边（ID 大写 + ID 重映射 + 端口）；过滤指向被跳过节点的边
  const platformEdges = workflow.edges
    .filter(
      (edge) =>
        !skippedNodeIds.has(edge.sourceNodeId) &&
        !skippedNodeIds.has(edge.targetNodeId),
    )
    .map((edge) => {
      const e: Record<string, string> = {
        sourceNodeID: platformId(edge.sourceNodeId),
        targetNodeID: platformId(edge.targetNodeId),
      };
      if (edge.sourcePort) {
        e.sourcePortID = edge.sourcePort;
      }
      return e;
    });

  const platformSchema = {
    versions: { loop: "v2" },
    nodes: platformNodes,
    edges: platformEdges,
  };

  return JSON.stringify(platformSchema);
}
