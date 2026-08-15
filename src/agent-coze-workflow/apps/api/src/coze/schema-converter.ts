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
 * 模型名 → modelType 映射（由调用方动态传入，见 save.tool.ts）
 *
 * 不在 converter 内硬编码模型表：模型列表可能变更，
 * 应由 get_model_list 接口动态拉取（CozeClient.listModels）。
 * 查不到时默认 201（Doubao-Seed-2.0-Lite）。
 */
function modelTypeFor(modelName: string | undefined, map?: Record<string, number>): number {
  if (!modelName) return 201;
  if (map && map[modelName]) return map[modelName];
  return 201;
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
 * @param modelTypeMap - 模型名 → modelType 映射（动态拉取自 get_model_list，可省略）
 * @returns 平台 save 接口所需的 schema JSON 字符串
 */
export function convertToPlatformSchema(
  workflow: CozeWorkflow,
  modelTypeMap?: Record<string, number>,
): string {
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

      // end 节点：优先用 outputVariables 显式契约（generator 从 plan contract 生成），
      // 没有才 fallback 找上游（edges 指向 end 的 source，或倒数第二个节点）。
      // ⚠️ 修复（2026-08-16）：之前只靠"找上游边"，若代码节点未连到 end 会 fallback
      // 到倒数第二个节点（常是 LLM），表现为"结束节点 output 接了 LLM 的 output"。
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
        // 多输入支持：从 inputVariables 生成 outputs + trigger_parameters
        // （LLM 的 startInputs → planner → generator 的 createStartNode inputs）
        // 对照平台样本（2026-08-14 实测）：
        // - list 类型带 schema:{type:string}（元素类型）
        // - 支持 defaultValue（如 personal_requirement 默认 "无"）
        const vars = (node as unknown as {
          inputVariables?: Array<{
            name: string;
            type?: string;
            required?: boolean;
            default?: string;
          }>;
        })?.inputVariables;
        const startOutputs =
          vars && vars.length > 0
            ? vars.map((v) => {
                const type = v.type ?? "string";
                const entry: Record<string, unknown> = {
                  type,
                  name: v.name,
                  required: v.required ?? true,
                };
                // list 类型需要元素类型 schema（平台样本 examination_report 实测）
                if (type === "list") {
                  entry.schema = { type: "string" };
                }
                // 可选参数支持默认值（平台样本 personal_requirement 实测）
                if (v.default !== undefined) {
                  entry.defaultValue = v.default;
                }
                return entry;
              })
            : [{ type: "string", name: "input", required: false }];
        data.outputs = startOutputs;
        data.trigger_parameters = [];
      }
      if (isEnd) {
        // 优先用 outputVariables 里的显式 value 引用（"nodeId.outputName" 形式，
        // 由 generator 从 plan contract 生成）；没有才 fallback 到上游查找。
        // ⚠️ 2026-08-16：支持多输出——结束节点可声明多个返回变量
        // （如 condition 分支：成功输出结果、失败输出错误信息），
        // 每个 outputVariable 生成一个 inputParameter。
        const endVars = (node as unknown as {
          outputVariables?: Array<{
            name?: string;
            value?: string;
          }>;
        })?.outputVariables;
        const inputParameters =
          endVars && endVars.length > 0
            ? endVars.map((v) => {
                const refMatch = v.value
                  ? /^([^.{}]+)\.(.+)$/.exec(v.value)
                  : null;
                return {
                  name: v.name ?? "output",
                  input: {
                    type: "string",
                    value: {
                      type: "ref",
                      content: refMatch
                        ? {
                            source: "block-output",
                            blockID: platformId(refMatch[1]),
                            name: refMatch[2],
                          }
                        : {
                            source: "block-output",
                            blockID: upstreamId,
                            name: upstreamOutput,
                          },
                    },
                  },
                };
              })
            : [
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
              ];
        data.inputs = {
          terminatePlan: "returnVariables",
          inputParameters,
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
            literal(
              "modleName",
              "string",
              llm.config?.model ?? "Doubao-Seed-2.0-Lite",
            ),
            literal(
              "modelType",
              "integer",
              String(modelTypeFor(llm.config?.model, modelTypeMap)),
            ),
            literal("generationDiversity", "string", "balance"),
            literal("supportThinking", "boolean", true),
            literal("enableThinking", "boolean", true),
            literal("apiType", "integer", "1"),
            literal("prompt", "string", llm.userPrompt ?? ""),
            literal("enableChatHistory", "boolean", false),
            literal("chatHistoryRound", "integer", "3"),
            literal("systemPrompt", "string", llm.systemPrompt ?? ""),
          ],
          // settingOnError 结构对照平台样本 141264（2026-08-14 实测）：
          // switch + dataOnErr(json字符串) + processType 3=异常分支 + ext.backupLLmParam(json字符串)
          settingOnError: {
            switch: true,
            dataOnErr: JSON.stringify({
              output: "",
              reasoning_content: "",
            }),
            processType: 3,
            timeoutMs: 120000,
            singleTimeoutMs: 0,
            retryTimes: 1,
            ext: {
              backupLLmParam: JSON.stringify({
                temperature: 1,
                maxTokens: 16384,
                topP: 0.95,
                responseFormat: 2,
                modelName: "Doubao-Seed-2.0-Lite",
                modelType: 201,
                generationDiversity: "default_val",
              }),
            },
          },
        };
        // 业务输出（来自节点声明/contract，缺失默认 output）+ 平台内置字段
        // 内置字段（对照平台样本 + coze-studio 源码 llm.go）：
        // - reasoning_content: 思考内容（ReasoningOutputKey）
        // - errorBody: 异常时的保留输出（源码 SetOutputTypesForNodeSchema 跳过 readonly errorBody）
        // - isSuccess: 执行成功标记（readonly）
        const llmOutputs = (node as unknown as {
          outputs?: Array<{ type?: string; name?: string; schema?: unknown }>;
        })?.outputs;
        const businessOutputs =
          llmOutputs && llmOutputs.length > 0
            ? llmOutputs.map((o) => ({
                type: o.type ?? "string",
                name: o.name ?? "output",
              }))
            : [{ type: "string", name: "output" }];
        data.outputs = [
          ...businessOutputs,
          { type: "string", name: "reasoning_content" },
          {
            type: "object",
            name: "errorBody",
            schema: [
              { type: "string", name: "errorMessage", readonly: true },
              { type: "string", name: "errorCode", readonly: true },
            ],
            readonly: true,
          },
          { type: "boolean", name: "isSuccess", readonly: true },
        ];
        data.version = "3";
      }
      if (node.type === "code") {
        // 代码节点（type 5）：结构见 coze-node-fields-guide.md
        // language: 3=Python（平台约定），1=JavaScript
        // outputs 从节点声明读取，缺失用默认（防止平台 SetOutputTypesForNodeSchema panic）
        //
        // schema 字段格式（平台 dtoMetaToViewMeta 要求）：
        // - type="object" → schema 必须是数组（字段定义列表），空数组=无子字段
        // - type="list"   → schema 是类型对象如 {type:"string"} 或 {type:"object", schema:[]}
        // - 其他类型       → 不传 schema
        // 详见 docs/coze-platform/coze-node-fields-guide.md 对比分析
        const code = node as {
          code?: string;
          language?: "javascript" | "python";
          inputMapping?: Record<string, string>;
          outputs?: Array<{ type?: string; name?: string; schema?: unknown }>;
        };
        const normalizeSchema = (
          type: string,
          schema: unknown,
        ): unknown => {
          if (type === "object") {
            // 平台期望 schema 是数组；若为 null/undefined/非数组，降级为空数组
            return Array.isArray(schema) ? schema : [];
          }
          if (type === "list") {
            // 平台期望 schema 是类型对象，如 {type:"string"} 或 {type:"object", schema:[]}
            if (schema && typeof schema === "object" && !Array.isArray(schema))
              return schema;
            return { type: "string" };
          }
          // 基础类型（string/boolean/integer/float）不传 schema
          return undefined;
        };
        const codeOutputs =
          code.outputs && code.outputs.length > 0
            ? code.outputs.map((o) => {
                const type = o.type ?? "object";
                const schema = normalizeSchema(type, o.schema);
                const entry: Record<string, unknown> = {
                  type,
                  name: o.name ?? "output",
                };
                if (schema !== undefined) entry.schema = schema;
                return entry;
              })
            : [{ type: "object", name: "output", schema: [] }];
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
        //
        // 关键：left 引用必须指向上游节点的输出（不是写死的 start 100001）！
        // 上游 = edges 中指向本 condition 节点的 source 节点。
        const condition = node as {
          branches?: Array<{ expression?: string }>;
        };

        // 找上游节点：edges 里 targetNodeId === 本节点 的 source
        const upstreamEdge = workflow.edges.find(
          (e) => e.targetNodeId === node.id,
        );
        const upstreamNode = upstreamEdge
          ? workflow.nodes.find((n) => n.id === upstreamEdge.sourceNodeId)
          : undefined;
        // 上游输出名：取第一个 outputs 声明的 name（start 为 "input"）
        const upstreamOutputName =
          upstreamNode?.type === "start"
            ? "input"
            : (upstreamNode as unknown as {
                outputs?: Array<{ name?: string }>;
              })?.outputs?.[0]?.name ?? "output";
        const upstreamPlatformId = upstreamNode
          ? (idMap.get(upstreamNode.id) ?? upstreamNode.id)
          : "100001";

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
                          blockID: upstreamPlatformId,
                          name: upstreamOutputName,
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
        // 平台 concat 模式完整参数（样本 1287269 + 2026-08-14 实测）必须齐全：
        // concatResult（拼接结果模板）+ arrayItemConcatChar（数组项分隔符）
        // + allArrayItemConcatChars（可选分隔符列表，list 类型带 schema）
        // 节点上的 concatParams 只提供 concatResult 模板，后两项用平台默认值补齐，
        // 缺失会导致平台保存后拼接行为异常
        const templateParam = concatParams.find(
          (p) => p.name === "concatResult",
        );
        const fullConcatParams = [
          {
            name: "concatResult",
            input: {
              type: "string",
              value: {
                type: "literal",
                content: templateParam?.value ?? inferredConcat,
                rawMeta: { type: 1 },
              },
            },
          },
          {
            name: "arrayItemConcatChar",
            input: {
              type: "string",
              value: {
                type: "literal",
                content: "",
                rawMeta: { type: 1 },
              },
            },
          },
          {
            name: "allArrayItemConcatChars",
            input: {
              type: "list",
              schema: {
                type: "object",
                schema: [
                  { type: "string", name: "label", required: true },
                  { type: "string", name: "value", required: true },
                  { type: "boolean", name: "isDefault", required: true },
                ],
              },
              value: {
                type: "literal",
                content: [
                  { label: "换行", value: "\n", isDefault: true },
                  { label: "制表符", value: "\t", isDefault: true },
                  { label: "句号", value: "。", isDefault: true },
                  { label: "逗号", value: "，", isDefault: true },
                  { label: "分号", value: "；", isDefault: true },
                  { label: "空格", value: " ", isDefault: true },
                ],
              },
            },
          },
        ];
        data.inputs = {
          method: text.method ?? "concat",
          inputParameters,
          concatParams: fullConcatParams,
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

        // 从 inputMapping 生成 inputParameters（允许数据库查询引用上游变量做条件参数）
        const inputParameters = Object.entries(db.inputMapping ?? {}).map(
          ([name, refExpr]) => {
            const match = /^([^.{}]+)\.(.+)$/.exec(refExpr);
            if (match) {
              return refInput(name, platformId(match[1]), match[2]);
            }
            return literal(name, "string", refExpr);
          },
        );

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
          ...(inputParameters.length > 0 ? { inputParameters } : {}),
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
        // HTTP 请求节点（type 45）：结构对照平台样本 161311（2026-08-14 实测）
        // apiInfo/body/headers/params/auth/setting + 标准 outputs body/statusCode/headers
        //
        // 变量引用：URL 中用 {{变量名}} 引用上游输出（如 {{city}}），
        // 同时通过 inputParameters 映射变量的实际来源
        const http = node as {
          method?: string;
          url?: string;
          headers?: Record<string, string>;
          body?: Record<string, unknown>;
          inputMapping?: Record<string, string>;
        };

        // 从 inputMapping 生成 inputParameters（允许 HTTP 节点引用上游变量）
        const inputParameters = Object.entries(http.inputMapping ?? {}).map(
          ([name, refExpr]) => {
            const match = /^([^.{}]+)\.(.+)$/.exec(refExpr);
            if (match) {
              return refInput(name, platformId(match[1]), match[2]);
            }
            return literal(name, "string", refExpr);
          },
        );

        // 将 URL 中的变量引用转换为平台完整引用格式 {{block_output_<blockID>.<outputName>}}
        // 实测（2026-08-14）：平台不认 {{city}} 简写，必须带来源节点完整路径
        // 例如：{city} / {{city}} → {{block_output_100001.city}}
        // 仅转换匹配 inputMapping 中变量名的引用，避免误伤 URL 中的 JSON 语法
        let url = http.url ?? "";
        for (const [name, refExpr] of Object.entries(http.inputMapping ?? {})) {
          const match = /^([^.{}]+)\.(.+)$/.exec(refExpr);
          if (!match) continue;
          const blockID = platformId(match[1]);
          const outputName = match[2];
          const fullRef = `{{block_output_${blockID}.${outputName}}}`;
          // 先替换双花括号 {{name}}，再替换单花括号 {name}（避免 {{name}} 中的 {name} 被提前替换）
          url = url.replaceAll(`{{${name}}}`, fullRef);
          url = url.replaceAll(`{${name}}`, fullRef);
        }

        data.inputs = {
          apiInfo: {
            method: http.method ?? "GET",
            url,
          },
          body: {
            bodyType: "EMPTY", // 平台默认大写 EMPTY
            bodyData: {
              binary: {
                fileURL: {
                  type: "string",
                  value: {
                    type: "ref",
                    content: {
                      source: "block-output",
                      blockID: "",
                      name: "",
                    },
                  },
                },
              },
            },
          },
          headers: [],
          params: [],
          auth: {
            authType: "BEARER_AUTH",
            authData: {
              customData: {
                addTo: "header",
              },
            },
            authOpen: false,
          },
          setting: {
            timeout: 120, // 秒
            retryTimes: 3,
          },
          // inputParameters 让平台知道 URL 中的 {{city}} 来自 start 节点的哪个输出
          ...(inputParameters.length > 0 ? { inputParameters } : {}),
        };
        // 标准输出：body / statusCode / headers（平台样本实测，不是 response）
        data.outputs = [
          { type: "string", name: "body" },
          { type: "integer", name: "statusCode" },
          { type: "string", name: "headers" },
        ];
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
