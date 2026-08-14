/**
 * Agent 层类型定义 —— LLM 结构化输出 Schema
 *
 * 职责：
 * - 用 zod 定义 LLMPlanOutputSchema，供 DeepSeekClient.chatStructured() 使用
 * - 每个字段都有 .describe()，确保 LLM 理解字段语义
 *
 * 关键细节：
 * - needBranch/needCodeNode/needDatabaseNode 是布尔值，LLM 按需求语义判断
 * - constraints/riskHints 是字符串数组，接受空数组
 * - withStructuredOutput 会自动将 schema 翻译为格式指令，无需手写 JSON 容错
 */
import { z } from "zod";

/** LLM 规划输出 Schema */
export const LLMPlanOutputSchema = z.object({
  needClarification: z
    .boolean()
    .optional()
    .describe(
      "当用户输入/输出结构不明确时为 true，此时应返回 clarificationQuestions 而非完整规划",
    ),
  clarificationQuestions: z
    .array(
      z.object({
        field: z
          .string()
          .describe(
            "需要澄清的字段（如 input_type / output_type / input_fields）",
          ),
        question: z.string().describe("向用户提出的具体问题"),
        hint: z.string().optional().describe("可选的提示信息"),
      }),
    )
    .optional()
    .describe(
      "需要向用户澄清的问题列表（1-3 个），仅 needClarification=true 时填写",
    ),
  mode: z.string().describe("工作流模式，如 '问答'、'数据处理'、'多轮对话' 等"),
  name: z
    .string()
    .describe(
      "工作流英文名称：只允许字母、数字、下划线，以字母开头，长度 ≤ 50，根据需求语义生成简洁英文名（如识别歌曲 → song_recognition）",
    ),
  goal: z.string().describe("一句话描述工作流目标"),
  inputType: z
    .string()
    .describe("用户输入的类型描述，如 '自然语言问题'、'JSON 数据' 等"),
  outputType: z
    .string()
    .describe("工作流输出的类型描述，如 '自然语言回答'、'结构化数据' 等"),
  needBranch: z.boolean().describe("是否需要条件分支节点来处理不同情况"),
  needCodeNode: z.boolean().describe("是否需要代码节点来执行数据处理逻辑"),
  needDatabaseNode: z
    .boolean()
    .describe(
      "是否需要数据库查询节点。只有用户明确提供数据库信息、且该数据源存在于平台数据库列表时才为 true",
    ),
  /** 工作流入口参数（start 节点的输出），默认 user_input */
  startInputs: z
    .array(
      z.object({
        name: z
          .string()
          .describe("输入参数名，如 audio_url、user_input、threshold"),
        type: z
          .enum(["string", "object", "list", "integer", "number", "boolean"])
          .describe("输入参数类型"),
        default: z
          .string()
          .optional()
          .describe(
            "可选参数的默认值（如 personal_requirement 默认 '无'），必填参数不传",
          ),
      }),
    )
    .optional()
    .describe(
      "工作流入口参数列表（用户输入什么）。多输入时列出全部，如 [{name:audio_url,type:string}]；默认单输入 user_input",
    ),
  constraints: z.array(z.string()).describe("工作流需满足的约束条件列表"),
  riskHints: z.array(z.string()).describe("潜在风险和注意事项列表"),
  /**
   * 节点步骤：按执行顺序排列（不含 start/end，系统自动添加）
   *
   * 这是执行顺序的唯一权威来源！planner 直接照抄，不再猜测。
   * dependencies 用 steps 数组的 index（从 0 开始），-1 表示依赖用户输入（start）。
   */
  steps: z
    .array(
      z.object({
        nodeType: z
          .enum([
            "llm",
            "code",
            "condition",
            "database_query",
            "http",
            "text",
            "merge",
          ])
          .describe(
            "节点类型：llm=大模型 code=代码 condition=条件分支 database_query=查询数据 http=HTTP请求 text=文本处理 merge=变量聚合",
          ),
        description: z
          .string()
          .describe("该节点要完成的任务描述（一句话，具体到做什么）"),
        dependencies: z
          .array(z.number())
          .describe(
            "依赖的上游步骤 index（steps 数组的下标，从 0 开始）。-1 表示依赖用户输入（start）。例如第 2 步依赖第 1 步输出，写 [0]",
          ),
      }),
    )
    .optional()
    .describe(
      "按执行顺序排列的节点步骤列表（不含开始/结束节点，系统自动加）。顺序即真实执行顺序，LLM 必须保证依赖正确、无循环",
    ),
  /** 数据契约：与 steps 一一对应（按 index 匹配），每个非 start/end 节点的输入输出定义 */
  contracts: z
    .array(
      z.object({
        inputs: z
          .array(
            z.object({
              name: z.string().describe("输入变量名，如 user_input、audio_url"),
              source: z
                .string()
                .describe("来源说明：如'用户输入'、'LLM 输出'、'代码输出'"),
            }),
          )
          .optional()
          .describe("该节点接收的输入参数列表"),
        outputs: z
          .array(
            z.object({
              name: z.string().describe("输出变量名，如 result、matched"),
              type: z
                .enum([
                  "string",
                  "object",
                  "list",
                  "integer",
                  "number",
                  "boolean",
                ])
                .describe("输出变量类型"),
            }),
          )
          .optional()
          .describe("该节点输出的字段列表"),
        batchMode: z
          .enum(["single", "batch"])
          .optional()
          .describe("单处理还是批处理"),
      }),
    )
    .optional()
    .describe(
      "各节点的数据契约列表，顺序必须与 steps 数组一一对应（steps[0]↔contracts[0]，steps[1]↔contracts[1]，...）",
    ),
  nodeConfig: z
    .object({
      llm: z
        .object({
          model: z
            .string()
            .describe(
              "LLM 节点模型名，必须从平台可用模型列表选择（音频/视频任务必须选 audio_understanding=true 的模型），禁止 gpt-4o 等平台不存在的模型",
            ),
          userPrompt: z
            .string()
            .describe("完整的业务提示词，描述 LLM 要完成的任务"),
          systemPrompt: z
            .string()
            .optional()
            .describe("系统提示词（角色定位/输出格式），可选"),
        })
        .optional()
        .describe("LLM 节点业务配置"),
      code: z
        .object({
          logicDescription: z
            .string()
            .describe(
              "代码节点要实现的业务逻辑描述，要具体（可包含阈值、数据常量、处理步骤）",
            ),
          inputs: z
            .array(z.string())
            .optional()
            .describe("代码节点需要的输入变量名列表"),
        })
        .optional()
        .describe("代码节点业务配置"),
      condition: z
        .object({
          branches: z
            .array(
              z.object({
                label: z.string().describe("分支名称，如 '匹配成功'"),
                condition: z
                  .string()
                  .describe("分支条件描述，如 'similarity >= 0.6'"),
              }),
            )
            .describe("真实的分支条件列表"),
        })
        .optional()
        .describe("条件节点业务配置"),
      database: z
        .object({
          connectionId: z
            .string()
            .describe(
              "数据库 res_id，必须来自平台数据库列表（如 7647092935296548864）",
            ),
          queryDescription: z
            .string()
            .describe("查询内容描述，如 '按 set_id 查询食谱数据'"),
        })
        .optional()
        .describe("数据库节点业务配置"),
      http: z
        .object({
          method: z.string().describe("HTTP 方法，如 GET / POST"),
          url: z.string().describe("请求 URL"),
          description: z.string().describe("接口用途描述"),
        })
        .optional()
        .describe("HTTP 节点业务配置"),
      text: z
        .object({
          concatResult: z
            .string()
            .describe(
              "文本节点拼接模板，如 '姓名：{{name}}，年龄：{{age}}'；用 {{变量名}} 引用上游输入",
            ),
        })
        .optional()
        .describe("文本节点业务配置"),
    })
    .optional()
    .describe("各类型节点的业务配置（按实际需要的节点填写对应字段）"),
});

