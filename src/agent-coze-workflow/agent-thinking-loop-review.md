# AI 思考循环过多根因 Review

> 状态：Review 完成 + 修复已实施（2026-08-17），见文末「修复记录」
> 日期：2026-08-17
> 范围：自建 Harness 主循环（已移除 LangGraph）下，"AI 思考循环太多，导致无法正常创建工作流"的根因定位与修复
> 结论先行：主循环本身没有逻辑 bug，问题集中在 **prompt 策略层（默认自测到 100%）+ save 清零迭代上限** 这个组合上，它把"创建"任务改写成了"无限调优"任务。

---

## A. 根因判断（按可能性排序）

| # | 根因 | 严重度 |
|---|------|--------|
| 1 | SYSTEM_PROMPT 内置"修到 100% + 自主验证迭代"指令，而 `save_to_coze` 成功后 `resetIteration` 把唯一的 3 轮硬上限清空，两者组合使 validate→update→save→validate 循环永无上限，只能靠 25 步 step_limit 兜底 | 致命 |
| 2 | 主循环终止条件只有"模型自愿停"和"25 步上限"，没有"任务完成度"判定；save 成功不产生任何停止信号，模型持续输出 tool_calls 就会一路跑到 25 步 | 高 |
| 3 | `generate_workflow` 把完整 workflow JSON + validation（含几乎必然出现的 warnings）塞回上下文，模型看到 warnings 倾向去修；`plan_workflow` 同样平铺返回完整 plan 供咀嚼 | 高 |
| 4 | SYSTEM_PROMPT 推荐 update 走 `fixInstruction` 兼容路径，与工具 description 推荐的 `operations` 主路径矛盾；fixInstruction 每次内嵌一次 LLM 解析，`rewrite_code` 内部还嵌套代码生成 LLM 调用（含一次违规重试），形成二次思考回路 | 中 |
| 5 | 所有失败/告警信号一律以"请修复/请重试"口吻返回，没有区分"必须停"与"可修"；loopGuard 只拦同参连续 4 次，拦不住 plan→generate→validate→update 的交替循环 | 中 |

补充说明：`planner.ts` 内部的多次 LLM 调用（骨架 + 逐节点 config）不消耗主循环 step 计数（直连 DeepSeekClient，不经 `phase.step`），但显著拉长 wall-clock 与失败面，放大"思考太多"的观感。

---

## B. 证据位置

### B1. 主循环终止条件过弱（根因 2）

- `apps/api/src/agent/react-agent.service.ts` `turn()` L639-685 的 `while (true)`：
  - 唯一终止路径：`phase.step >= 25`（L642）、模型无 tool_calls（L891-897）、连续 2 次 max_tokens（L665）、同参循环 4 次（L933-958）、clarify 挂起。
  - 没有任何"save_to_coze 已成功 → 可交付"的判定。`save.tool.ts` 返回 `{workflowId, saved: true}` 后，模型只要继续输出 tool_calls，循环就继续。
- L177-178：`MAX_STEPS_PER_TURN = 25`——25 步足够跑完 2~3 轮完整的 validate→update→save 往返，用户感知就是"反复循环"。
- L933-958：死循环检测只匹配"同一工具 + 同一参数连续出现"，A→B→A→B 型循环完全拦不住。

### B2. "修到 100%"指令 + 迭代上限被 reset 架空（根因 1）

- `react-agent.service.ts` L75：SYSTEM_PROMPT 开头"使用工具**自主**完成工作流的设计、生成、部署、试运行和**验证迭代**"。
- L126-129（文件与验证流程）：
  - "6. batch_validate 批量试运行（cases 由 LLM 根据文件内容构造）→ 看 accuracy"
  - "7. 若 accuracy < 100%：分析 failurePatterns → 给出 fixInstruction → update_workflow → 重新 save → batch_validate"
  - 只有"验证通过才交付"，没有"用户没要求验证就只交付"的分支，也没有"save 成功即交付"的分支。
