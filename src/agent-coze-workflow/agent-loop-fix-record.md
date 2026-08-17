# 思考循环修复实施记录：修改思考与删除内容

> 日期：2026-08-17
> 关联文档：[agent-thinking-loop-review.md](./agent-thinking-loop-review.md)（根因分析）
> 本文档记录：每一项修改的**设计思考与取舍**、被**删除的代码原文**、**保留未动的内容及理由**。

---

## 一、修改思考（每项为什么这样改）

### 1. SYSTEM_PROMPT 重写为「交付优先」

**修改前的问题**：prompt 开头是"使用工具**自主**完成…**验证迭代**"，工具清单第 8 条写着 update_workflow 用于"根据归因分析结果修改"，使用规则里有"每一步完成后检查结果，再决定下一步"，文件流程第 6-7 步硬编码了"batch_validate → 若 accuracy < 100% → update_workflow → 重新 save → batch_validate"的闭环。这些文字把"创建"任务定义成了"调优"任务。

**设计思考**：
- **交付优先章节放在工具清单之后、使用规则之前**：这是给 LLM 的最高优先级约束，位置越靠前权重越高。核心指令只有一句："save 成功即交付，停止一切验证与修改"。
- **为什么是"最多修复 1 次"而不是 3 次**：修复本身就是循环。1 次修复是经验值——能修好一次就能修好，修不好第二次大概率还是修不好（failurePatterns 相同）；3 次又会回到调优循环的老路。1 次修复后强制汇报，把"继续修不修"的决策权交还给用户。
- **batch_validate/test_run_workflow 工具保留但约束触发**：用户可能真的要求验证，工具不能删；只把"是否调用"从默认行为改成用户显式要求的例外行为。
- **句柄化规则统一为 operations 直传**：原 prompt 推荐"update_workflow 只传 workflowId + fixInstruction"，与工具 description 推荐的 operations 矛盾。矛盾会让模型在两个入口间摇摆。现在 prompt 与工具 description 只说 operations 一个入口。

### 2. MAX_STEPS_PER_TURN：25 → 15

**设计思考**：15 步的预算账：plan(1) + generate(1) + save(1) = 3 步完成默认流程；用户要求验证时追加 validate(1) + update(1) + save(1) = 6 步核心流程，剩 9 步余量给工具失败重试和 clarify。25 步在旧 prompt 下足够跑完 2~3 轮完整的 validate→update→save 往返——用户感知就是"反复循环"。15 步既保正常任务余量，又制造"预算焦虑"促使模型收敛。

### 3. 交付守卫（TurnGuardState）：save 成功后拦截迭代工具

**设计思考**：
- **为什么不在 save 成功时直接 break 主循环**：save 成功后还有合法动作——向用户汇报、可能调用 rename_workflow 改名。直接 break 会截断回复。所以选择"拦截迭代工具"而非"终止循环"。
- **拦截列表只含 4 个迭代工具**（plan_workflow / generate_workflow / batch_validate / update_workflow），rename_workflow、list_workflows、read_workflow 等无害工具不拦。
- **为什么第 2 次拦截才 `forced_delivery` 强制收尾**：第 1 次拦截推入 `[系统拦截]` 警告 ToolMessage 并跳过该工具，给模型一次遵守提示的机会（大部分模型看到系统警告会停止）；如果模型无视警告再次尝试迭代工具，说明它在对抗系统约束，第 2 次直接强制收尾，不等它自愿停。这是"先礼后兵"的渐进式硬边界。
- **用户明确要求验证时拦截列表缩小为 plan/generate**：验证修复是用户明确要求的工作，不能一刀切拦掉 validate/update；此时由迭代计数器（MAX_ITERATIONS=3）兜底。
- **validationRequested 的检测**：正则 `/验证|校验|准确率|测一下|测测|对一下|检查一下|跑一下用例/` 匹配用户本轮消息，覆盖常见口语表达，避免只认"验证"两个字漏判。

### 4. 连续失败拦截（FAIL_REPEAT_LIMIT = 3）

**设计思考**：旧 loopGuard 只拦"同工具同参数连续 4 次"，拦不住"A 失败 → B 失败 → A 失败"的交替失败循环。新 failStreak 不区分工具——**任何工具连续失败 3 次**即收尾。为什么是 3：第 1 次失败可能是瞬态（网络、平台抖动），第 2 次可能是参数问题，第 3 次基本可判定"模型无法自行解决"，继续重试只是烧 token 和时间。成功一次即清零（failStreak = 0），不会误伤。

