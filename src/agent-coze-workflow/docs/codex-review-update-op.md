# codex 审查报告：update_workflow 操作化重构方案（op 化）

> 审查对象：`docs/update-workflow-op-design.md`（v0.1，2026-08-16）
> 审查方式：逐条对照代码事实（update-workflow.tool.ts / code-generator.ts / iteration-counter.ts / workflow-cache.ts / schema-converter.ts / generator.ts / workflow-schema types）
> 结论先行：**方向正确，v0.1 不能直接落地**——存在 2 个致命问题（branches 值形状与代码事实不符、set 的 value 无类型校验）、6 个重要问题（delete_node 无拓扑防护、rewrite_code 数据优先级、set_ref 定位歧义、推荐路径颠倒、解析矛盾表述、白名单缺 startInputs）。

---

## 一、总体结论

op 化（LLM 输出结构化操作指令、代码确定性执行）**是对的方向**：它把"type 枚举膨胀 + 每 type 一套正则猜句式"收敛为"5 种语义操作 + 字段白名单"，执行层从此零解析，且现状最大痛点（改模型没有独立 type，被归入 llm_prompt 后模型名被错误写进提示词）由 `set config.model` 精确修复。但方案把"猜"的环节原样保留在了 fixInstruction → operations 的 LLM 解析里（方案 2.5 自己承认），所以它解决的不是"猜不猜"而是"谁猜、猜错后怎么办"：LLM 猜 + zod 错误可自我修正，优于代码正则猜 + 静默失败。在这个定位下，v0.1 的骨架可以接受，但**存在两处会让功能"落地即坏"的设计错误必须修正**（branches 值形状沿用现状 bug；set 的 value 类型完全不校验），以及 delete_node 缺拓扑防护、set_ref 定位歧义等可靠性问题。建议修正后分期落地：一期 set + set_ref + rewrite_code（修复型 op），二期 delete_node/delete_edge（破坏型 op，需要拓扑校验与撤销机制）。

---

## 二、分项判定表（A–E，16 条）

### A. 方案方向

| # | 焦点 | 判定 | 理由与证据 | 修改建议 |
|---|---|---|---|---|
| 1 | op 化是否解决"type 膨胀 + content 猜句式"根本问题 | ⚠️ | 解决一半。执行层确定化是真实收益：现状 `applyOneInstruction`（update-workflow.tool.ts:193-407）每个 type 一套正则（threshold 的 `/(\d+\.?\d*)\s*[改为→]\s*(\d+\.?\d*)/`、output_field 的标识符提取 + stopWords + strict 正则），op 化后这些全部消失。但方案 2.5 自认"唯一的'猜'点"仍在——fixInstruction 自然语言 → operations 仍靠 LLM 解析，问题从"代码猜"转移为"LLM 猜"。本质收益是**失败模式改善**而非消灭解析：zod 校验失败时 LLM 能拿到精确错误并自我修正，正则猜错则是静默错结果 + 重新组织语言再试（多耗一轮 token + 一次迭代计数）。 | 方案表述改为"解析与执行分离、执行确定化"，不要宣称"代码零解析执行"（解析仍在，只是换到 LLM 侧）。 |
| 2 | LLM 直接输出 `{op, field, value}` 对 DeepSeek 的 zod 校验成功率升还是降 | ⚠️ | 无实测依据。结构性推断：5 op discriminatedUnion vs 现状 7 type enum + 自由 content，op 字段本身是强引导信号，理论上成功率持平或略升；但 v0.1 的 `value: unknown` 使 set 的校验反而弱于现状（content 至少有 string 类型）。现状 `parseInstructions` 失败率无任何统计（失败返回 null → PARSE_FAIL_MESSAGE，update-workflow.tool.ts:134-136）。 | 落地前用 20–30 条真实历史 fixInstruction 做回放对比（旧 schema vs 新 schema），记录解析成功率与 token 消耗；DeepSeek 对嵌套 discriminatedUnion + 数组元素 union 的支持必须实测（本项目已有"LLM 输出数组/包裹形态"的历史教训，见 UpdateInstructionsSchema 三种形态兼容）。 |
| 3 | 有没有更简单的替代方案 | ⚠️ | 有，且方案未做取舍说明。① **最小改动**：不动 op 化，只把 content 结构化——threshold 加 oldValue/newValue、output_field 加 oldName/newName 字段，其他 type 不变，约 50 行，解决"猜句式"80% 痛点，可作为止血版本。② **JSON Patch（RFC 6902）**：语义标准，但 path 面向 JSON 指针（如 `/nodes/0/config/model`），本项目节点定位靠 title/id（findTargetNode，update-workflow.tool.ts:144-153），需自建 path→节点映射，等于再造一层解析；且任意 path 使白名单失效（LLM 可改任何字段），安全性反降。 | op 化比 JSON Patch 更适合（领域语义 + 白名单 + title 定位），但应把此取舍写进方案。若目标是快速止血，先做①再上 op 化。 |