- `apps/api/src/agent/tools/save.tool.ts` L244：`resetIteration(platformWorkflowId)`——每次 save 成功把迭代计数清零。
- `apps/api/src/agent/tools/iteration-counter.ts` L18：`MAX_ITERATIONS = 3`。
- 组合效果：`batch_validate(→1) → update_workflow(→2) → save(→reset 0) → batch_validate(→1) → ...`。
  SYSTEM_PROMPT L115 声称的"系统级迭代上限（3 轮）"在修复循环必经 save 的前提下永远不会触发，`iterationLimitMessage` 沦为死代码路径。

### B3. 工具返回过重（根因 3）

- `apps/api/src/agent/tools/plan.tool.ts` L37-45：`JSON.stringify({ ...plan, planId, _meta })`——完整 plan（steps/contracts/nodeConfig）平铺返回，全部进 ToolMessage 入 history。虽然 generate 可只传 planId，但 plan 全文已进上下文，模型下一步必然"咀嚼"它。
- `apps/api/src/agent/tools/generate.tool.ts` L58-69：返回 `{ workflow: 完整JSON, validation: {valid, errors, warnings} }`。完整 workflow 进上下文；save 虽可句柄化，但模型已看到全文。
- `packages/workflow-schema/src/validator/index.ts` L119-125：每个节点缺 `_temp` 就 push `MISSING_TEMP` warning。generator 生成的节点基本不带 `_temp`（那是平台导出格式约定），所以 warnings 几乎必然非空——模型每轮 generate 都收到 warning，天然产生"还没修好"的错觉。
- `apps/api/src/agent/tools/batch-validate.tool.ts` L369-370：工具 description 本身就写"accuracy < 100% 时分析 failurePatterns 归因，调用 update_workflow 修改后重新验证"——工具描述层也在鼓励迭代闭环。

### B4. update_workflow 二次思考回路（根因 4）

- `react-agent.service.ts` L106-108：SYSTEM_PROMPT 推荐流程是"update_workflow 只传 workflowId + fixInstruction"。
- `apps/api/src/agent/tools/update-workflow.tool.ts` L164-182：fixInstruction 路径内部调 `client.chatStructured(...)` 再解析为 operations；解析失败返回 `PARSE_FAIL_MESSAGE`（L93-97，要求"请直接输出 operations"）→ 模型换写法再试 → 多轮。
- 工具 description（L235-243）推荐的是 operations 直传，与 SYSTEM_PROMPT 的推荐矛盾，模型大概率走被 prompt 推荐的 fixInstruction 兼容路径。
- `apps/api/src/agent/operations/apply-operation.ts` L200-204：`rewrite_code` 内部调 `codeGenerator.generateCode`（又一次 LLM 调用）。
- `apps/api/src/workflow-engine/code-generator.ts` L120-142：违规检测后还会重试一次。一次 update 的 LLM 嵌套调用可达 1（fixInstruction 解析）+ N（rewrite_code 数量 × ≤2）次。

### B5. 失败/告警被当成"继续修"信号（根因 5）

- `update-workflow.tool.ts` L222-228：返回末尾 `⚠️ 部分修改未生效: ${errors}` + "请调用 save_to_coze 保存"。
- `save.tool.ts` L230-237：validate_tree 失败返回"请修复节点连线后重新保存"（这条合理，但每轮失败都诱导重试）。
- `react-agent.service.ts` L982-984：任何工具抛异常 → ToolMessage "工具执行失败: ..."，模型默认行为是重试。除了 prompt 文字（L116 auth failed 不要反复保存），代码层没有对"不可修复类错误"的强制停机。

---

## C. 最该先改的 3 个点（按优先级）

