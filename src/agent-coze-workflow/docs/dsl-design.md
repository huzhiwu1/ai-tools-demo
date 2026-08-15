# 工作流 DSL 双向设计 + 工具句柄化改造方案

> 版本：v0.1（讨论稿）
> 日期：2026-08-15
> 状态：待评审（未落地）
> 关联：planner.ts 两段式、update-workflow.tool.ts、schema-converter.ts、react-agent.service.ts

---

## 一、背景与问题

### 问题 A：planner 骨架 JSON 对复杂工作流脆弱

- 现状：LLM 输出骨架 JSON（steps + contracts 内嵌），复杂工作流时嵌套深、dependencies 用数组下标引用易错、元信息字段（name/goal/mode/needXxx/constraints）占约 40% token 且冗余。
- JSON 低容错：一个引号/逗号错 → 整体 zod 失败重试。

### 问题 B：完整工作流 JSON 全程流经 LLM 上下文（"背诵"模式）

- LangChain 工具参数是 LLM **生成**的（不是程序注入）：`generate_workflow` 输出的 10-30KB workflow JSON，LLM 要**原样重新生成**作为 `save_to_coze` / `update_workflow` 的参数。
- 一个迭代闭环里，同一 JSON 进出 LLM 上下文 4-6 次，每次都是输入（重复算 attention）+ 输出（重新背诵，8-10K token）双重成本。
- 这是截断问题反复出现的根源之一（maxTokens 8192、两段式、关思考都是被它逼出来的）。

### 问题 C：update_workflow 把整个 JSON 传给 LLM（用户重点指出）

`apps/api/src/agent/tools/update-workflow.tool.ts` 现状：

```ts
schema: z.object({
  workflow: z.record(z.string(), z.any())  // ⚠️ 完整工作流 JSON
  workflowId: z.string(),
  fixInstruction: z.string(),
})
```

- **输入**：LLM 要背诵整个 workflow JSON 作为参数。
- **输出**：工具返回 `{ workflow: <修改后完整 JSON>, changes }`，LLM 又要读一遍完整 JSON。
- **后果**：一个地方出错（背诵走样、截断、字段被改）→ 整个修改流程挂；而且每轮迭代重复这个高风险动作。

### 问题 D：LLM 读不到平台上已有的工作流

- 工具列表里没有"读工作流"工具；`CozeClient.getSchema` 只在保存时内部用。
- 用户问"这个工作流为什么错 / 帮我改线上的"时，LLM 无能力接入。
- schema-converter 只有正向（项目→平台），**反转换（平台→项目）不存在**。

---

## 二、设计目标

1. **DSL 双向（IR 化）**：DSL 是 LLM 与系统之间的中间表示，两个方向都有转换器。
   - 正向：LLM 设计 → DSL → 解析 → CozeWorkflow → 平台格式 → save
   - 反向：平台 getSchema → 反转换 → CozeWorkflow → DSL → LLM 分析/修改
2. **降低 LLM 数据面**：LLM 不背大 JSON，只传小体积的 DSL 文本 + workflowId 句柄 + 自然语言指令。
3. **行级容错**：DSL 一行坏只丢一行（跳过+警告），JSON 一个错整体废。
4. **下游最小改动**：转换器输出仍是 CozeWorkflow，generator/schema-converter/save 链路不动（update_workflow 单独改造）。
5. **Round-trip 保真**：DSL → JSON → DSL 语义相等，平台高级参数不丢。
6. **传输层可恢复**：DSL 文本即使经过结构化工具参数传输，也要有 JSON repair / 文本回退机制，不能只把问题推给语法。

---

## 二点五、传输层与解析策略（先解决 C1）

这一层是方案能否成立的前提。

### 结论

当前链路里，LLM 的工具调用参数仍然要走结构化输出（`jsonMode`）。这意味着：**DSL 本身即使设计成行式、可部分解析，到了工具参数层仍然会被 JSON 包一层**。如果 JSON 断了，外层仍会整体失败。

