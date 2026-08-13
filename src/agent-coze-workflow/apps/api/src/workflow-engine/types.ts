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
  constraints: z.array(z.string()).describe("工作流需满足的约束条件列表"),
  riskHints: z.array(z.string()).describe("潜在风险和注意事项列表"),
  /** 数据契约：每个非 start/end 节点的输入输出定义 */
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
      "各非 start/end 节点的数据契约列表（顺序：database_query→code→condition→llm），每个元素定义该节点的输入/输出/批处理模式",
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
    })
    .optional()
    .describe("各类型节点的业务配置（按实际需要的节点填写对应字段）"),
});

/** LLM 规划输出类型（从 Schema 推导） */
export type LLMPlanOutput = z.infer<typeof LLMPlanOutputSchema>;
