# update_workflow 操作化重构方案（v0.2）

> 状态：待评审（志武）→ 待实施
> 日期：2026-08-16
> 背景：update_workflow 反复打补丁（type 枚举膨胀 + content 自然语言靠正则猜），每次发现新场景加一个分支，治标不治本。本方案重新设计抽象层：LLM 输出精确操作指令（op），代码确定性执行。
> v0.2 变更：吸收 codex 审查（docs/codex-review-update-op.md）——修正 F1/F2 致命问题 + 8 个重要问题，op 化升级为"工作流 op 流水线"（原子性/可逆/日志/渐进式结合）。

---

## 一、现状问题（打补丁的代价）

### 1.1 当前接口设计

```ts
// 现状：type 枚举 + content 自由文本 + 正则猜句式
{ type: "llm_prompt", target: "LLM 处理", content: "将模型设置为 Qwen3.5-Omni-Plus" }
//      ↑ type 猜不中改模型               ↑ content 是自然语言，每个 type 要写解析器
```

### 1.2 已打的补丁（问题清单）

| # | 补丁 | 暴露的缺陷 |
|---|---|---|
| 1 | 加 `output_field` type | 改输出字段没有 type，只能归 other |
| 2 | output_field 宽容解析（自然语言句式） | content 句式无穷，正则追不完 |
| 3 | code_logic 放宽"重写"关键词 | 改代码被关键词卡死 |
| 4 | 支持 modifications 数组 | LLM 自然输出数组，单对象 schema 装不下 |
| 5 | 兼容 `{modifications: [...]}` 包裹 | LLM 又包了一层 |
| 6 | code_logic 加 referenceData 参数 | LLM 把数据塞 content 导致失败 |

**模式**：每个补丁都是"LLM 又冒出一种新表达 → 解析器加一种兼容"。**根因是让 LLM 输出"意图+自然语言"，而自然语言无法穷举。**

### 1.3 根本缺陷

1. **type 枚举是"死的"**：改模型 ≠ 改 prompt，但都归 llm_prompt → 语义混
2. **content 靠猜**：每个 type 一套正则，猜错就失败，失败 LLM 就重试/放弃/重新生成（浪费 token）
3. **改字段与改结构混淆**：set 字段、改引用、重写代码、删节点是不同操作，混在一个 type 里

---

## 二、新设计：操作化指令（op 化）—— 工作流 op 流水线

### 2.1 核心思想

**LLM 不输出"意图 + 自然语言"，而是输出精确的操作指令**（结构化字段，zod 强校验，代码确定性执行）。

```ts
// 值类型分组：白名单防字段名 + 分组防值类型（codex F2 修复）
const STRING_FIELDS = ["config.model", "userPrompt", "systemPrompt", "code", "language"] as const;
const ARRAY_FIELDS = ["branches", "outputs", "outputVariables", "startInputs"] as const;
const ANY_FIELDS = ["data"] as const;

type UpdateOperation =
  // set：field 枚举白名单 + superRefine 校验 field×值类型配对
  | { op: "set"; target: string; field: FieldPath; value: unknown }
  //    ↑ 内部 superRefine：STRING_FIELDS → z.string()；ARRAY_FIELDS → z.array(...)；ANY_FIELDS → 任意 JSON
  // set_ref：outputName 必填；ref 格式 regex 校验；target 限定 end 节点（codex I3 修复）
  | { op: "set_ref"; target: string; outputName: string; ref: string }
  //    ↑ ref: /^[^.{}]+\.[^.{}]+$/（如 "node_xxx.result"）
  // rewrite_code：referenceData 工具侧强制注入（见 4.3），LLM 传的仅作"新参考数据"语义
  | { op: "rewrite_code"; target: string; logicDescription: string; referenceData?: Record<string, string> }
  // delete_node：禁止 start/end；删后跑本地 validateWorkflow（见 4.4）
  | { op: "delete_node"; target: string }
  // delete_edge：删后同样校验拓扑
  | { op: "delete_edge"; source: string; target: string };
```

### 2.2 FieldPath 白名单（防 LLM 乱改任意字段）

```ts
const FIELD_PATHS = [
  "config.model",        // 模型名
  "userPrompt",          // LLM 用户提示词
  "systemPrompt",        // LLM 系统提示词
  "code",                // 代码节点代码（整段替换）
  "language",            // 代码语言
  "branches",            // 条件节点分支
  "outputs",             // 节点输出声明
  "outputVariables",     // 结束节点输出变量
  "startInputs",         // 开始节点输入声明（codex I6 补）
  "data",                // 数据常量
] as const;
type FieldPath = (typeof FIELD_PATHS)[number];
```

### 2.3 操作 → 场景覆盖对照表

