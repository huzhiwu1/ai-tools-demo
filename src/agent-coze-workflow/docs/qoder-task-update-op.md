# Qoder 任务单：update_workflow 操作化重构（op 化 v0.2）

> 依据：docs/update-workflow-op-design.md（v0.2）+ docs/codex-review-update-op.md（codex 审查）
> 核心：把 update_workflow 从「type 枚举 + content 自然语言正则猜」重构为「5 种结构化 op 指令 + 确定性执行」。
> 分期：一期 set + set_ref + rewrite_code（修复型 op）；二期 delete_node + delete_edge（破坏型 op，本任务单只做一期，二期单独排）。

---

## 一、必读文件

- `docs/update-workflow-op-design.md`（v0.2 方案，权威）
- `docs/codex-review-update-op.md`（审查报告，F1/F2/I1-I6/S1-S4 编号引用）
- `apps/api/src/agent/tools/update-workflow.tool.ts`（现状：577 行，type 枚举 + applyOneInstruction + 宽容解析）
- `apps/api/src/workflow-engine/code-generator.ts`（CodeGenerator.generateCode，referenceData 是 `Record<string, string>`，:94）
- `apps/api/src/agent/tools/iteration-counter.ts`（peekIteration/incrementIteration/MAX_ITERATIONS）
- `apps/api/src/agent/workflow-cache.ts`（缓存：workflow/dirty/commitId）
- `apps/api/src/coze/schema-converter.ts`（branches 读 `expression` :485；end 节点 outputVariables :237-248）
- `apps/api/src/workflow-engine/generator.ts`（branches 输出 `{expression, targetNodeId}` :703-709）
- `packages/workflow-schema/src/validator/index.ts`（validateWorkflow，MISSING_SOURCE_NODE/MISSING_TARGET_NODE :130-141）

---

## 二、任务 1：新建 `apps/api/src/agent/operations/operations.schema.ts`

### 1.1 UpdateOperationSchema（discriminatedUnion 5 op，一期只启用 3 个，但 schema 全定义）

```ts
import { z } from "zod";

// 值类型分组（codex F2）
export const STRING_FIELDS = [
  "config.model", "userPrompt", "systemPrompt", "code", "language",
] as const;
export const ARRAY_FIELDS = [
  "branches", "outputs", "outputVariables", "startInputs",
] as const;
export const ANY_FIELDS = ["data"] as const;
export const FIELD_PATHS = [...STRING_FIELDS, ...ARRAY_FIELDS, ...ANY_FIELDS] as const;
export type FieldPath = (typeof FIELD_PATHS)[number];

// set 的 value：superRefine 按 field 校验值类型（codex F2）
const setSchema = z
  .object({
    op: z.literal("set"),
    target: z.string().describe("节点 title 或 id"),
    field: z.enum(FIELD_PATHS).describe("要修改的字段（白名单）"),
    value: z.unknown().describe("新值"),
  })
  .superRefine((data, ctx) => {
    const field = data.field as FieldPath;
    if ((STRING_FIELDS as readonly string[]).includes(field)) {
      if (typeof data.value !== "string") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `字段 ${field} 需要字符串值` });
      }
    } else if ((ARRAY_FIELDS as readonly string[]).includes(field)) {
      if (!Array.isArray(data.value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `字段 ${field} 需要数组值` });
      }
    }
  });

// set_ref：outputName 必填 + ref 格式校验 + 限定 end（codex I3）
const setRefSchema = z.object({
  op: z.literal("set_ref"),
  target: z.string().describe("结束节点 title 或 id"),
  outputName: z.string().describe("输出变量名（必填，按 name 定位）"),
  ref: z
    .string()
    .regex(/^[^.{}]+\.[^.{}]+$/, "ref 格式应为 nodeId.outputName（如 node_xxx.result）")
    .describe("新的引用表达式"),
});

// rewrite_code：referenceData 类型对齐 Record<string, string>（codex I2/审查#2）
const rewriteCodeSchema = z.object({
  op: z.literal("rewrite_code"),
  target: z.string().describe("代码节点 title 或 id"),
  logicDescription: z.string().describe("新的业务逻辑描述"),
  referenceData: z.record(z.string(), z.string()).optional()
    .describe("用户新提供的参考数据（工具侧优先注入节点已有数据，见任务 3）"),
});

// 二期 op（本期不启用，schema 先定义防将来破坏性改）
const deleteNodeSchema = z.object({
  op: z.literal("delete_node"),
  target: z.string().describe("要删除的节点 title 或 id（禁止 start/end）"),
});
const deleteEdgeSchema = z.object({
  op: z.literal("delete_edge"),
  source: z.string().describe("边起点节点 id"),
  target: z.string().describe("边终点节点 id"),
});

export const UpdateOperationSchema = z.discriminatedUnion("op", [
  setSchema,
  setRefSchema,
  rewriteCodeSchema,
  deleteNodeSchema, // 二期
  deleteEdgeSchema, // 二期
]);
export type UpdateOperation = z.infer<typeof UpdateOperationSchema>;
```