### 5. 重复规划拦截（PLAN_CALL_LIMIT = 2）

**设计思考**：plan_workflow 是最贵的工具（planner.ts 内部多次 LLM 调用，且不消耗主循环 step 计数，但显著拉长 wall-clock）。planId 已句柄化，generate 只传 planId 即可，重复规划没有任何收益。2 次 = 1 次初始规划 + 1 次修订，足够覆盖"需求理解有偏差需要重规划"的合法场景。

### 6. 删除 resetIteration（迭代计数只增不减）

**设计思考**：
- 原 C 点建议是"改为仅在全新工作流首次创建时清零"，实施时选择了**完全删除**——更简单更激进。
- 理由：无法可靠区分"首次创建"（LLM 不传 workflowId 但可能传同名 workflow，也可能在已有 workflow 上"重新创建"）。而**新 workflowId 天然从 0 开始计数**，首次创建根本不需要显式清零。删掉后 `iterationLimitMessage` 从死代码恢复为可达路径。
- 语义变化：MAX_ITERATIONS=3 从"每轮修复的预算"变成"该 workflowId 整个生命周期的修改预算"。validate + update 合计最多 3 次，超过后工具层直接拒绝并命令 LLM 汇报。

### 7. 激进删除 fixInstruction 路径（operations 成为唯一入口）

**设计思考**：
- 原方案是双入口：operations 直传（主路径）+ fixInstruction 自然语言（兼容入口，内部 `chatStructured` 解析）。**双入口本身就是诱导**：SYSTEM_PROMPT 推荐 fixInstruction，模型就走它，每次调用内嵌一次 LLM 解析 + 可能的重试，形成二次思考回路。
- 删除后：update_workflow 的 LLM 调用成本归零（除了 rewrite_code 内部的必要代码生成），行为可预测——传 operations 就执行，不传就报错并给出示例格式。
- 代价：模型必须自己把修改意图翻译成结构化 op。这个翻译发生在**主循环的 LLM 输出阶段**（一次性完成），而不是工具内部二次调用（失败再试一轮），总的 LLM 调用次数更少。

### 8. generate_workflow 返回瘦身：workflowHandle + warnings 置空

**设计思考**：
- **新增 workflowHandle**（`wf_${randomUUID()}` 写缓存）：generate → save 链路不再需要 LLM 背诵完整 workflow JSON。
- **workflow 字段保留**：前端 App.tsx 的 parseGenerateOutput 依赖 `workflow`/`validation` 字段渲染右侧面板，删了前端就崩。要更激进需要同步改前端，不在本次范围。
- **warnings 置空而非删字段**：前端 JsonPreview.tsx 直接访问 `validation.warnings.length` 和 `.map`，删字段会抛 TypeError。置空既保前端，又去掉对 LLM 的"还没修好"暗示（MISSING_TEMP 等是平台导出格式约定，不是真实问题）。

### 9. batch_validate：description 去闭环 + 上限检查修 off-by-one

**设计思考**：
- description 是 LLM 选工具的依据，原文案"accuracy < 100% 时分析 failurePatterns 归因，调用 update_workflow 修改后重新验证"等于给工具内置了一个循环指令。改为"返回结果用于向用户汇报验证结论"。
- 上限检查从 `increment 后判断 > MAX`（off-by-one，实际允许第 4 次）改为 `peek 判断 >= MAX 拒绝后再 increment`，与 update_workflow 的检查语义对齐。

### 10. save_to_coze 新增 workflowHandle 参数

**设计思考**：source 解析链变为 `workflow ?? cached?.workflow ?? cache.get(workflowHandle)?.workflow`，三者都不传才报错。save 成功后 `workflowCache.remove(workflowHandle)`——handle 是一次性票据，用后即删，防缓存泄漏。首次保存推荐传 workflowHandle（generate 刚返回的），修复迭代传 workflowId 走 dirty 快照。

### 11. 死代码清理

- `summarizeNodes`：fixInstruction 解析路径删除后失去唯一调用者。
- `isIterationExceeded`：全仓无调用（上限检查统一改用 peekIteration + >=）。
- `UpdateOperationsParseSchema` / `normalizeOperations`：fixInstruction 专用宽松解析，路径删除后失去所有引用，连同 6 个单测一起删。

---

## 二、删除内容清单（git diff 还原原文）

### 2.1 react-agent.service.ts — SYSTEM_PROMPT 中被删的段落