| 修改需求 | 操作指令 |
|---|---|
| 改 LLM 提示词（user/system） | `{op:"set", field:"userPrompt" 或 "systemPrompt", value:"..."}` |
| 改模型 | `{op:"set", field:"config.model", value:"Qwen3.5-Omni-Plus"}` |
| 改代码逻辑 | `{op:"rewrite_code", logicDescription:"...", referenceData?:{...}}` |
| 改代码常量/数据 | `{op:"set", field:"code" 或 "data", value:"..."}` |
| 改条件分支 | `{op:"set", field:"branches", value:[{expression, targetNodeId}]}`（⚠️ 形状是 expression，不是 label/condition，见 4.2） |
| 改阈值（代码/条件里） | `{op:"set", field:"code" 或 "branches", value:"..."}` |
| 改输出字段名 | `{op:"set", field:"outputs", value:[{name,type}]}` |
| 改结束节点输出引用 | `{op:"set_ref", outputName:"final", ref:"node_xxx.result"}` |
| 改开始节点输入 | `{op:"set", field:"startInputs", value:[{name,type}]}` |
| 删除节点 | `{op:"delete_node", target:"条件判断"}`（禁止 start/end，删后拓扑校验） |
| 删除边 | `{op:"delete_edge", source:"A", target:"B"}` |

### 2.4 接口形态（工具 schema）

```ts
schema: z.object({
  workflowId: z.string(),
  // operations 直传为主路径（零解析、零额外 LLM 调用，codex I4 反转）
  operations: z.array(UpdateOperationSchema).describe("结构化修改操作列表（推荐）"),
  // fixInstruction 为兼容/人读入口：未传 operations 时才走 chatStructured 解析
  fixInstruction: z.string().optional().describe("自然语言修改指令（可选，operations 未传时用）"),
  referenceData: z.record(z.string(), z.any()).optional().describe("用户新提供的参考数据"),
})
```

**调用路径（codex I4 反转）**：
```
主路径：LLM 直接输出 operations 数组 → 逐条执行（零解析）
兼容路径：fixInstruction → chatStructured 解析为 operations → 逐条执行
```

### 2.5 解析失败策略（codex I5 修复）

解析失败 → 返回明确错误要求 LLM 明确 op（"无法将指令归类为 set/set_ref/rewrite_code/delete_node/delete_edge，请直接输出 operations"），**不做"其余 → set（从 context 猜字段）"兜底**——猜字段是解析，与"代码确定性执行"矛盾。

---

## 三、实现要点

### 3.1 文件拆分（codex S1：单文件重写不可控，拆三模块）

```
apps/api/src/agent/operations/
├── operations.schema.ts   # UpdateOperationSchema、FIELD_PATHS、FieldValueSchemas、superRefine 校验
├── apply-operation.ts     # applyOperation 纯函数：workflow+op → {workflow, changes}（全部 op 可单测）
└── index.ts               # 导出

apps/api/src/agent/tools/update-workflow.tool.ts  # 工具壳：缓存/stale/计数/汇总，删除兼容层
```

### 3.2 删除节点级联 + 拓扑校验（codex I1 修复）