### 1.2 注意事项

- 二期 op（delete_node/delete_edge）**schema 定义了但 applyOperation 里返回"二期未启用"**（防止 LLM 输出后静默忽略）
- FIELD_PATHS 白名单含 startInputs（codex I6）
- 注释标注 codex 编号（F2/I3/I6）方便追溯

---

## 三、任务 2：新建 `apps/api/src/agent/operations/apply-operation.ts`

**纯函数，可单测**。签名：

```ts
import type { CozeWorkflow, CozeNode } from "@coze-workflow/workflow-schema";
import type { UpdateOperation } from "./operations.schema";

export interface ApplyResult {
  workflow: CozeWorkflow;   // 修改后的 workflow（浅拷贝，不原地改）
  changes: string[];        // 成功的修改描述
  errors: string[];         // 失败的操作描述
}

export interface ApplyContext {
  /** 用户新提供的参考数据（rewrite_code 用） */
  userReferenceData?: Record<string, string>;
  /** LLM 生成代码用（注入 nodeReferenceData 后） */
  codeGenerator: { generateCode(logic: string, inputs: string[] | undefined, refData: Record<string, string> | undefined): Promise<string> };
}

export async function applyOperations(
  workflow: CozeWorkflow,
  operations: UpdateOperation[],
  ctx: ApplyContext,
): Promise<ApplyResult>;
```

### 2.1 实现要点

- **深拷贝**：`structuredClone(workflow)` 后修改，返回新对象（不污染缓存原对象，save 失败可回滚）
- 逐条执行：成功 push changes，失败 push errors，**不中断**
- `findTargetNode`：title 精确 → id → title 包含（复用现状逻辑）

### 2.2 set 分支

- field=config.model → `node.config.model = value`（无 config 则创建）
- field=userPrompt/systemPrompt → 直接赋值
- field=code/language → 直接赋值
- field=branches → 见 3.4（expression 形状）
- field=outputs/outputVariables/startInputs → 直接赋值数组
- field=data → 直接赋值
- **值类型已由 schema superRefine 保证**（任务 1），这里只赋值

### 2.3 set_ref 分支（codex I3）

- target 必须是 end 节点（非 end → errors.push("set_ref 仅支持结束节点")）
- 按 outputName 在 `node.outputVariables` 里定位，找到 → 替换 value；找不到 → errors.push("未找到输出变量 X")
- **不修改 name、不修改其他元素**（多输出结束节点）

### 2.4 rewrite_code 分支（codex I2 优先级反转）

```ts
// 参考数据优先级（工具侧强制，LLM 不可覆盖）：
// 1. 节点已有 referenceData（服务端缓存真实数据）
const nodeRef = (node as any).referenceData as Record<string, string> | undefined;
// 2. 用户新提供的（合并）
const merged = { ...(nodeRef ?? {}), ...(ctx.userReferenceData ?? {}) };
// 3. 都无 → 拒绝
if (Object.keys(merged).length === 0) {
  errors.push(`节点 ${targetName} 无参考数据，请先提供歌词库/数据后再重写`);
  return;
}
const code = await ctx.codeGenerator.generateCode(op.logicDescription, undefined, merged);
node.code = code;
node.language = "python";
```

### 2.5 二期 op（delete_node/delete_edge）

```ts
case "delete_node":
case "delete_edge":
  return errors.push("该操作属二期，本期未启用");
```

### 2.6 迭代计数（codex S2）

- applyOperations **不碰迭代计数**（那是工具壳的事）
- 返回 `{ workflow, changes, errors }`，工具壳根据 `changes.length > 0` 决定是否 increment

---

## 四、任务 3：重写 `apps/api/src/agent/tools/update-workflow.tool.ts`（工具壳）

### 3.1 schema（codex I4：operations 直传为主路径）