/** LLM 规划输出类型（从 Schema 推导） */
export type LLMPlanOutput = z.infer<typeof LLMPlanOutputSchema>;

/**
 * Stage 1 骨架 Schema（分步生成第 1 步输出）
 *
 * 与 LLMPlanOutputSchema 的区别：
 * - contracts 内嵌在 steps 里（保证跨节点变量名全局一致，LLM 看着全局对齐）
 * - 不含 nodeConfig（业务配置由 Stage 2 逐节点生成）
 *
 * 输出约 1-2K token，思考+JSON 远低于 max_tokens 预算，从架构上消除截断。
 */
export const PlanSkeletonSchema = z
  .object({
    needClarification: z
      .boolean()
      .optional()
      .describe(
        "当用户输入/输出结构不明确时为 true，此时应返回 clarificationQuestions 而非完整规划",
      ),
    clarificationQuestions: z
      .array(
        z.union([
          z.object({
            field: z
              .string()
              .describe(
                "需要澄清的字段（如 input_type / output_type / input_fields）",
              ),
            question: z.string().describe("向用户提出的具体问题"),
            hint: z.string().optional().describe("可选的提示信息"),
          }),
          // 兼容：实测模型有时把澄清问题直接输出为字符串数组，
          // 这里放行字符串，planner 映射时统一转为 { field: "", question }
          z.string().describe("澄清问题原文（模型未按对象结构输出时）"),
        ]),
      )
      .optional()
      .describe(
        "需要向用户澄清的问题列表（1-3 个），仅 needClarification=true 时填写。每个问题是对象 {field, question}",
      ),
    // 核心字段先放宽为 optional，再由下方 superRefine 做条件必需：
    // 实测 prompt 允许澄清路径只输出 needClarification + clarificationQuestions，
    // 若这些字段设为必需，模型走澄清路径时 zod 校验必失败
    mode: z
      .string()
      .optional()
      .describe("工作流模式，如 '问答'、'数据处理'、'多轮对话' 等"),
    name: z
      .string()
      .optional()
      .describe(
        "工作流英文名称：只允许字母、数字、下划线，以字母开头，长度 ≤ 50，根据需求语义生成简洁英文名（如识别歌曲 → song_recognition）",
      ),
    goal: z.string().optional().describe("一句话描述工作流目标"),
    inputType: z
      .string()
      .optional()
      .describe("用户输入的类型描述，如 '自然语言问题'、'JSON 数据' 等"),
    outputType: z
      .string()
      .optional()
      .describe("工作流输出的类型描述，如 '自然语言回答'、'结构化数据' 等"),
    needBranch: z
      .boolean()
      .optional()
      .describe("是否需要条件分支节点来处理不同情况"),
    needCodeNode: z
      .boolean()
      .optional()
      .describe("是否需要代码节点来执行数据处理逻辑"),
    needDatabaseNode: z
      .boolean()
      .optional()
      .describe(
        "是否需要数据库查询节点。只有用户明确提供数据库信息、且该数据源存在于平台数据库列表时才为 true",
      ),
    startInputs: z
      .array(
        z.object({
          name: z
            .string()
            .describe("输入参数名，如 audio_url、user_input、threshold"),
          type: z
            .enum(["string", "object", "list", "integer", "number", "boolean"])
            .describe("输入参数类型"),
          default: z
            .string()
            .optional()
            .describe(
              "可选参数的默认值（如 personal_requirement 默认 '无'），必填参数不传",
            ),
        }),
      )
      .optional()
      .describe(
        "工作流入口参数列表（用户输入什么）。多输入时列出全部，如 [{name:audio_url,type:string}]；默认单输入 user_input",
      ),
    constraints: z
      .array(z.string())
      .optional()
      .describe("工作流需满足的约束条件列表"),
    riskHints: z
      .array(z.string())
      .optional()
      .describe("潜在风险和注意事项列表"),
    /**
     * 节点步骤：按执行顺序排列（不含 start/end，系统自动添加）
     *
     * 关键：contract 内嵌在每个 step 里（而非顶层 contracts 数组），
     * LLM 一次输出时看着全局对齐变量名，避免下游 inputs 不匹配上游 outputs。
     */
    steps: z
      .array(
        z.object({
          nodeType: z
            .enum([
              "llm",
              "code",
              "condition",
              "database_query",
              "http",
              "text",
              "merge",
            ])
            .describe(
              "节点类型：llm=大模型 code=代码 condition=条件分支 database_query=查询数据 http=HTTP请求 text=文本处理 merge=变量聚合",
            ),
          description: z
            .string()
            .describe("该节点要完成的任务描述（一句话，具体到做什么）"),
          dependencies: z
            .array(z.number())
            .describe(
              "依赖的上游步骤 index（steps 数组的下标，从 0 开始）。-1 表示依赖用户输入（start）。例如第 2 步依赖第 1 步输出，写 [0]",
            ),
          contract: z
            .object({
              inputs: z
                .array(
                  z.object({
                    name: z
                      .string()
                      .describe("输入变量名，如 user_input、audio_url"),
                    source: z
                      .string()
                      .describe(
                        "来源说明：如'用户输入'、'LLM 输出'、'代码输出'",
                      ),
                  }),
                )
                .optional()
                .describe(
                  "该节点接收的输入参数列表，变量名必须与上游节点 outputs.name 对齐",
                ),
              outputs: z
                .array(
                  z.object({
                    name: z.string().describe("输出变量名，如 result、matched"),
                    type: z
                      .enum([
                        "string",
                        "object",
                        "list",
                        "integer",
                        "number",
                        "boolean",
                      ])
                      .describe("输出变量类型"),
                  }),
                )
                .optional()
                .describe(
                  "该节点输出的字段列表，下游节点 inputs 引用时用这些名字",
                ),
              batchMode: z
                .enum(["single", "batch"])
                .optional()
                .describe("单处理还是批处理"),
            })
            .optional()
            .describe(
              "该节点的数据契约（输入输出定义）。inputs.name 必须与依赖的上游节点 outputs.name 一致",
            ),
        }),
      )
      .optional()
      .describe(
        "按执行顺序排列的节点步骤列表（不含开始/结束节点，系统自动加）。顺序即真实执行顺序，LLM 必须保证依赖正确、无循环。不要输出 nodeConfig",
      ),
  })
  .superRefine((value, ctx) => {
    // 澄清路径：只要求澄清问题，其余字段允许缺省
    if (value.needClarification === true) return;

    // 正常规划路径：核心字段必须齐全，否则 mapToWorkflowPlan 无法组装
    const required: Array<[string, unknown]> = [
      ["mode", value.mode],
      ["name", value.name],
      ["goal", value.goal],
      ["inputType", value.inputType],
      ["outputType", value.outputType],
      ["needBranch", value.needBranch],
      ["needCodeNode", value.needCodeNode],
      ["needDatabaseNode", value.needDatabaseNode],
      ["constraints", value.constraints],
      ["riskHints", value.riskHints],
    ];
    for (const [field, val] of required) {
      if (val === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `正常规划路径必须输出 ${field} 字段`,
        });
      }
    }
  });