### B. op 设计

| # | 焦点 | 判定 | 理由与证据 | 修改建议 |
|---|---|---|---|---|
| 4 | 5 种 op 是否覆盖所有修改场景 | ⚠️ | 有遗漏。**改 startInputs**（start 节点输入声明）没有对应 op 也没有白名单字段，"输入改成 X"是高频需求；**改边端口**（condition 分支边 sourcePort 重排 true/true_1/false）无法表达。批量改由 operations 数组覆盖 ✅。方案六明确不做 add_node/move 可接受，但需写明代价：delete_node 是破坏性 op，删掉无法用 op 恢复（只能重新生成），缓存 dirty 未保存前无撤销手段。 | 补 startInputs 白名单；边端口重排列入"不做的事"并说明；delete_node 增加防护（见 #7）或明确"删除后只能重新生成"的语义。 |
| 5 | set 的 value 是 unknown，zod 如何校验值类型 | ❌ | **致命**。`value: unknown` 使 zod 只校验 op/field 枚举，值类型完全不校验：config.model 传对象、branches 传字符串都能通过，运行时污染数据，converter 崩溃或静默降级（modelTypeFor 查不到默认 201，schema-converter.ts:73-77）。白名单只拦"改哪个字段"、不拦"改成什么"，形同虚设。 | 按值类型分组定义 value schema：字符串组（config.model/userPrompt/systemPrompt/code/language）→ `z.string()`；数组组（branches/outputs/outputVariables/startInputs）→ `z.array(...)`；any 组（data）→ `z.unknown()`。实现上 zod 无法在 discriminatedUnion 内按 field 字符串值再分派，可用"field 字面量拆分 union"（9 个 field 9 个分支，冗长但类型安全）或"field enum + superRefine 校验 field×类型配对"（简洁，错误信息需明确）。 |
| 6 | set_ref 与 set field=outputVariables 是否重叠 | ⚠️ | 重叠确认。两者都能改结束节点 outputVariables，LLM 面临选择歧义：set 传完整数组（输出负担重、易丢已有字段），set_ref 定向改单个 value（更精准但 v0.1 定位规则含糊）。且 `outputName` 是可选的，验收标准却写"set_ref → outputVariables[0].value 更新"，隐含"默认改第一个"——与多输出结束节点冲突（converter 2026-08-16 已支持多输出，schema-converter.ts:240-243）。 | 保留两个但明确分工写入 describe：set outputVariables = 整体重写数组声明；set_ref = 定向改某一个 outputVariable 的 value 引用（不动 name、不动其他元素）。`outputName` 改为**必填**，按 name 定位，找不到返回明确错误。 |
| 7 | delete_node 级联删边后的拓扑问题 | ⚠️ | 级联删边函数本身正确（过滤 source/target 匹配的边，方案 3.2），但**只删边不修拓扑**，四种遗留问题：① 删 condition 节点→其上游节点（如 start）出边全断，validate_tree 失败；② 删 LLM 的下游节点→LLM 的 default 边被删，只剩 branch_error 边，平台约定 LLM 必须有 default+branch_error 双出边（generator.ts createLLMEdges:224-238），validate_tree 大概率失败；③ 删 end/start 节点未禁止——end=900001 是平台固定约定（schema-converter.ts:141-143），删后整个工作流无出口；④ 其他节点 inputMapping 里引用被删节点输出的字符串（generator buildInputMapping 生成 "sourceNodeId.outputName"）悬空。方案边界表只处理了"删除不存在的节点/边"。 | delete_node/delete_edge 执行后立即跑本地 `validateWorkflow`（packages/workflow-schema 已有 MISSING_SOURCE_NODE/MISSING_TARGET_NODE 检查，validator/index.ts:130-141），拓扑错误回传给 LLM 触发补边指令；禁止删除 start/end 节点；删 LLM 下游节点时提示 LLM 补 default 边。 |
| 8 | FieldPath 白名单够不够 | ⚠️ | 基本够但两处问题。**缺 startInputs**（与 #4 同源）；database_query 的 connection/queryDescription、http 的 method/url、text 的 concatResult（plan-prompt.ts:124-126 提到的节点配置）未纳入——但白名单越窄越安全，可按实际场景迭代补充。**致命点**：方案 2.3 表 branches 示例 `[{label, condition}]` 与代码事实不符——generator 实际生成 `{expression, targetNodeId}`（generator.ts:703-709），converter 读的是 `branches[].expression`（schema-converter.ts:485）。现状 update-workflow.tool.ts:254 写 `node.branches = [{label:"match", condition:...}]` 正是现有 bug（改条件后 converter 读不到 expression，save 后条件丢失）。方案沿用了这个错误形状。 | 白名单补 startInputs；branches 值形状统一为 `{expression, targetNodeId}`，并定义改 branches 时 targetNodeId 的处理规则（LLM 提供完整数组 or 保留旧 targetNodeId 只改 expression）。 |