```ts
function deleteNode(nodes, edges, targetId) {
  const newNodes = nodes.filter((n) => n.id !== targetId);
  const newEdges = edges.filter(
    (e) => e.sourceNodeId !== targetId && e.targetNodeId !== targetId,
  );
  return { newNodes, newEdges };
}

// 执行后立即本地校验（codex I1）：
// - 禁止删除 start/end 节点
// - validateWorkflow 检查拓扑断链（MISSING_SOURCE_NODE/MISSING_TARGET_NODE）
// - 删 LLM 下游节点时提示：LLM 缺 default 出边会 validate_tree 失败
```
```

### 3.3 rewrite_code 数据保障（codex I2：优先级反转）

1. **节点已有 referenceData（服务端缓存，真实数据）→ 工具侧强制注入，LLM 不可覆盖**
2. 工具参数 referenceData → 用户新提供的数据，合并注入
3. 两者都无 → **拒绝生成**，返回"无参考数据，请先提供歌词库/数据后再重写"（废除"仍生成+警告"路径）

类型签名对齐代码事实：`CodeGenerator.generateCode` 的 referenceData 是 `Record<string, string>`（code-generator.ts:94）。

### 3.4 branches 值形状修正（codex F1：对齐 converter）

- branches 元素统一 `{ expression: string; targetNodeId: string }`（generator.ts:703-709 输出形状，converter 读 `branches[].expression`，schema-converter.ts:485）
- `set field=branches` 时 LLM 输出完整数组；仅改条件表达式时可省略 targetNodeId，工具侧保留旧值只替换 expression
- **顺带修现状 bug**：update-workflow.tool.ts:254 的 `{label:"match", condition}` 改为 expression 形状

### 3.5 调用路径（codex I4 反转）

- **operations 直传为主路径**（schema describe 优先引导 LLM 直接组织 op）
- fixInstruction 为兼容入口：未传 operations 时才走 chatStructured 解析
- 解析失败 → 返回明确错误要求 LLM 明确 op，不做"其余→set 猜字段"兜底

### 3.6 兼容旧接口

- workflow 参数保留（句柄化降级路径）
- 删除旧 type/content 兼容层（旧调用方只有 LLM，部署即更新，codex S4）

---

## 四、边界情况

| 场景 | 处理 |
|---|---|
| 多条操作部分失败 | 逐条执行，成功的生效，失败的汇总 errors（不中断） |
| 全部失败 | 返回错误列表，不消耗迭代计数 |
| 删除不存在的节点/边 | 返回明确错误"未找到节点 X"，不中断其他操作 |
| 删除 start/end 节点 | 禁止（返回明确错误，codex I1） |
| 删除后拓扑断链 | 立即 validateWorkflow，错误随 errors 回传 LLM 触发补边 |
| set 非法 field | zod 校验拦截，错误信息告诉 LLM 合法字段列表 |
| set 值类型不符（config.model 传对象等） | superRefine 校验拦截（STRING_FIELDS→string，ARRAY_FIELDS→array，codex F2） |
| set_ref 目标不是结束节点 | 限定 end 节点（converter 只消费 end 的 outputVariables，codex I3） |
| set_ref outputName 未匹配 | 返回"未找到输出变量 X"（outputName 必填定位） |
| set_ref ref 格式非法 | zod regex 校验 `/^[^.{}]+\.[^.{}]+$/`，防 converter 静默 fallback（codex I3） |
| rewrite_code 目标不是代码节点 | 返回错误"节点 X 不是代码节点" |
| rewrite_code 无参考数据 | 拒绝生成，返回"请先提供参考数据"（codex I2） |
| 迭代计数 | 仅当至少一条操作成功时 +1（失败不消耗）；入口判断修 `>= MAX_ITERATIONS`（codex S2 off-by-one） |

---

## 五、验收标准

1. `npm run build` 通过。
2. **自动化单测（vitest，codex S1）**，applyOperation 纯函数每个 op ≥3 用例（happy/失败/边界）：
   - set：config.model 更新 / 非法 field 拦截 / 值类型不符拦截（F2）
   - set_ref：outputVariables 定向更新（outputName 必填）/ ref 格式非法拦截 / 非 end 节点拒绝（I3）
   - rewrite_code：referenceData 注入 / 无数据拒绝（I2）/ 非 code 节点拒绝
   - delete_node：节点+边删除 / 删 start/end 禁止（I1）/ 删后拓扑断链提示（I1）
   - delete_edge：指定边删除 / 不存在边报错
   - 多条混合：部分失败不中断 / 全部失败不消耗计数 / 部分成功计数（S2）
   - branches：expression 形状 set 后 save→validate_tree 通过（回归 F1）
3. 端到端手测：
   - 场景 A：改模型（operations set config.model）→ 生效
   - 场景 B：改结束节点输出引用（set_ref）→ 生效，save 后 end 返回新引用（I3 验收）
   - 场景 C：删条件分支节点 → 节点+边删掉，拓扑校验通过
   - 场景 D：一次改多处（模型+提示词+代码）→ 全部生效
4. 回归：原有用例（歌曲识别）update → save 链路可用。

---

## 六、不做的事（本期边界）

- 新增节点操作（`add_node`）——拓扑大改走重新生成，下阶段考虑（codex S5：delete_node 无撤销，误删只能重新生成，已加防护）
- 移动/重连节点（`move`）——同上
- 边端口重排（condition 分支 true/true_1/false）——列入不做并说明（codex B4）
- 批量节点操作（循环/批处理改造）——单独需求
- 前端改动——本期纯后端
- op 可逆/undo 与 op 日志（v0.3 渐进式构建时引入）

---

*讨论记录：2026-08-16 志武提出"每次发现问题就修改一次不对，应重新设计"；codex 审查后升级 v0.2（修正 F1 branches 形状 / F2 set 值类型 / I1 删除拓扑防护 / I2 rewrite 数据保障 / I3 set_ref 限定 / I4 调用路径反转 / I5 解析兜底 / I6 startInputs 白名单 / S1 文件拆分 / S2 计数 off-by-one）；op 化定位为"工作流 op 流水线"，v0.3 将引入 op 原子性/可逆/日志/渐进式构建结合。*