/**
 * Stage 2 单节点业务配置 Schema（分步生成第 2 步输出）
 *
 * 字段全部可选：LLM 按当前节点类型只输出相关字段
 * （如 llm 节点输出 model/userPrompt，code 节点输出 logicDescription），
 * 无关字段直接不填，zod 校验兜底。
 */
export const NodeConfigSchema = z.object({
  // llm 节点配置
  model: z
    .string()
    .optional()
    .describe(
      "LLM 节点模型名，必须从平台可用模型列表选择（音频/视频任务必须选 audio_understanding=true 的模型），禁止平台不存在的模型",
    ),
  userPrompt: z.string().optional().describe("LLM 节点完整的业务提示词"),
  systemPrompt: z
    .string()
    .optional()
    .describe("LLM 节点系统提示词（角色定位/输出格式），可选"),
  // code 节点配置
  logicDescription: z
    .string()
    .optional()
    .describe(
      "代码节点要实现的业务逻辑描述，要具体（可包含阈值、数据常量、处理步骤）",
    ),
  inputs: z
    .array(
      z.union([
        z.string(),
        // 兼容：模型有时照搬 contract inputs 的对象结构 { name, source }
        z.object({
          name: z.string().describe("输入变量名"),
          source: z.string().optional().describe("来源说明"),
        }),
      ]),
    )
    .optional()
    .describe('代码节点需要的输入变量名列表（如 ["recognized_lyrics"]）'),
  // condition 节点配置
  branches: z
    .array(
      z.object({
        label: z.string().describe("分支名称，如 '匹配成功'"),
        condition: z.string().describe("分支条件描述，如 'similarity >= 0.6'"),
      }),
    )
    .optional()
    .describe("条件节点真实的分支条件列表"),
  // database_query 节点配置
  connectionId: z
    .string()
    .optional()
    .describe(
      "数据库 res_id，必须来自平台数据库列表（如 7647092935296548864）",
    ),
  queryDescription: z
    .string()
    .optional()
    .describe("查询内容描述，如 '按 set_id 查询食谱数据'"),
  // http 节点配置
  method: z.string().optional().describe("HTTP 方法，如 GET / POST"),
  url: z.string().optional().describe("请求 URL"),
  description: z.string().optional().describe("HTTP 接口用途描述"),
  // text 节点配置
  concatResult: z
    .string()
    .optional()
    .describe(
      "文本节点拼接模板，如 '姓名：{{name}}，年龄：{{age}}'；用 {{变量名}} 引用上游输入",
    ),
});

/** Stage 1 骨架输出类型（从 Schema 推导） */
export type PlanSkeleton = z.infer<typeof PlanSkeletonSchema>;

/** Stage 2 单节点配置输出类型（从 Schema 推导） */
export type NodeConfig = z.infer<typeof NodeConfigSchema>;