```text
const SYSTEM_PROMPT = `你是 Coze 工作流构建助手，根据用户需求，使用工具自主完成
工作流的设计、生成、部署、试运行和验证迭代。
```

使用规则中被删的两条：

```text
- 规划→生成→部署→试运行，按顺序执行
- 每一步完成后检查结果，再决定下一步
```

句柄化规则被删的旧推荐（fixInstruction 路径）：

```text
- **句柄化（重要）**：update_workflow / save_to_coze 的 workflow JSON 参数现在可选。
  - 推荐流程：save_to_coze 后拿 workflowId → update_workflow 只传 workflowId + fixInstruction（不传大 JSON）→ 再 save_to_coze 传 workflowId 保存
```

文件与验证流程中被删的闭环（"修到 100%"核心现场）：

```text
5. save_to_coze 保存 → 拿 workflowId
6. batch_validate 批量试运行（cases 由 LLM 根据文件内容构造）→ 看 accuracy
7. 若 accuracy < 100%：分析 failurePatterns → 给出 fixInstruction → update_workflow → 重新 save → batch_validate
...
9. 验证通过：总结交付（含最终 workflowId 和 accuracy）
```

常量修改：

```text
/** 每 turn 最多 LLM 步数（死循环保护上限） */
const MAX_STEPS_PER_TURN = 25;
```

工具清单第 8 条旧文案（强调"根据归因分析结果修改"）：

```text
8. update_workflow: 根据归因分析结果修改工作流节点（阈值/代码/逻辑/prompt/提示词/数据/常量），返回 changes 摘要（不再返回完整 workflow）
```

### 2.2 iteration-counter.ts — 删除 2 个函数

```typescript
/** 重置指定工作流的计数（新建工作流时调用） */
export function resetIteration(workflowId: string): void {
  iterationCounts.delete(workflowId);
}

/** 是否已达迭代上限 */
export function isIterationExceeded(workflowId: string): boolean {
  return getIteration(workflowId) > MAX_ITERATIONS;
}
```

文件头注释被删的两条：

```text
- 只增不减（除 save 成功后 reset），LLM 无法绕过
- 新建工作流（新 workflowId）后自动从 0 开始
```

### 2.3 save.tool.ts — 删除 resetIteration 调用

```typescript
import { resetIteration } from "./iteration-counter";
```

save 成功路径中被删的调用：

```typescript
      resetIteration(platformWorkflowId);
```

### 2.4 update-workflow.tool.ts — 删除整条 fixInstruction 二次解析路径

工具文件头中被删的职责描述：

```text
 * 按结构化操作指令（op）修改工作流节点字段。LLM 直接输出 operations
 * 数组（主路径，零解析），代码按 op 确定性执行；fixInstruction 自然语言
 * 作为兼容入口，内部解析为 operations 后执行。
```

删除的 PARSE_SYSTEM_PROMPT 常量（约 15 行）：

```typescript
/**
 * fixInstruction 解析的 system prompt：手动描述 op 结构
 *
 * DeepSeek jsonMode 不自动注入 schema（deepseek.client.ts 注释），
 * 且 discriminatedUnion 的 toJsonSchema 没有顶层 properties，
 * describeSchemaFields 拿到空串——所以输出格式必须在 prompt 里写清楚。
 */
const PARSE_SYSTEM_PROMPT =
  "你是工作流修改指令解析器。将用户的自然语言修改指令解析为操作数组，输出 JSON 数组。" +
  "每个元素是以下三种操作之一（op 字段区分）：" +
  '1. {op:"set", target:"节点title或id", field:"白名单字段", value:新值}——改字段。' +
  "白名单字段：config.model（模型名，字符串）/ userPrompt / systemPrompt / code / language（以上字符串值）；" +
  "branches（条件分支数组，元素形状 {expression:条件表达式, targetNodeId:跳转节点id}）/ outputs / outputVariables / inputVariables（以上数组值）；data（任意 JSON）。" +
  '2. {op:"set_ref", target:"结束节点", outputName:"输出变量名", ref:"nodeId.outputName"}——改结束节点输出引用。' +
  '3. {op:"rewrite_code", target:"代码节点", logicDescription:"新的业务逻辑描述"}——重写代码逻辑。' +
  '（delete_node / delete_edge 本期未启用，不要输出。）' +
  "无法归类的指令不要输出任何元素（输出空数组）。";