1. **堵死无限循环机制**：`save.tool.ts` L244 的 `resetIteration` 不应在每次 save 时调用（或改为仅在"全新工作流首次创建"时清零）；同时让 save 成功向主循环产生一个强交付信号——例如主循环检测到"本 turn 已成功 save 且后续无用户明确要求"，直接进入收尾，而不是等模型自愿停。
2. **SYSTEM_PROMPT 改为"交付优先"**（react-agent.service.ts L75-135）：默认流程收缩为 plan→generate→save→交付；"除非用户明确要求验证，不要自动 batch_validate"；accuracy < 100% 时汇报结果 + 建议而非自动进入 update 循环；删除 L127-128 的"修到 100%"闭环表述，改为"最多修 1 次，然后汇报"。
3. **收敛工具返回与 update 路径**：
   - `generate_workflow` 不把完整 workflow 塞回上下文，只返回句柄 + 校验摘要；`MISSING_TEMP` 这类平台格式 warning 分级为"提示"或直接不返回。
   - SYSTEM_PROMPT 与工具 description 统一：只推荐 `operations` 直传，删除 L107 对 fixInstruction 的推荐表述。
   - `update_workflow` 的 `errors` 返回改为"停一下"口吻（"本次未全部生效，如需继续请基于新 changes 再操作一次"），不再暗示"立即再修"。

---

## D. 明确结论

### 鼓励模型"继续想"的

- SYSTEM_PROMPT 的"自主完成…验证迭代"、"每一步完成后检查结果，再决定下一步"（react-agent.service.ts L75、L93）——把每次工具结果都定义为"再思考一轮"的输入。
- `plan_workflow` 平铺返回完整 plan（plan.tool.ts L37-45）和 `generate_workflow` 返回完整 workflow + warnings（generate.tool.ts L58-69），让模型每轮都有大 JSON 可咀嚼。
- 25 步预算（L178）在心理上没有任何"预算焦虑"，模型不急着收敛。

### 鼓励模型"继续修"的

- 明确指令："若 accuracy < 100%：分析 failurePatterns → … update_workflow → 重新 save → batch_validate"（L127-128）。
- batch_validate 工具 description 自带"accuracy < 100% 就修"闭环（batch-validate.tool.ts L369-370）。
- generate 返回的 `MISSING_TEMP`/`CODE_NODE_SOURCE_PORT` warnings（validator L119-125、L156-163）几乎必现，被当成"还有问题"的信号。
- update 返回"⚠️ 部分修改未生效"（update-workflow.tool.ts L224-227）、save 失败"请修复后重新保存"（save.tool.ts L235）。
- fixInstruction 解析失败后要求"请直接输出 operations"（update-workflow.tool.ts L93-97），诱导换写法再试一轮。

### 会实际拖进无限循环的机制

- `save → resetIteration`（save.tool.ts L244）架空了唯一的工具层硬上限，`iterationLimitMessage` 在真实修复流程中永远不可达——这是代码层最确定的循环放大器。
- 主循环 `while(true)` 无完成态判定（react-agent.service.ts L639-685）：模型不自愿停就只能等 step_limit=25。
- loopGuard 只拦"同工具同参数连续 4 次"（L933-958），拦不住 plan→generate→validate→update 的语义循环。
- 40 条滑动窗口（L180）可能裁掉早期 plan 上下文，模型"失忆"后重新 plan，进一步稀释"不要重复规划"（L111）的约束。

### 一句话结论

主循环本身没有逻辑 bug，问题集中在 **prompt 的策略层（默认自测到 100%）+ save 清零迭代上限这个组合**——它把"创建"任务改写成了"无限调优"任务；generate/plan 的过重返回和 update 的 fixInstruction 二次解析是第二层的循环燃料。先改 C 的 1、2 两条，效果会立竿见影。

---

## 附录：涉及文件清单

| 文件 | 角色 |
|------|------|
| `apps/api/src/agent/react-agent.service.ts` | 主循环 + SYSTEM_PROMPT（根因 1/2/4 核心现场） |
| `apps/api/src/agent/tools/save.tool.ts` | resetIteration 清零（循环放大器） |
| `apps/api/src/agent/tools/iteration-counter.ts` | 3 轮迭代上限（被 save 架空） |
| `apps/api/src/agent/tools/plan.tool.ts` | plan 平铺返回（过重） |
| `apps/api/src/agent/tools/generate.tool.ts` | workflow + validation 全量返回（过重） |
| `apps/api/src/agent/tools/update-workflow.tool.ts` | fixInstruction 二次解析 + "继续修"口吻 |
| `apps/api/src/agent/tools/batch-validate.tool.ts` | description 内置迭代闭环 |
| `apps/api/src/agent/operations/apply-operation.ts` | rewrite_code 内嵌 LLM 调用 |
| `apps/api/src/workflow-engine/code-generator.ts` | 代码生成 + 违规重试 |
| `packages/workflow-schema/src/validator/index.ts` | MISSING_TEMP 等必现 warnings |
| `apps/api/src/agent/session.store.ts` | Phase/Inbox 状态（本次未发现问题） |

