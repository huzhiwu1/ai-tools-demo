/**
 * [Schema] UpdateOperation - 工作流修改操作指令 schema（op 化）
 *
 * 职责：
 * 定义 update_workflow 的 5 种结构化操作指令（op）的 zod schema。
 * LLM 直接输出符合 schema 的操作数组，代码按 op 确定性执行，
 * 替代旧 {type, target, content} + 正则猜句式的解析方式。
 *
 * 流程：
 * 1. 值类型分组：STRING_FIELDS / ARRAY_FIELDS / ANY_FIELDS（codex F2）
 * 2. set 的 value 用 superRefine 按 field 校验值类型（白名单防字段名 + 分组防值类型）
 * 3. set_ref 的 ref 用 regex 校验格式（codex I3，防 converter 静默 fallback）
 * 4. discriminatedUnion 按 op 分发，5 种 op 各自字段精确
 *
 * 关键细节：
 * - 一期只启用 set / set_ref / rewrite_code；delete_node / delete_edge 的
 *   schema 先定义（防 LLM 输出后静默忽略），applyOperation 里返回"二期未启用"
 * - start 节点输入字段名是 inputVariables（types/index.ts StartNode），
 *   方案文档里写 startInputs 是命名笔误，白名单以代码事实为准
 * - 每个字段必须 .describe()：DeepSeek jsonMode 不注入 schema，
 *   LLM 只能靠 prompt 里的字段描述理解输出结构
 * - zod 4.x：superRefine 的 issue code 用 z.ZodIssueCode.custom
 */

import { z } from "zod";

// ============================================
// 值类型分组（codex F2：白名单防字段名 + 分组防值类型）
// ============================================

/** 字符串值字段：value 必须是 string */
export const STRING_FIELDS = [
  "config.model",
  "userPrompt",
  "systemPrompt",
  "code",
  "language",
] as const;

/** 数组值字段：value 必须是 array */
export const ARRAY_FIELDS = [
  "branches",
  "outputs",
  "outputVariables",
  "inputVariables",
] as const;

/** 任意 JSON 值字段（如数据常量） */
export const ANY_FIELDS = ["data"] as const;

/** 完整白名单（codex B8：越窄越安全，按需迭代补充） */
export const FIELD_PATHS = [
  ...STRING_FIELDS,
  ...ARRAY_FIELDS,
  ...ANY_FIELDS,
] as const;

/** 合法字段路径类型 */
export type FieldPath = (typeof FIELD_PATHS)[number];

// ============================================
// 各 op schema
// ============================================

/**
 * set：改任意白名单内字段，value 直接赋值
 *
 * value 类型由 superRefine 按 field 校验（codex F2）：
 * STRING_FIELDS → string；ARRAY_FIELDS → array；ANY_FIELDS → 任意 JSON。
 * 不校验会怎样：config.model 传对象、branches 传字符串都能过 zod，
 * 运行时污染数据，schema-converter 崩溃或静默降级（modelTypeFor 兜底 201）。
 */
const setSchema = z
  .object({
    op: z.literal("set"),
    target: z
      .string()
      .describe("目标节点标识（title 或 id，尽量用 title 中文名）"),
    field: z
      .enum(FIELD_PATHS)
      .describe(
        "要修改的字段（白名单）：config.model=模型名 / userPrompt=用户提示词 / " +
          "systemPrompt=系统提示词 / code=代码节点代码（整段替换） / language=代码语言 / " +
          "branches=条件节点分支（元素形状 {expression, targetNodeId}） / " +
          "outputs=节点输出声明 / outputVariables=结束节点输出变量 / " +
          "inputVariables=开始节点输入声明 / data=数据常量",
      ),
    value: z.unknown().describe("新值（类型须与字段匹配）"),
  })
  .superRefine((data, ctx) => {
    const field = data.field as FieldPath;
    if ((STRING_FIELDS as readonly string[]).includes(field)) {
      if (typeof data.value !== "string") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `字段 ${field} 需要字符串值（如 config.model 填模型名文本）`,
        });
      }
    } else if ((ARRAY_FIELDS as readonly string[]).includes(field)) {
      if (!Array.isArray(data.value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `字段 ${field} 需要数组值（元素按字段语义：branches 为 {expression,targetNodeId} 等）`,
        });
      }
    }
    // ANY_FIELDS（data）：不校验，接受任意 JSON
  });

/**
 * set_ref：定向改结束节点某一个 outputVariable 的 value 引用
 *
 * codex I3 修复：
 * - outputName 必填，按 name 定位（多输出结束节点改错位置的教训）
 * - ref 格式 regex 校验：converter 用 /^([^.{}]+)\.(.+)$/ 解析 value，
 *   格式错会静默 fallback 到"上游边查找"，LLM 误判成功
 * - target 限定 end 节点（converter 只消费 end 的 outputVariables）
 */
const setRefSchema = z.object({
  op: z.literal("set_ref"),
  target: z.string().describe("结束节点标识（title 或 id）"),
  outputName: z
    .string()
    .describe("输出变量名（必填，按 name 定位，如 final / result）"),
  ref: z
    .string()
    .regex(
      /^[^.{}]+\.[^.{}]+$/,
      "ref 格式应为 nodeId.outputName（如 node_xxx.result）",
    )
    .describe("新的引用表达式（格式 nodeId.outputName，指向上游节点输出）"),
});

/**
 * rewrite_code：按业务逻辑描述重写代码节点（内部调 CodeGenerator）
 *
 * codex I2 优先级反转：
 * referenceData 的优先级由工具侧决定——节点已有 referenceData（服务端缓存
 * 真实数据）强制注入，LLM 传的仅作"用户新提供参考数据"语义，不能覆盖。
 * 类型对齐代码事实：CodeGenerator.generateCode 的 referenceData 是
 * Record<string, string>（code-generator.ts:94）。
 */
const rewriteCodeSchema = z.object({
  op: z.literal("rewrite_code"),
  target: z.string().describe("代码节点标识（title 或 id）"),
  logicDescription: z
    .string()
    .describe("新的业务逻辑描述（含阈值/数据常量/处理步骤，不要省略）"),
  referenceData: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "可选。用户新提供的参考数据（如歌词库）。工具侧优先注入节点已有参考数据，此字段仅作新增/补充",
    ),
});

/** delete_node：删节点（二期，本期 schema 先定义防 LLM 输出被静默忽略） */
const deleteNodeSchema = z.object({
  op: z.literal("delete_node"),
  target: z
    .string()
    .describe("要删除的节点标识（title 或 id）。禁止删除 start/end 节点"),
});

/** delete_edge：删边（二期，本期 schema 先定义防 LLM 输出被静默忽略） */
const deleteEdgeSchema = z.object({
  op: z.literal("delete_edge"),
  source: z.string().describe("边起点节点 id"),
  target: z.string().describe("边终点节点 id"),
});

// ============================================
// 联合 schema
// ============================================

/** 修改操作联合 schema：按 op 分发（5 种 op，一期启用前 3 个） */
export const UpdateOperationSchema = z.discriminatedUnion("op", [
  setSchema,
  setRefSchema,
  rewriteCodeSchema,
  deleteNodeSchema, // 二期
  deleteEdgeSchema, // 二期
]);

/** 操作数组 schema（LLM 一次可输出多条操作） */
export const UpdateOperationsSchema = z.array(UpdateOperationSchema);

/** 操作指令类型 */
export type UpdateOperation = z.infer<typeof UpdateOperationSchema>;