```

删除的 PARSE_FAIL_MESSAGE 常量：

```typescript
/** LLM 解析失败/无结果时的错误提示（引导 LLM 直接输出 operations，codex I5） */
const PARSE_FAIL_MESSAGE =
  "工作流更新失败: 无法将指令归类为 set/set_ref/rewrite_code 操作。" +
  "请直接输出 operations 参数（结构化操作数组），例如：" +
  '[{op:"set", target:"LLM 处理", field:"config.model", value:"Qwen3.5-Omni-Plus"}]。' +
  "不要用自然语言描述修改意图。";
```

删除的 summarizeNodes 死代码：

```typescript
/**
 * 生成工作流节点摘要（id/title/type），帮助 LLM 定位 target 节点
 *
 * @param workflow - 当前工作流 JSON
 */
function summarizeNodes(
  workflow: unknown,
): Array<{ id: string; title: string; type: string }> {
  const wf = workflow as Record<string, unknown>;
  const nodes = (wf?.nodes as Array<Record<string, unknown>>) ?? [];
  return nodes.map((n) => ({
    id: String(n.id ?? ""),
    title: String(n.title ?? ""),
    type: String(n.type ?? ""),
  }));
}
```

删除的 fixInstruction 解析逻辑块（工具函数体内）：

```typescript
      // 1. operations 来源：
      //    主路径：参数直传（零解析、零额外 LLM 调用，codex I4）
      //    兼容路径：fixInstruction → chatStructured 解析为 operations
      let operationsList = operations ?? [];
      if (operationsList.length === 0 && fixInstruction) {
        try {
          // 宽松解析：jsonMode 下模型对"顶层数组"约束遵守不稳定
          // （实测输出单个对象 / {ops:[...]} 包裹壳），union 容错后归一化
          const parsed = await client.chatStructured(
            UpdateOperationsParseSchema,
            PARSE_SYSTEM_PROMPT,
            `当前工作流节点摘要：${JSON.stringify(summarizeNodes(wf))}\n\n` +
              `用户修改指令：${fixInstruction}`,
          );
          operationsList = normalizeOperations(parsed);
        } catch {
          return PARSE_FAIL_MESSAGE;
        }
      }
```

删除的 schema 字段：

```typescript
      fixInstruction: z
        .string()
        .optional()
        .describe(
          "自然语言修改指令（兼容入口，operations 未传时用）。如「把『相似度计算』节点的阈值从 0.8 改为 0.6」",
        ),
```

description 中删除的兼容入口文案：

```text
"未传 operations 时可传 fixInstruction 自然语言指令（工具会解析为 operations，兼容入口）。"
```

### 2.5 operations.schema.ts — 删除宽松解析 schema + 归一化函数

```typescript
/**
 * fixInstruction 解析专用宽松 schema（A/B 实测校准）
 *
 * DeepSeek jsonMode 不注入 schema，模型对"顶层必须是数组"这一约束
 * 遵守不稳定（实测 26 条样本出现单个对象 / {"ops":[...]} 包裹壳两种
 * 形状偏离，裸 z.array 全部失败）。旧 schema 的 union 形状容错是它
 * 100% 成功率的关键，新 schema 对齐同等容错：单个操作 / 操作数组 /
 * {ops:[...]} / {operations:[...]} 四种形状，解析后统一归一化为数组。
 * 仅 fixInstruction 兼容路径使用；operations 参数直传主路径仍用
 * UpdateOperationsSchema（工具 schema 层强制数组，形状不偏离）。
 */
export const UpdateOperationsParseSchema = z.union([
  UpdateOperationSchema,
  UpdateOperationsSchema,
  z.object({ ops: UpdateOperationsSchema }),
  z.object({ operations: UpdateOperationsSchema }),
]);

/**
 * 归一化：宽松解析结果 → 操作数组
 *
 * @param parsed - UpdateOperationsParseSchema 的解析结果（4 种形状之一）
 * @returns 操作数组
 */
export function normalizeOperations(parsed: unknown): UpdateOperation[] {
  if (Array.isArray(parsed)) return parsed as UpdateOperation[];
  const obj = parsed as Record<string, unknown>;
  if (Array.isArray(obj.ops)) return obj.ops as UpdateOperation[];
  if (Array.isArray(obj.operations))
    return obj.operations as UpdateOperation[];
  return [parsed as UpdateOperation];
}
```

### 2.6 operations/index.ts — 删除 2 个 export

```typescript
  UpdateOperationsParseSchema,
  normalizeOperations,