所以方案必须显式引入下面两种之一：

1. **JSON repair 层**：在工具参数反序列化前做宽容修复（允许尾部截断、引号补全、换行恢复），把"半截 JSON"修成可解析结构后再喂给 DSL parser。
2. **非结构化文本通道**：让 DSL 作为正文流或独立文本块传输，由解析器从文本中提取完整 DSL body，再进行语义解析。

### 本方案的决定

- **前向生成**：采用**轻量 JSON 信封 + DSL body** 的方式。
  - 信封负责 `needClarification` / `meta` / `warnings` / `dslBody` 的边界控制。
  - DSL body 是真正的业务 IR。
- **工具参数传输**：允许 `jsonrepair` 风格的修复层。
- **截断恢复**：如果只拿到部分 DSL body，则只解析已完整的行，并返回 warning，提示 LLM 续写尾部。

> 也就是说：**DSL 的“可部分解析”不是语言本身自动成立，而是语言 + 传输修复层共同成立。**

---

## 三、DSL 语法草案（v0.2）

### 3.1 语法设计原则

| 原则 | 内容 |
|---|---|
| 信息三层分离 | 拓扑层（必须精确）/ 配置层（可降级）/ 元信息层（可推导） |
| 引用用 id | 节点引用用语义化 id（transcribe/compare），不用数组下标 |
| 语法面极小 | 4 条核心指令 WORKFLOW/INPUT/NODE/EDGE，LLM 输出正确率高 |
| 双向完备 | 字段集 = 正向生成所需 ∪ 反向展示所需 |
| 透传区 | DSL 表达不了的平台字段原样保留，round-trip 不丢 |

### 3.2 指令集

```
WORKFLOW <name>                     # 工作流名（英文，字母开头 ≤50）
INPUT <var>:<type>[=<default>]      # 入口参数（可多行，默认 user_input:string）
NODE <id> <TYPE> IN(<v1>,<v2>) OUT(<o1>:<type>,<o2>:<type>)
EDGE <src>-><dst>                   # 普通连线
EDGE <src>:<port>-><dst>            # 带端口连线（condition true/false、llm branch_error）
# 配置块（每节点一个，可选，Stage 2 产出）
<id>.prompt <<<EOF
多行 prompt / system prompt / 说明
EOF
<id>.logic <<<EOF
多行业务逻辑描述
EOF
<id>.model = "Doubao-Seed-2.0-Lite"
<id>.branches = "similarity>=0.6 → match | else → nomatch"
<id>.batch = single | batch
# 透传区（平台高级参数，LLM 不解析，round-trip 原样保留）
#!platform <scope>: { "settingOnError": {...} }
```

### 3.2.1 语法约束（必须写清）

- **NODE 只允许业务节点**：`start` / `end` 不写在 NODE 里，由解析器自动补或由代码层统一生成，避免双 end。
- **EDGE 优先级高于自动补边**：只要 DSL 显式写了某节点的出边，就抑制 generator 的默认补边逻辑（LLM / condition 自动边不再重复补）。
- **注释规则**：`#` 行首表示注释；`#!platform` 是保留关键字，不是普通注释。
- **单节点配置优先**：同一节点的配置按 `id` 寻址，不按类型聚合；若最终阶段暂不改 shared 类型，则 parser 先降级为按类型合并并报警告。
- **透传区分层**：支持节点级、工作流级、边级三类 scope（`node:<id>` / `workflow` / `edge:<src>-><dst>`），不能只有节点级。

### 3.3 节点类型 → DSL 配置键

| 节点类型 | NODE 指令 OUT 约定 | 配置键 |
|---|---|---|
| llm | OUT 业务输出 + 自动补 reasoning_content/errorBody/isSuccess | model / prompt / system_prompt / temperature / max_tokens |
| code | OUT 声明（object 带 schema） | logic / language / reference_data |
| condition | OUT 无（分支走 EDGE 端口） | branches（语义描述，代码转平台条件） |
| text | OUT output:string | concat（模板 {{var}}） |
| merge | OUT 每个 group 名 | groups（变量引用列表） |
| database_query | OUT outputList:list + rowNum:integer | connection（res_id）/ query |
| http | OUT body/statusCode/headers | method / url / headers / body |