---

## 修复记录（2026-08-17 已实施，验证通过）

按 C 的三个优先点 + 根因 4/5 的清理实施，激进删除垃圾代码：

### 1. 主循环硬边界（react-agent.service.ts，对应根因 1/2/5）

- **SYSTEM_PROMPT 重写为「交付优先」**：
  - 开头改为"根据用户需求完成工作流的设计、生成、部署与交付；只有用户明确要求验证时才进行批量验证"
  - 新增「## 交付优先（最重要，必须遵守）」章节：保存成功即交付、不主动 batch_validate、最多修复 1 次、收到 [系统拦截] 必须遵守
  - 删除"每一步完成后检查结果，再决定下一步"和"修到 100%"闭环表述
  - 句柄化规则统一为 update_workflow 只传 workflowId + operations（结构化数组，唯一主路径），不再推荐 fixInstruction
- **MAX_STEPS_PER_TURN 25 → 15**：收紧 step 预算，制造"预算焦虑"促收敛
- **新增交付守卫（TurnGuardState）**：
  - save_to_coze 返回 `"saved": true` → 本 turn 进入交付模式，拦截 plan/generate/validate/update 等迭代工具
  - 第 2 次拦截直接 `forced_delivery` 强制收尾（不等模型自愿停）
  - 用户明确要求验证时（正则检测"验证/校验/测一下/检查一下"等）仅拦截重复 plan/generate，验证修复由迭代计数器兑底
- **新增连续失败拦截**：`FAIL_REPEAT_LIMIT = 3`，同一会话连续 3 次工具失败直接收尾（拦"失败就重试"循环）
- **新增重复规划拦截**：`PLAN_CALL_LIMIT = 2`，plan_workflow 超出上限直接拦截

### 2. 堵住循环漏洞（iteration-counter.ts + save.tool.ts，对应根因 1）

- **删除 `resetIteration`**：迭代计数只增不减，save 不再清零，`iterationLimitMessage` 从死代码恢复为可达路径
- **save 新增 workflowHandle 参数**：支持句柄化保存（generate → save 链路不再需要 LLM 背诵大 JSON），save 成功后从缓存 remove handle
- 同步删除死代码 `isIterationExceeded`

### 3. 删除 update_workflow 二次思考回路（update-workflow.tool.ts，对应根因 4）

- **删除 fixInstruction 路径**：PARSE_SYSTEM_PROMPT、PARSE_FAIL_MESSAGE 常量、`chatStructured` 内嵌 LLM 解析全部删除；`operations` 成为唯一入口，零解析、零额外 LLM 调用
- **errors 口吻改"停一下"**："已生效的部分无需重提，如需继续请只针对未生效项提交新的 operations"
- 删除死代码 `summarizeNodes`

### 4. 工具返回瘦身（generate/batch-validate，对应根因 3）

- **generate_workflow**：新增 `workflowHandle` 写缓存；`warnings` 置空数组——前端 App.tsx 的 parseGenerateOutput 依赖 `workflow`/`validation` 字段渲染右侧面板，JsonPreview.tsx 直接访问 `validation.warnings.length`，故保留字段但不塞内容
- **batch_validate**：description 删除"accuracy < 100% 就 update_workflow 再验证"闭环，改为"返回结果用于向用户汇报验证结论；如需修复需另行调用 update_workflow（受系统迭代上限约束）"

### 5. 残留清理（operations.schema.ts + index.ts + apply-operation.spec.ts，对应根因 4）

- 删除 `UpdateOperationsParseSchema`、`normalizeOperations` 及其 6 个单测（fixInstruction 路径已不存在）

### 验证结果

- `pnpm typecheck`：6/6 通过
- `pnpm build`：4/4 通过
- `npx vitest run`：20/20 通过（apply-operation.spec.ts）