### C. 解析与兼容

| # | 焦点 | 判定 | 理由与证据 | 修改建议 |
|---|---|---|---|---|
| 9 | fixInstruction → operations 是否从"猜句式"变"猜 op" | ⚠️ | 是，本质没有消除 LLM 解析环节，但**失败模式确实改善**（见 #1）。真正的分歧点：方案 2.4 提供 operations 参数可跳过解析，却写"推荐走 fixInstruction 让工具解析"——推荐反了。多一次 chatStructured = 多一次失败面 + 多一次延迟 + 多一轮 token。LLM 在 createReactAgent 上下文里已有节点摘要，完全有能力直接组织 operations。 | **反转路径**：operations 直传为主路径（零解析、零额外 LLM 调用），fixInstruction 作为兼容/人读入口（调用方不传 operations 时才解析）。schema describe 相应调整。 |
| 10 | 旧 `{type, target, content}` 是否兼容 | ✅ | 旧调用方只有 LLM（工具是 createReactAgent 内部 tool，无外部 API 消费者），tool schema 随代码部署同步更新，无兼容包袱。方案 3.1 的"兼容层：可选"纯属多余。fixInstruction 自然语言入口已是最佳兼容（LLM 说人话的路径不断）。 | 删除兼容层。 |
| 11 | rewrite_code 的 referenceData 从哪来 | ⚠️ | 现状链路：工具参数 referenceData > 节点已有 referenceData > 无则警告生成（update-workflow.tool.ts:219-247）。方案 3.3 原样沿用。问题：句柄化后 LLM 上下文里没有原始歌词库，LLM 传的 operations[].referenceData 只能脑补或省略——而 fallback 链最后一级"仍生成但返回警告"就是丢数据的根源。真正可靠的数据源是**服务端缓存节点已有的 referenceData**（真实数据，LLM 看不见但工具拿得到）。 | **优先级反转**：① 节点已有 referenceData 工具侧强制注入（LLM 不可控）；② 工具参数 referenceData（用户新提供的数据）；③ 两者都无 → **拒绝生成**并返回明确错误（"无参考数据，请提供后再重写"），废除"仍生成+警告"路径。operations[].referenceData 仅保留"用户提供新参考数据"语义。 |
| 12 | 迭代计数与 op 化结合 | ✅ | 方案边界表"仅当至少一条操作成功时 +1，全部失败不消耗"与现状代码一致（update-workflow.tool.ts:512-522：changes 为空提前 return 不 increment，有 changes 才 increment）✅。附带发现一个现状 off-by-one：入口判断用 `iteration > MAX_ITERATIONS`（update-workflow.tool.ts:412-415），计数 0→1→2→3 时均放行，实际允许第 4 次调用。另"部分成功（哪怕 1 条）也 +1"可能鼓励 LLM 挤牙膏式小改，save 成功后 reset 已兜底，可接受。 | 保持现状策略；顺手把入口判断修为 `iteration >= MAX_ITERATIONS` 拒绝（语义与注释"达到上限"一致）。 |
| 13 | 缓存 dirty 标记与 converter 消费 | ⚠️ | dirty 链路：现状仅在 fromCache 时 markDirty（update-workflow.tool.ts:517-519），方案 3.1 只写"标记缓存 dirty"，需明确保持 fromCache 条件（参数传入 workflow 的场景无缓存可标）✅ 可实现。converter 消费：end 节点优先用 outputVariables 显式 value（schema-converter.ts:243-253，regex `/^([^.{}]+)\.(.+)$/`），set_ref 改 outputVariables 后 save 会被正确消费，无需动 code ✅。**但两个坑**：① ref 值格式无 zod 校验——传了不合格式的值，converter 的 refMatch 匹配失败会**静默 fallback** 到"上游边查找"（schema-converter.ts:168-179），LLM 以为改成功实际接错节点；② 方案边界表"set_ref 目标不是结束节点：允许"——converter 只消费 end 节点的 outputVariables（isEnd 分支），改非 end 节点无任何效果，这是误导。 | ref 值加 zod regex 校验（如 `/^[^.{}]+\.[^.{}]+$/`）；set_ref 限定 end 节点（改其他节点输出声明走 `set field=outputs`）；set_ref 执行时校验 ref 前缀节点 ID 存在。 |
| 14 | 与"结束节点接线（contract.outputs.source）"是否冲突 | ✅ | 不冲突，是同构补强。生成期：plan-prompt.ts:80-83 要求 end step 的 contract.outputs 带 source，generator 据此生成 outputVariables 的 value="nodeId.outputName"；修复期：set_ref 定向改这个 value，正是"重新接线"的最小操作单元。两者机制同构、字段同源，无冲突。唯一注意：改 ref 不改 edges（end 的入边仍指向旧上游），converter 优先消费显式 value 不 fallback，但平台 validate_tree 是否要求"边与引用一致"需实测验证。 | 验收标准补一条：set_ref 后 save 成功且 end 节点返回新引用的输出。 |