### 3.4 完整示例（歌曲识别，含配置与透传）

```
WORKFLOW song_recognition
INPUT audio_url:string

NODE transcribe LLM IN(audio_url) OUT(lyrics:string)
NODE compare CODE IN(lyrics) OUT(similarity:number)
NODE judge COND IN(similarity)
NODE done END IN()

EDGE transcribe->compare
EDGE compare->judge
EDGE judge:true->done
EDGE judge:false->done

transcribe.model = "Doubao-Seed-2.0-Lite"
transcribe.prompt = "识别音频中的歌词，只输出歌词文本"
compare.logic = "用编辑距离计算相似度，阈值 0.6，歌曲库见常量 SONG_LYRICS"
compare.reference_data = {"SONG_LYRICS": "..."}   # 体积大时用句柄替代
judge.branches = "similarity>=0.6 → 命中 | else → 未命中"

#!platform compare: {"settingOnError": {"processType": 1, "timeoutMs": 60000}}
```

### 3.5 截断容忍设计

行式 DSL 天然可部分解析：LLM 输出被截断时，解析器拿到**已完整输出的行**（缺末尾几行 → 警告"工作流不完整"），JSON 截断则是整体报废。

---

## 四、转换器设计

### 4.1 新增文件（全部在 apps/api/src/workflow-engine/）

```
workflow-engine/
├── dsl-parser.ts        # DSL 文本 → CozeWorkflow（行级容错解析）
├── workflow-to-dsl.ts   # CozeWorkflow → DSL 文本（序列化，纯本地）
├── platform-to-project.ts  # 平台 schema JSON → CozeWorkflow（反转换）
└── dsl.spec.ts          # round-trip 测试（DSL→JSON→DSL 语义相等）
```

### 4.2 dsl-parser.ts（DSL → WorkflowPlan）

- 逐行解析：WORKFLOW/INPUT/NODE/EDGE/配置行/透传行。
- 容错策略：未知行/坏行 → 跳过 + 收集 warnings；缺 start/end → 自动补；IN 变量名找不到上游 OUT → warning（不阻断，generator 兜底）。
- 输出：**WorkflowPlan 形状的中间体**（steps + nodeConfig + contracts + 元信息）。这样 generator.ts 可原样复用，CodeGenerator / 自动接线 / 端口补边都不需要重写。
- 变量一致性校验：每个 IN 的变量名必须存在于依赖上游的 OUT 中，报错比现在早（生成阶段）。
- 注意：如果最终输出要做 DSL→JSON→DSL，parser 和 serializer 之间要保留节点级 / 工作流级 / 边级透传区。

### 4.3 workflow-to-dsl.ts（WorkflowPlan / CozeWorkflow → DSL）

- 纯本地序列化，无 LLM。
- 若输入是 WorkflowPlan：输出设计 DSL（用于给 LLM 读/改）。
- 若输入是 CozeWorkflow：先做反向投影，再输出 DSL（用于读取平台已有工作流）。
- 配置字段映射：项目节点字段 → DSL 配置键；**无法映射的字段进透传区**（JSON 原文）。
- 幂等：`dslParser(workflowToDsl(x))` 还原出语义等价的中间体；`workflowToDsl(dslParser(x))` 保持关键字段不变。

### 4.4 platform-to-project.ts（平台格式 → 项目格式）

- schema-converter 的逆向：节点类型数字 → 字符串、100001/900001 → start/end、ref 引用 → inputMapping、llmParam 14 项 → LLMNode 配置、outputs 数组 → 项目 outputs 声明。
- 这是"读平台已有工作流"能力的地基，也是 `read_workflow` 工具的底层。
- 注意：平台格式里没有的信息（如 code 节点的业务描述）丢失无法还原，DSL 反向展示时这些字段标注 `(未解析)`，透传区保留原始 JSON 防丢。
- 需要补充：节点 id 生成策略（平台数字 id → DSL 语义 id / 稳定映射）和端口映射表（sourcePortID → true/false/default/branch_error）。