```

### 2.7 apply-operation.spec.ts — 删除 6 个单测

```typescript
// ============================================
// fixInstruction 宽松解析（A/B 实测校准：模型输出形状不稳定）
// ============================================

describe("UpdateOperationsParseSchema + normalizeOperations", () => {
  // 6 个 it：裸数组形状 / 单个对象形状 / {ops:[...]} 包裹壳 /
  // {operations:[...]} 包裹壳 / 非法形状拦截 / 元素非法拦截
});
```

### 2.8 batch-validate.tool.ts — 删除 description 中的闭环文案

```text
"失败明细只含失败用例（最多 10 个），用于验证闭环：accuracy < 100% 时分析" +
"failurePatterns 归因，调用 update_workflow 修改后重新验证。",
```

### 2.9 generate.tool.ts — warnings 内容不再返回

```typescript
            warnings: validation.warnings,   // → 改为 warnings: []
```

### 2.10 删除代码统计

| 文件 | 净删除行数（diff 统计） |
|------|------------------------|
| update-workflow.tool.ts | 约 85 行（103 行变更中大部分为删除） |
| apply-operation.spec.ts | 约 50 行 |
| operations.schema.ts | 33 行 |
| iteration-counter.ts | 约 11 行 |
| save.tool.ts | 2 行（resetIteration 相关） |
| **合计** | **约 180 行纯删除** |

---

## 三、保留未动的内容及理由

| 内容 | 未动理由 |
|------|---------|
| plan.tool.ts 的完整 plan 平铺返回 | generate 已走 planId 句柄，plan 全文进上下文影响次之；且改返回形态会牵动前端渲染，可作下一轮瘦身候选 |
| validator 的 MISSING_TEMP 等 warning 生成逻辑 | 生成逻辑本身没错（平台导出格式约定），只在 generate 返回处截断，不污染生成质量 |
| rewrite_code 内部的 codeGenerator LLM 调用 | 代码生成无法用确定性操作表达，是必要成本；一次 update 的内嵌调用从"1(解析)+N(rewrite)"降为"N(rewrite)" |
| code-generator 违规检测后重试一次 | 防止违规代码上线，属于安全边界而非循环放大器 |
| MAX_ITERATIONS = 3 的数值 | 语义从"每轮修复预算"变为"workflowId 生命周期预算"后，3 次已足够紧 |
| generate 返回中的 workflow 字段 | 前端 App.tsx parseGenerateOutput 依赖它渲染右侧面板，删字段前端崩溃 |
| LoopGuard 同参 4 次检测 | 与新增的三层拦截互补，不冲突，无需删 |

---

## 四、验证结果

- `pnpm typecheck`：6/6 通过（api / web / shared / workflow-schema）
- `pnpm build`：4/4 通过
- `npx vitest run`：20/20 通过（apply-operation.spec.ts）
- 全仓 grep 确认：`resetIteration` / `fixInstruction` / `UpdateOperationsParseSchema` / `normalizeOperations` / `summarizeNodes` / `isIterationExceeded` / `PARSE_SYSTEM_PROMPT` / `PARSE_FAIL_MESSAGE` 在 apps/ 与 packages/ 代码目录中零残留（仅存在于历史 review 文档与 docs/ 历史设计文档）

---

## 五、风险与注意事项

1. **交付守卫的误伤风险**：save 成功后拦截 batch_validate/update_workflow 依赖"用户消息含验证意图"的正则检测。若用户用正则未覆盖的表达（如"帮我跑一下"）要求验证，且此时已 save 成功，验证会被拦截。缓解：拦截提示会告知"工作流已保存成功"，模型可向用户说明，用户再发一条消息（新一轮 turn，guardState 重置）即可正常验证。
2. **failStreak 跨工具计数可能偏严**：连续 3 次不同工具失败（如 read_file 失败 → save 失败 → update 失败）也会触发收尾。但此时模型大概率确实无法自行解决，收尾向用户汇报是合理行为。
3. **workflowHandle 是一次性票据**：save 成功后即删除。若模型 save 失败后想重试 save（不带 workflow），会因 handle 已删且无 workflowId 而失败——但 save 失败时工具不会执行到 remove 行（remove 在成功后），所以重试链路不受影响。
4. **15 步上限在复杂任务下可能偏紧**：大工作流（10+ 节点）的 plan + generate 内部 LLM 调用不受 step 限制（planner/generator 直连客户端），但主循环步数若因工具失败重试耗尽，会触发 step_limit 收尾。观察线上表现，如频繁误触可回调到 18-20。