### E. 落地

| # | 焦点 | 判定 | 理由与证据 | 修改建议 |
|---|---|---|---|---|
| 15 | 改动范围（一个文件重写）是否可控 | ✅ | 可控但单文件会过重：update-workflow.tool.ts 现 577 行，op 化后（9 field × 值类型 schema + 5 op 实现 + 解析 + 汇总）预计 700+ 行。且纯函数与工具壳混在一个文件里，无法单测。 | 拆三模块：`operations/operations.schema.ts`（UpdateOperationSchema、FIELD_PATHS、FieldValueSchemas）、`operations/apply-operation.ts`（applyOperation 纯函数：workflow+op → {workflow, changes}，全部 op 逻辑可单测）、update-workflow.tool.ts 保留工具壳（缓存/stale/计数/汇总）。 |
| 16 | 验收标准单测用例覆盖 | ⚠️ | 方案五.2 只列 5 个 happy path + 1 个部分失败，且是"单元**手测**"（无自动化）。缺关键边界用例（对应上述问题）：非法 field、值类型不符、ref 格式非法、outputName 未匹配、rewrite_code 非 code 节点、无 referenceData 拒绝路径、delete_node 不存在节点/删 start/end 禁止/删后拓扑断链提示、delete_edge 不存在边、全部失败不消耗计数、部分成功计数、branches 改 expression 后 save→validate_tree 通过的回归（覆盖现状 label/condition bug）。 | 引入 vitest（或项目已有测试框架），applyOperation 拆纯函数后每个 op 至少 3 用例（happy/失败/边界）；补上列出的边界用例。 |