### 4.5 Round-trip 验收

| 测试 | 断言 |
|---|---|
| DSL → JSON → DSL | 语义相等（节点/边/端口/配置/透传区） |
| 平台 JSON → 项目 → 平台 | 平台关键字段不丢（llmParam、settingOnError、端口边） |
| 真实样本 | health-workflow-103-nosnack-sample.json（21 节点）+ 歌曲识别样本 |

---

## 五、update_workflow 句柄化改造（解决"整个 JSON 传给 LLM"）

### 5.1 现状问题（用户指出）

- 输入要 LLM 背诵整个 workflow JSON（高风险：截断/走样）。
- 输出又是完整 JSON（LLM 再读一遍）。
- 一处出错全挂。

### 5.2 改造后工具接口

```ts
// 改造前
{ workflow: <完整JSON>, workflowId, fixInstruction }

// 改造后
{ workflowId, fixInstruction }   // LLM 只传句柄 + 自然语言指令
```

### 5.3 服务端工作流缓存（新增 agent/workflow-cache.ts）

```
Map<workflowId, { workflow: CozeWorkflow, dsl?: string, updatedAt, commitId? }>
```

- `save_to_coze` 保存成功后写入缓存（这是最安全的写入点，因为此时 workflowId 已经真实存在）。
- `generate_workflow` 不直接绑定最终平台 id；可以返回临时摘要或草稿 id，但不要把缓存写入点放在生成阶段。
- `save_to_coze` 保存成功后保留缓存（修复迭代复用）。
- **缓存 miss 时**：从平台 `getSchema` → `platformToProject` → `workflowToDsl` → 写入缓存（这就是双向 DSL 的闭环价值：没有本地缓存也能让 LLM 读/改线上工作流）。
- **缓存策略**：补 TTL / LRU / force-refresh / stale 检测（可用 submit_commit_id 或 commitId 比对）。

### 5.4 改造后 update_workflow 内部流程

```
1. 参数：{ workflowId, fixInstruction }
2. 缓存取 workflow（miss → 平台拉取 + 反转换）
3. workflowToDsl(workflow) → DSL 文本 / 摘要（LLM 只看到 DSL，不是 JSON）
4. LLM 分析 DSL + fixInstruction → 输出结构化修改指令 { type, target, content }（现有 UpdateInstructionSchema 复用）
5. 代码在服务端应用修改（现有 findTargetNode + 各 type 逻辑复用）
6. 更新缓存
7. 返回 { changes[], dslSummary: <修改后 DSL 摘要> } —— 不返回完整 JSON
```

- 对于 **&lt;= 12 节点** 的小工作流，可以允许 LLM 看完整 DSL。
- 对于 **> 12 节点** 的大工作流，默认只给总览层 + 局部切片，不给整份 DSL。
- 更新动作建议分成两种模式：
  - **指令模式**：LLM 输出局部修改指令（默认）
  - **全量重设计模式**：LLM 输出新的 DSL（仅用于小图，或用户明确要求重做）

### 5.5 效果对比

| 维度 | 现状 | 改后 |
|---|---|---|
| LLM 输入数据 | 10-30KB JSON（背诵） | workflowId（几十字节）+ fixInstruction（自然语言） |
| LLM 输出数据 | 修改后完整 JSON（再背一次） | 结构化指令（几百 token） |
| LLM 可见内容 | 完整 JSON（噪音多） | DSL（拓扑 + 配置清晰可读） |
| 失败面 | 一处 JSON 出错全挂 | DSL 行级容错 + 指令解析失败有明确错误提示 |
| 每轮迭代 token | 输入+输出各 8-10K | 约 1-2K |

### 5.6 save_to_coze 同步增强