```ts
schema: z.object({
  workflowId: z.string().describe("工作流 ID"),
  operations: z.array(UpdateOperationSchema).describe(
    "结构化修改操作列表（推荐主路径，直接输出 op，如 [{op:'set', target:'LLM 处理', field:'config.model', value:'Qwen3.5-Omni-Plus'}]）",
  ),
  fixInstruction: z.string().optional().describe(
    "自然语言修改指令（可选，未传 operations 时用；工具会解析为 operations）",
  ),
  referenceData: z.record(z.string(), z.string()).optional().describe("用户新提供的参考数据（如歌词库）"),
  workflow: z.record(z.string(), z.any()).optional().describe("可选。句柄化降级：不传时从缓存取"),
})
```

### 3.2 主流程

```
1. 解析目标工作流：workflow ?? workflowCache.get(workflowId)（现状逻辑保留）
2. stale 检测（缓存命中时，现状逻辑保留）
3. operations 来源：
   - 传了 operations → 直接用（主路径，零解析）
   - 未传 operations 但有 fixInstruction → chatStructured(UpdateOperationsSchema) 解析
   - 都没有 → 返回错误"请传 operations 或 fixInstruction"
4. 解析失败（fixInstruction 路径）→ 返回明确错误：无法将指令归类为 set/set_ref/rewrite_code，请直接输出 operations（codex I5，不做猜字段兜底）
5. applyOperations(workflow, ops, { userReferenceData: referenceData, codeGenerator })
6. changes.length > 0 → markDirty(workflowId) + incrementIteration(workflowId)
   changes.length === 0 → 不消耗迭代计数
7. 返回 { changes, errors?, workflowId, dirty } + 保存提示
```

### 3.3 迭代计数入口（codex S2）

```ts
const iteration = peekIteration(workflowId);
if (iteration >= MAX_ITERATIONS) {  // 修 off-by-one：>= 而不是 >
  return iterationLimitMessage(workflowId);
}
```

### 3.4 删除旧逻辑

- 删除 UpdateInstructionSchema / UpdateInstructionsSchema / parseInstructions / applyOneInstruction / replaceThresholdText / summarizeNodes 中不再使用的部分
- 删除旧 type/content 兼容层（codex S4）

---

## 五、任务 4：A/B 回放测试（codex S3，验收数据）

新建 `scripts/ab-test-update-schema.ts`：

1. 从日志/历史记录收集 **20-30 条真实 fixInstruction**（改模型/改输出/改代码/改阈值/删节点等，可硬编码进脚本）
2. **旧 schema**（`{type, target, content}`）解析每条，记录成功率
3. **新 schema**（operations 数组）解析同样每条，记录成功率 + token 消耗
4. 输出对比表：`旧成功率 vs 新成功率`、平均 token
5. 结论：新 schema 成功率 ≥ 旧 schema 的 90% 视为通过；低于则需调整 describe 再测

---

## 六、验收标准

1. `npm run build` 通过。
2. **vitest 单测**（新建 `apps/api/src/agent/operations/apply-operation.spec.ts`，如项目无 vitest 则加依赖）：
   - set：config.model 更新 ✅ / 非法 field 拦截（schema 层）✅ / 值类型不符拦截（superRefine）✅
   - set_ref：outputVariables 定向更新（outputName 定位）✅ / ref 格式非法拦截 ✅ / 非 end 节点拒绝 ✅ / outputName 未匹配报错 ✅
   - rewrite_code：referenceData 合并注入 ✅ / 无数据拒绝 ✅ / 非 code 节点拒绝 ✅
   - 多条混合：部分失败不中断 ✅ / 全部失败 changes 为空 ✅
   - branches：expression 形状 set 后 save 链路验证（回归 F1）
3. **A/B 回放测试**：新 schema 成功率 ≥ 旧 schema 的 90%（输出对比表）
4. 端到端手测：
   - 场景 A：`operations:[{op:'set', target:'LLM 处理', field:'config.model', value:'Qwen3.5-Omni-Plus'}]` → 生效
   - 场景 B：`{op:'set_ref', target:'结束', outputName:'final', ref:'node_xxx.result'}` → 生效，save 后 end 返回新引用
   - 场景 C：一次改多处（set 模型 + rewrite_code）→ 全部生效
   - 回归：原有用例（歌曲识别）update → save 链路可用

## 七、提交要求（直接 main）

- commit：`refactor(agent-coze-workflow): update_workflow op 化重构（一期 set/set_ref/rewrite_code）`
- push origin main

## 八、约束与不做

- **不做二期**（delete_node/delete_edge 本期仅 schema 定义 + 返回"未启用"）
- **不改**：code-generator.ts、schema-converter.ts、generator.ts、workflow-cache.ts、iteration-counter.ts（只修工具壳的 `>=` 判断）
- 保持项目风格：中文注释、错误字符串返回、zod describe
- 不引入 DSL、不改前端