---

## 三、问题清单（按严重度）

### 致命（不修则方案落地即坏）

| # | 问题 | 影响 |
|---|---|---|
| F1 | branches 值形状沿用 `{label, condition}`（方案 2.3），与 generator 实际输出 `{expression, targetNodeId}`（generator.ts:703-709）及 converter 读取（schema-converter.ts:485）不符 | `set field=branches` 落地即无效：改了条件但 save 时 converter 读不到，且现状 update_workflow 的 condition 分支（update-workflow.tool.ts:254）就是这个 bug 的现行犯 |
| F2 | set 的 `value: unknown` 无类型校验 | 白名单只防字段名不防值类型：config.model 传对象、branches 传字符串均通过 zod，运行时污染数据、converter 崩溃或静默降级（modelTypeFor 兜底 201） |

### 重要（影响正确性与可靠性）

| # | 问题 | 影响 |
|---|---|---|
| I1 | delete_node/delete_edge 只级联删边、无拓扑校验与防护 | 删 condition/LLM 下游节点导致上游断链或 LLM 缺 default 边，save 时 validate_tree 失败；可删 start/end 使工作流无入口/出口 |
| I2 | rewrite_code 的 referenceData 优先级沿用现状（工具参数 > 节点已有 > 无则警告生成） | 句柄化后 LLM 无原始数据，每次 rewrite 都有丢歌词库常量的风险，"仍生成+警告"路径就是丢数据根源 |
| I3 | set_ref 的 outputName 可选 + 默认改 [0] + 允许非 end 节点 + ref 无格式校验 | 多输出结束节点改错位置；改非 end 节点无效果（converter 只消费 end）；ref 格式错时 converter 静默 fallback，LLM 误判成功 |
| I4 | 推荐路径颠倒（fixInstruction 解析为主，operations 直传为辅） | 每次更新多一次 chatStructured：多一次失败面、多一次延迟、多一轮 token |
| I5 | 2.5"其余 → set（字段名从 context 匹配）"与"代码零解析"自相矛盾 | "从 context 匹配字段名"就是解析，且最难的恰是这步；应改为解析失败报错而非兜底猜测 |
| I6 | 白名单缺 startInputs | "输入改成 X"类指令无法表达 |

### 建议（优化项）

| # | 问题 | 影响 |
|---|---|---|
| S1 | 单文件重写 + 验收仅"单元手测" | 无法自动化回归，op 越多回归成本越高 |
| S2 | 迭代计数 off-by-one（`> MAX_ITERATIONS` 实际允许 4 次） | 上限形同虚设 1 次，顺手修 |
| S3 | 无实测数据支撑"zod 成功率升"论断 | 无法判断 op 化对 DeepSeek 解析成功率真实影响 |
| S4 | 兼容层（3.1 末、3.4）多余 | 旧调用方只有 LLM，部署即更新，纯维护负担 |
| S5 | delete_node 无撤销手段（不做 add_node/move） | LLM 误删后只能重新生成整个工作流，成本高 |