- 增加 `workflowId` 优先从缓存取 workflow（不传 JSON）；首次创建仍需传 DSL 或 workflow 参数（二选一，推荐 DSL）。
- `save_to_coze` 的输入也应允许 `dslBody`，由代码先解析后保存，避免把完整 CozeWorkflow 再塞回 LLM。
- 保存失败时返回**摘要**而不是完整 JSON；只有在需要人工排查时才让用户显式请求完整 JSON。

---

## 六、架构影响面

| 模块 | 改动 |
|---|---|
| workflow-engine/dsl-parser.ts | 🆕 新增 |
| workflow-engine/workflow-to-dsl.ts | 🆕 新增 |
| workflow-engine/platform-to-project.ts | 🆕 新增 |
| agent/workflow-cache.ts | 🆕 新增（服务端工作流缓存） |
| agent/tools/plan.tool.ts → planner.ts | 改：Stage 1 输出改 DSL（chatStructured 换宽松 schema + parser），Stage 2 保留 |
| agent/tools/update-workflow.tool.ts | 改：句柄化（参数瘦身 + DSL 展示 + 服务端应用） |
| agent/tools/generate-workflow.tool.ts | 改：生成后写缓存，返回 workflowId + DSL 摘要 |
| agent/tools/save-to-coze.tool.ts | 改：支持 workflowId 从缓存取 |
| prompts/plan-prompt.ts | 改：Stage 1 prompt 重写（DSL 示例驱动） |
| coze/schema-converter.ts | 不动（正向转换复用） |
| workflow-engine/generator.ts | 不动（消费 CozeWorkflow，DSL 解析后输出同样结构） |
| packages/workflow-schema | 不动 |
| 前端 | 不动（工具事件结构不变，面板文案可后续优化） |

---

## 七、分阶段实施计划

| 阶段 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| P1 | platform-to-project 反转换器 + 读工作流能力（不做 DSL，先转"LLM 可读简化版"喂给它） | 无 | 21 节点样本反转换正确 |
| P2 | DSL 核心：workflow-to-dsl + dsl-parser + round-trip 测试 | P1 可选 | round-trip 全绿 |
| P3 | planner Stage 1 改 DSL + prompt 重写 | P2 | 3 个复杂需求 DSL 输出正确率 ≥ 现状 |
| P4 | workflow-cache + update_workflow/generate/save 句柄化 | P2 + P3 | 端到端修复闭环无大 JSON 进出 LLM |
| P5 | 上线验证 + 真实样本回归 | 全部 | 原有用例（歌曲识别）全链路可用 |

**P1 可独立先行**（不做 DSL 也有价值：让 LLM 能"读"线上工作流）；P2-P4 依赖 DSL 语法定稿。

---

## 八、LLM 认知负担分析：DSL 会不会让模型更累？

这是本方案里必须单独讲清楚的一点：**DSL 不是天然减负，设计不好反而会增负**。它是否让 LLM 更轻松，取决于我们把 DSL 设计成什么样。

### 8.1 DSL 什么时候是减负的

在下面这些情况下，DSL 明显比完整 JSON 更轻：

1. **把大 JSON 改成短句 + 行式结构**
   - LLM 更擅长输出短、规整、局部独立的行，而不是深层嵌套 JSON。
2. **把下标引用改成 id 引用**
   - `dependencies: [0, 1, 2]` 这类数数型信息对 LLM 容易错。
   - `EDGE compare->judge` 这种语义化连线对 LLM 更自然。
3. **把元信息从结构里剥离**
   - name/goal/mode/constraints 这类信息如果和拓扑混在一起，会抬高输出难度。
4. **把大块内容句柄化**
   - `reference_data` 这类大文本不要直接塞 DSL，改成 `ref_id` / `resource_id`。

### 8.2 DSL 什么时候会变成负担

如果 DSL 设计成下面这样，它反而比 JSON 更难：

1. **语法太像编程语言**
   - if/else 嵌套太深、缩进规则太严格、需要很多标点和关键字。
2. **过度追求“像人写代码”**
   - 一旦 DSL 语法面太大，LLM 就要在“理解需求”和“遵守语法”之间分心。
3. **把所有平台细节都塞进 DSL**
   - rawMeta、settingOnError、各种默认值、长 JSON 透传如果全展开，DSL 会比现在更重。
4. **一个 DSL 同时承担设计、调试、保存三种职责**
   - 会导致语义混杂。正确做法是：核心 DSL 只负责“设计图”，高级字段用透传区。

### 8.3 控制认知负担的原则

| 原则 | 说明 |
|---|---|
| 语法最小化 | 核心指令尽量少：WORKFLOW / INPUT / NODE / EDGE / CONFIG |
| 行级独立 | 每一行尽量只表达一件事，避免嵌套太深 |
| 默认值兜底 | 让代码补默认值，少让 LLM 填无意义参数 |
| 配置分层 | 拓扑和配置分开；大字段走句柄或透传区 |
| 反向可读 | DSL 不只是给 LLM 写，也要能读，因此结构要稳定、简洁、可扫描 |
| 错误局部化 | 一行错只修一行，不让整份 DSL 报废 |

### 8.4 对大工作流的策略

当工作流节点数较多时，不能让 LLM 一次看完整 DSL 然后重写全部。建议分三层：

1. **总览层**：name + 输入/输出 + 节点摘要 + 边摘要
2. **局部层**：只展开当前要修改的子图或节点邻域
3. **原文层**：只有在需要全局重构时，才让 LLM 看完整 DSL

这意味着 DSL 需要支持：
- 全量查看
- 局部切片
- 增量修改

也就是说，DSL 最终不是只有“输出格式”，而是“**可切片、可读、可改的工作流 IR**”。

### 8.5 读工作流能力（必须补）

当前系统里并没有一个真正暴露给 LLM 的 `read_workflow` 工具。P1 至少应补两件事：

1. `list_workflows`：按名字/页码搜索平台工作流，解决“用户没给 workflowId”的问题。
2. `read_workflow`：输入 workflowId，返回 DSL 摘要 / 全量 DSL / 局部切片三种模式。

这两步是双向 DSL 真正落地的起点：**LLM 先读得懂，才谈得上改得动。**

---

## 十、风险与验证

| 风险 | 应对 |
|---|---|
| LLM 对 DSL 语法输出正确率未知 | 先 codex 实测：同一复杂需求，JSON vs DSL 各输出 10 次统计正确率（语法合法率 + 语义正确率）再定稿；给 few-shot 示例 + 语法卡 |
| DSL 语法表达力不足（复杂拓扑如循环/批处理） | 语法定稿前用 3 个复杂样本（含分支/merge/多输入）走查；循环节点暂不支持则明确标注（先支持现有 9 种节点） |
| 反向转换丢平台字段 | 透传区保底 + round-trip 测试强制；节点级 / 工作流级 / 边级三类透传都要测试 |
| 缓存有状态（重启丢失） | 可接受（session 已内存态）；缓存 miss 走平台拉取兜底；补 TTL/LRU/force-refresh |
| update_workflow 指令模式改变 LLM 行为 | 现有 UpdateInstructionSchema 复用，改动可控；返回 DSL 摘要保留 LLM 可见性 |
| 透传区 JSON 在 DSL 里体积大 | reference_data 等大数据走句柄（存缓存，DSL 只写引用名） |
| JSON 信封截断导致 DSL 部分解析失效 | 引入 jsonrepair / 宽容反序列化层；必要时走正文流通道 |
| 大工作流上下文过长 | 总览层 + 局部层 + 原文层三层策略，默认不让 LLM 看整份 |
| 没有读工作流工具 | P1 必须先补 `list_workflows` + `read_workflow` |

### 10.1 验证方法（必须操作化）

1. **基线对比**：先跑现状 JSON 模式 N=10，记录语法合法率、语义正确率、平均 token。
2. **DSL 对比**：同样 N=10，用 DSL 方案跑一遍，记录同样指标。
3. **round-trip 测试**：
   - DSL → WorkflowPlan → generator → CozeWorkflow → workflowToDsl → DSL
   - 断言：节点 id 集合相等、边多重集相等、显式配置键相等、透传区作用域相等。