---

## 四、最终推荐方案（修正后的完整设计）

在 v0.1 基础上修正，核心骨架不变（5 op + 白名单 + 逐条执行 + 部分失败不中断）。

### 4.1 UpdateOperation（修正）

```ts
// 值类型分组：白名单防字段名 + 分组防值类型
const STRING_FIELDS = ["config.model", "userPrompt", "systemPrompt", "code", "language"] as const;
const ARRAY_FIELDS = ["branches", "outputs", "outputVariables", "startInputs"] as const;
const ANY_FIELDS = ["data"] as const;

type UpdateOperation =
  // set：field 枚举白名单 + superRefine 校验 field×值类型配对
  | { op: "set"; target: string; field: FieldPath; value: unknown } // 内部 superRefine：
    // STRING_FIELDS → z.string()；ARRAY_FIELDS → z.array(z.object(...))；ANY_FIELDS → 任意 JSON
  // set_ref：outputName 必填；ref 格式 regex 校验；target 限定 end 节点
  | { op: "set_ref"; target: string; outputName: string; ref: string } // ref: /^[^.{}]+\.[^.{}]+$/
  // rewrite_code：referenceData 工具侧强制注入（见 4.3），LLM 传的仅作"新参考数据"语义
  | { op: "rewrite_code"; target: string; logicDescription: string; referenceData?: Record<string, string> }
  // delete_node：禁止 start/end；删后跑本地 validateWorkflow（见 4.4）
  | { op: "delete_node"; target: string }
  // delete_edge：删后同样校验拓扑
  | { op: "delete_edge"; source: string; target: string };
```

### 4.2 branches 值形状修正（对齐 converter）

- branches 元素统一 `{ expression: string; targetNodeId: string }`（generator.ts:703-709 的输出形状）。
- `set field=branches` 时要求 LLM 输出完整数组；仅改条件表达式时可省略 targetNodeId，工具侧保留旧值只替换 expression。
- 顺带修现状 bug：update-workflow.tool.ts:254 的 `{label:"match", condition}` 改为 expression 形状。

### 4.3 rewrite_code 数据保障（优先级反转）

1. 节点已有 referenceData（服务端缓存，真实数据）→ 工具侧强制注入，LLM 不可覆盖；
2. 工具参数 referenceData → 用户新提供的数据，合并注入；
3. 两者都无 → 拒绝生成，返回"无参考数据，请先提供歌词库/数据后再重写"（废除"仍生成+警告"路径）。
- 类型签名对齐代码事实：CodeGenerator.generateCode 的 referenceData 是 `Record<string, string>`（code-generator.ts:94），方案 2.1 的 `Record<string, any>` 写错。

### 4.4 删除操作拓扑防护

- 禁止删除 start/end 节点（返回明确错误）。
- delete_node/delete_edge 执行后立即调本地 `validateWorkflow`（packages/workflow-schema），拓扑错误随 changes/errors 回传 LLM（如"上游节点 X 断链，请补边或改删除目标"）。
- 删除 LLM 下游节点时额外提示：LLM 节点缺 default 出边会 validate_tree 失败。

### 4.5 调用路径反转

- operations 直传为主路径（schema describe 优先引导 LLM 直接组织 op）；
- fixInstruction 为兼容入口：未传 operations 时才走 chatStructured 解析；
- 解析失败（含"无法归类"）→ 返回明确错误要求 LLM 明确 op，**不做"其余 → set（从 context 猜字段）"兜底**。

### 4.6 文件拆分与落地顺序

- `operations/operations.schema.ts`：UpdateOperationSchema、FIELD_PATHS、FieldValueSchemas、superRefine 校验；
- `operations/apply-operation.ts`：applyOperation 纯函数（可单测全部 op）；
- `update-workflow.tool.ts`：工具壳（缓存/stale/计数/汇总），删除兼容层；
- 迭代计数入口判断修为 `>= MAX_ITERATIONS`。