4. **fuzz 测试**：随机截断 DSL 行尾 / 注入坏行 / 重复 id / 悬空边，确认 warnings 与 fatal 分层正确。
5. **读写闭环测试**：平台样本 → platformToProject → workflowToDsl → LLM 分析 → 指令修改 → 保存成功。

---

## 十一、场景覆盖矩阵

| 场景 | 输入给 LLM 的内容 | LLM 输出 | 代码侧处理 | 备注 |
|---|---|---|---|---|
| 新建小工作流 | 需求描述 + 少量文件/平台事实 | 完整 DSL | 解析 → CozeWorkflow → 生成 JSON | 语法最稳 |
| 新建大工作流 | 需求描述 + DSL 总览/切片 | DSL 分段或指令 | 局部解析 + 合并 | 不能一次喂全量大图 |
| 读取已有工作流 | workflowId + 平台 getSchema 结果（反转换为 DSL） | 分析/解释/修改建议 | platformToProject → workflowToDsl | 解决“线上工作流怎么读” |
| 局部修改 | workflowId + 当前 DSL 切片 + fixInstruction | 修改指令 | 只改子图/节点邻域 | 不让 LLM 看整份图 |
| 全量重设计 | 旧工作流 DSL + 新需求 | 新 DSL | 覆盖式生成 | 小图可用，大图谨慎 |
| 保存 | workflowId + 缓存中的 CozeWorkflow | 无需再输出 JSON | save_to_coze 直接读缓存 | 解决 JSON 背诵问题 |
| 失败重试 | 上一步的 DSL / 摘要 / 错误信息 | 修正后的局部 DSL/指令 | 局部重试 | 错误局部化 |
| 缓存 miss | workflowId + 平台 schema | DSL 摘要 | 平台反转换兜底 | 无缓存也能继续 |
| 截断恢复 | 已输出的 DSL 行 | 继续补行 | 解析已输出部分 + warning | 行式 DSL 优势 |

---

## 十、待决策问题

1. **DSL 语法选型**：行式指令（本文案）vs YAML vs 极简 JSON——建议 codex 实测后定。
2. **Stage 2 配置是否合并进 DSL**：本文案配置行独立（保留两段式）；也可以 Stage 2 输出直接是 DSL 配置行片段，合并成一份 DSL。倾向保留两段式（每段输出小，防截断收益不变）。
3. **指令模式 vs 全量模式**：update_workflow 用指令模式（省 token）；新增“全量重设计”场景（用户说“重新设计这个工作流”）走全量模式（LLM 输出新 DSL）。
4. **LLM 修改时看 DSL 还是看摘要**：倾向 DSL（完整可读）；超大工作流（>30 节点）可降级为节点摘要表格。

---

## 十二、最终建议（给 Qoder 的落地顺序）

1. **先做 P1 读工作流能力**：`list_workflows` + `read_workflow` + `platformToProject`。这一步不依赖 DSL 定稿，但价值最大：先让 LLM 能读线上工作流。
2. **再做 C1 传输层修复**：为工具参数加宽容 JSON repair / 文本回退机制，否则“行式 DSL 可部分解析”无法成立。
3. **然后定 DSL v0.2 语法**：补 heredoc、多 scope 透传、batch、注释、边优先级、重复 id 策略。
4. **再做 DSL parser / serializer**：先保证 round-trip，再接 planner。
5. **最后句柄化 update_workflow / save**：把大 JSON 从 LLM 上下文里移走，收益最直接。

> 结论：**DSL 是 IR，句柄化是减 token，反转换是补能力，传输层修复是让方案成立的地基。** 四者缺一不可。

---

*讨论记录：2026-08-15 志武提出双向 DSL（IR）+ update_workflow 大 JSON 痛点；方案 v0.3 待评审。*