**分期**：一期 set + set_ref + rewrite_code（修复型 op，风险低）；二期 delete_node/delete_edge（破坏型 op，依赖 4.4 拓扑校验与实测 validate_tree 行为）。验收标准补 4.3/4.4 的边界用例并升级为自动化单测（vitest）。

---

## 五、方案里写错 / 与代码事实不符的地方（逐条）

| # | 方案原文（位置） | 代码事实 | 说明 |
|---|---|---|---|
| 1 | 2.3 表：改条件分支 `value:[{label,condition}]` | generator.ts:703-709 生成 `{expression, targetNodeId}`；schema-converter.ts:485 读 `branches[].expression` | **沿用现状 bug**：update-workflow.tool.ts:254 写 `{label:"match", condition}` 后 converter 读不到，save 条件丢失。必须改 expression 形状 |
| 2 | 2.1：`referenceData?: Record<string, any>` | code-generator.ts:94 签名 `referenceData?: Record<string, string>` | 类型写错（现状工具层是 `Record<string, any>`，但 CodeGenerator 收窄为 string 值） |
| 3 | 2.5："其余 → set（字段名从 context 匹配）或 other" | update-workflow.tool.ts:478-484 现状对"无法归类"（type=other）的处理是过滤 + 全空时报错 | "从 context 匹配字段名"是新引入的兜底解析，与方案"代码零解析"自相矛盾；应改为报错 |
| 4 | 2.4：schema 里 `referenceData` 参数"可选"、3.4"旧工具调用（如 workflow 参数）保留 optional 兼容" | workflow 参数是句柄化降级路径（update-workflow.tool.ts:418-431），与 type/content 无关 | workflow 参数保留是对的，但表述把"workflow 参数兼容"与"type/content 兼容"混为一谈；后者应删除（见 C10） |
| 5 | 边界表："set_ref 目标不是结束节点：允许" | schema-converter.ts:237-248 只消费 isEnd 分支的 outputVariables | 改非 end 节点 outputVariables 无任何效果，允许是误导；应限定 end 节点 |
| 6 | 五.2 验收标准："set_ref → outputVariables[0].value 更新" | schema-converter.ts:240-243 已支持多输出结束节点 | 隐含"默认改第一个"与多输出冲突；outputName 应必填定位 |
| 7 | 2.2：白名单无 startInputs | plan-prompt.ts:77-83 与 types 里 start 节点有输入声明 | "输入改成 X"无法表达，需补 |
| 8 | 边界表："迭代计数：仅当至少一条操作成功时 +1" | update-workflow.tool.ts:512-522 现状一致 ✅；但入口判断 `iteration > MAX_ITERATIONS`（:412-415）存在 off-by-one，实际允许第 4 次调用 | 方案未提此现状缺陷，重构时顺手修 |
| 9 | 1.1 现状接口示例注释 "type 猜不中改模型" | update-workflow.tool.ts:45-59 枚举无 model 类型；llm_prompt 分支（:194-209）把 content 直接写入 userPrompt/systemPrompt | 方案背景属实且未深挖：现状"改模型"会把模型名写进提示词（严重错误行为），这正是 op 化最大价值点，应写入 1.2 缺陷表作为设计动机 |
| 10 | 3.1：rewrite_code "CodeGenerator.generateCode(logicDescription, inputs, referenceData)" | code-generator.ts:91-95 第二参数是 inputs（string[]），现状调用处（update-workflow.tool.ts:227-243）第二参传的是 undefined | 方案未说明 op 化后 inputs 从哪来（节点 inputMapping 的 keys 可推导），不写清则生成代码拿不到输入变量名，只能走兜底模板 |

---

*审查结论：方案方向 ✅，v0.1 需按第四节修正后方可实施（F1/F2 为硬性前置条件）。全程未改任何代码。*
