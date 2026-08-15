# 工作流双产物生成方案：机器 DSL + 人类可读说明书（借鉴飞书 CLI 文档流水线）

> 版本：v0.1（方案稿）
> 日期：2026-08-15
> 状态：待评审（未落地）
> 关联：dsl-design.md（DSL 双向方案）、planner.ts、generator.ts、update-workflow.tool.ts、lark-doc 创建流水线（Presentation Decision → draft → parse → create → fetch 验证 → 局部修复）

---

## 一、背景与问题

### 问题 1：DSL 是机器 IR，人类看不懂

- DSL（WORKFLOW/NODE/EDGE 行式语法）是给 LLM 和解析器用的中间表示，人类扫一眼很难判断"这个工作流对不对"。
- 用户 / 评审者需要的是：**一眼能看懂拓扑、节点、配置、验证状态**的说明书，而不是 IR 文本。

### 问题 2：LLM 生成的东西"能解析"不等于"没错误"

- 语法错误可以被 parser 容错，但**语义错误**（连错边、缺节点、端口写错、配置键不合法）会产生"能解析但实际错误"的工作流。
- 需要一个**展示层校验**：说明书本身也要可渲染、无空章节、无矛盾。

### 问题 3：LLM 直接写"给人看的文档"会幻觉

- 如果让 LLM 再写一份中文说明书，它可能描述与实际工作流不一致（幻觉、过时、夸大）。
- 正确做法：**说明书由代码从 DSL 单向生成**，保证 100% 与机器产物一致，LLM 不参与说明书写作。

### 问题 4：飞书 CLI 已经证明可行的流水线

- 飞书 CLI（lark-doc）用「先定读者与结构（Presentation Decision）→ 生成草稿 → parse/profile check → create → fetch 验证 → 局部最小修复」让 Agent 产出可看、少错、可修的文档。
- 这套「**结构先行 + 草稿校验 + 局部修复**」的思路可以直接借鉴到工作流生成链路。

---

## 二、借鉴飞书 CLI 的机制映射

| 飞书 CLI 文档流水线 | agent-coze-workflow 对应物 | 作用 |
|---|---|---|
| Presentation Decision（读者/任务/结构/表达组件） | WorkflowPlan / DSL 头部（name/inputs/goal） | 先定结构与意图，再写内容 |
| init-draft（初始化草稿） | LLM 输出 DSL 草稿（或 workflowToDsl 从已有工作流生成） | 机器可写的中间产物 |
| parse + profile check（结构校验） | dsl-parser（L1 语法）+ semantic-validator（L2 语义） | 校验草稿合法性，坏行跳过+警告 |
| create（发布） | generator → CozeWorkflow → schema-converter → save | 落成平台工作流 |
| fetch 验证（回读确认） | 平台 getSchema 回读 → platformToProject → round-trip 对比 | 确认线上与本地一致 |
| 局部最小修复（update） | update_workflow 指令模式（workflowId + fixInstruction） | 错哪修哪，不整篇重来 |

**核心迁移结论：** 飞书 CLI 靠「先规划 → 草稿 → 校验 → 发布 → 回读 → 局部修」六步护栏保证文档可看少错；工作流生成也应该走同样六步，而不是让 LLM 一次性输出最终成品。

---

## 三、核心设计：双产物架构

```
                     ┌─────────────────────────────┐
                     │      LLM（只负责内容意图）      │
                     └──────────────┬──────────────┘
                                    │ DSL（行式 IR，机器读写）
                                    ▼
                     ┌─────────────────────────────┐
                     │      dsl-parser（L1 语法）     │
                     │   semantic-validator（L2 语义）│
                     └──────────────┬──────────────┘
                                    │ 通过校验的 WorkflowPlan
                ┌───────────────────┴───────────────────┐
                ▼                                       ▼
   ┌──────────────────────┐              ┌──────────────────────────┐
   │  机器产物（执行链路）    │              │  人类产物（阅读链路）        │
   │  generator → CozeWf   │              │  workflow-to-doc（代码生成） │
   │  → schema-converter   │              │  → markdown 说明书          │
   │  → 平台 save           │              │  （含 mermaid 拓扑图）       │
   └──────────────────────┘              └──────────────────────────┘
                │                                       │
                ▼                                       ▼
   getSchema 回读 ── round-trip 对比 ──►      doc-validator（展示层校验）
```

- **产物 A（机器）**：CozeWorkflow / 平台 JSON —— 现有链路不动。
- **产物 B（人类）**：由代码单向生成的 Markdown 说明书 —— **LLM 不参与写作**，杜绝幻觉与不同步。

---

## 四、人类可读说明书的结构（模板草案）

```
# 工作流说明书：song_recognition
> 生成时间 / 来源（DSL | 平台回读） / 校验状态（✅ 通过 | ⚠️ N 警告 | ❌ N 错误）

## 1. 概览
- 名称 / 用途 / 输入 / 输出 / 节点数 / 边数
- 验证状态摘要

## 2. 拓扑图（mermaid）
flowchart LR
  start --> transcribe
  transcribe --> compare
  compare --> judge
  judge -- "similarity>=0.6" --> done
  judge -- "else" --> done

## 3. 节点清单（表格）
| id | 类型 | 输入 | 输出 | 关键配置 |

## 4. 数据流说明（自动生成的文字描述）
输入 audio_url → transcribe（LLM 识别歌词）→ compare（计算相似度）
→ judge（条件判断）→ done（结束）

## 5. 配置详情（逐节点展开）
### transcribe（LLM）
- model: Doubao-Seed-2.0-Lite
- prompt: 识别音频中的歌词，只输出歌词文本

## 6. 验证报告
- 语法校验：通过
- 语义校验：⚠️ 1 个警告（compare 的 IN(similarity) 无上游 OUT 来源？）
- 平台兼容：待保存验证

## 7. 透传区（平台高级参数，原样展示）
```

**关键点：**
- 每个章节都由代码从 DSL / WorkflowPlan 生成，不是 LLM 写的。
- 数据流说明（第 4 节）由代码做拓扑遍历生成，保证与实际连线一致。
- 验证报告（第 6 节）直接引用 L1/L2 校验结果，让读者一眼看到"哪里没把握"。

---

## 五、生成流水线（六步，对标飞书 CLI）

### Stage 0：规划（对标 Presentation Decision）
- 输入：需求描述（新建）或 workflowId（读取已有）。
- 产出：WorkflowPlan / DSL 头部（name、inputs、goal）。
- LLM 职责：只表达意图，不负责最终排版。

### Stage 1：生成 DSL 草稿
- 新建：LLM 输出 DSL（行式，4 条核心指令）。
- 读取：平台 getSchema → platformToProject → workflowToDsl。
- 产出：DSL 文本（机器 IR）。

### Stage 2：校验（L1 + L2）
- L1 dsl-parser：逐行解析，坏行跳过 + warnings。
- L2 semantic-validator（新增）：拓扑完整性校验：
  - start/end 唯一
  - 边目标节点存在
  - 端口合法（true/false/default/branch_error）
  - 每个 IN 变量有上游 OUT 来源
  - 无重复节点 id
  - 配置键合法（节点类型 → 允许的配置键）
- 产出：通过校验的 WorkflowPlan + warnings/errors 列表。

### Stage 3：双产物渲染
- 机器产物：generator → CozeWorkflow →（保存时）schema-converter → 平台 JSON。
- 人类产物：workflow-to-doc → Markdown 说明书（含 mermaid 拓扑图 + 验证报告）。

### Stage 4：发布与回读验证
- 保存到平台 → getSchema 回读 → platformToProject → 与本地对比（round-trip）。
- 说明书校验：doc-validator 检查无空章节、mermaid 可渲染、验证状态与实际一致。

### Stage 5：局部修复（对标飞书 update 流程）
- 出错时定位到具体节点/边/段落，走 update_workflow 指令模式（workflowId + fixInstruction）局部修。
- 修复后重新生成说明书（代码重新渲染，不手工改）。

---

## 六、校验体系（三层 + 展示层）

| 层级 | 校验器 | 校验内容 | 失败策略 |
|---|---|---|---|
| L1 语法 | dsl-parser | 行格式、指令关键字、括号配对 | 坏行跳过 + warning |
| L2 语义 | semantic-validator（新增） | 拓扑完整性、端口、IN/OUT 匹配、配置键 | fatal（阻断生成）或 warning（可降级） |
| L3 平台 | platform-validator（现有） | 保存前平台兼容性 | 阻断保存，返回可读错误 |
| 展示层 | doc-validator（新增） | 说明书章节完整、mermaid 可渲染、无空章节 | 重新渲染或局部补章节 |

**严重度模型（沿用 DSL 方案）：**
- fatal：无 WORKFLOW 行、零节点、重复 start/end —— 拒绝生成。
- warn：悬空边、IN 无来源、未知配置键 —— 生成 + 在说明书验证报告中标注。

---

## 七、代码落地清单

### 新增文件（全部在 apps/api/src/workflow-engine/ 与 apps/api/src/agent/tools/）

```
workflow-engine/
├── workflow-to-doc.ts        # 🆕 WorkflowPlan/CozeWorkflow → Markdown 说明书（纯本地，无 LLM）
├── mermaid-generator.ts      # 🆕 拓扑 → mermaid flowchart（节点名/端口转义）
├── semantic-validator.ts     # 🆕 L2 语义校验（拓扑完整性/端口/IN-OUT/配置键）
├── doc-validator.ts          # 🆕 说明书结构校验（章节完整/mermaid 可渲染/无空节）
├── dsl-parser.ts             # 已有（接 L1）
├── platform-validator.ts     # 已有（L3）
└── dsl.spec.ts               # 已有（round-trip）

agent/tools/
├── generate-workflow.tool.ts # 改：生成成功后自动产出说明书（返回 docPath/docText）
├── read-workflow.tool.ts     # 🆕 读线上工作流 → 反转换 → 说明书（三种 scope：概览/局部/全文）
└── update-workflow.tool.ts   # 改：修复后重新生成说明书，返回摘要 diff

scripts/
└── generate-doc.ts           # 🆕 CLI：DSL/JSON 文件 → 说明书，本地预览（Qoder 可跑）
```

### 修改文件

| 文件 | 改动 |
|---|---|
| prompts/plan-prompt.ts | 提示 LLM：说明书由系统自动生成，LLM 不要写说明书正文 |
| agent/tools/generate-workflow.tool.ts | 生成成功 → workflowToDoc → 返回说明书文本/路径 |
| agent/tools/update-workflow.tool.ts | 修复成功 → 重新 workflowToDoc → 返回新说明书摘要 |
| agent/tools/read-workflow.tool.ts | 🆕 平台回读 → platformToProject → workflowToDsl → workflowToDoc |
| workflow-engine/dsl.spec.ts | 追加：说明书生成测试（对每个样本断言章节完整 + mermaid 合法） |

### 不变

- generator.ts / schema-converter.ts / coze.client.ts：机器链路零改动。
- packages/workflow-schema：不动。
- 前端：不动（说明书是独立 Markdown 产物，可后续做展示）。

---

## 八、分阶段实施计划

| 阶段 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| P1 | workflow-to-doc + mermaid-generator + doc-validator | 无（直接用现有 WorkflowPlan 样本） | 21 节点样本 + 歌曲识别样本输出完整说明书；mermaid 图可渲染 |
| P2 | semantic-validator（L2）+ 接入 dsl-parser | P1 可选 | 悬空边/端口错/IN 无来源/重复 id 全部检出，fatal/warn 分层正确 |
| P3 | 工具集成：generate 自动出说明书 + read-workflow 工具 | P1 + P2 | 端到端：需求 → DSL → 校验 → 说明书（含验证报告）→ 保存 → 回读对比 |
| P4 | 局部修复闭环：update 后重新渲染说明书 + 摘要 diff | P3 | 修复错误节点后，说明书对应章节更新，其余章节不变 |
| P5 | 真实样本回归 + 说明书人工评审 | 全部 | 原有用例全链路可用，说明书可独立阅读、无空章节、无矛盾 |

**P1 可独立先行**：即使 DSL 未定稿，也能先让现有工作流产出"人类可读说明书"，立即解决"工作流不可看"问题。

---

## 九、风险与验证

| 风险 | 应对 |
|---|---|
| 说明书与 DSL 不同步 | 单向代码生成（LLM 不写说明书），round-trip 测试强制 |
| mermaid 特殊字符（节点名含 `[`/`(`/引号）破坏图 | mermaid-generator 统一转义 + doc-validator 校验可渲染 |
| 大工作流说明书过长 | 分层：概览层（摘要）/ 局部层（子图）/ 全文层（可选） |
| 说明书有 LLM 幻觉 | LLM 只生成 DSL；说明书 100% 由代码渲染 |
| 中文/英文混杂、术语不一致 | 模板固定 + 术语表（沿用 DSL 方案字段映射） |
| 验证报告误导读者 | 验证报告直接引用 L1/L2/L3 真实结果，不单独生成 |

### 验证方法

1. 对每个真实样本跑 `generate-doc.ts`，断言说明书 7 个章节全部存在、无空章节。
2. mermaid 图用 mermaid CLI/渲染器验证语法合法（或 doc-validator 内嵌校验）。
3. round-trip：DSL → 校验 → 说明书 → 人工抽查 3 份，确认说明书描述与 DSL 一致。
4. 错误注入：故意写悬空边/错端口/重复 id，断言说明书验证报告如实标注，不掩盖。

---

## 十、待决策问题

1. **说明书语言**：默认中文（用户是中文环境）；模板做 i18n 预留还是先硬编码中文？
2. **说明书输出目标**：本地 .md 文件 / 飞书文档 / 两者都支持？建议先本地 .md（Qoder 可直接看），飞书推送作为 P3 增强。
3. **mermaid vs 飞书 whiteboard**：本地用 mermaid（文本可 diff、可渲染）；如需飞书内嵌图形，P3 走 whiteboard（复用 lark-doc 画板工作流）。
4. **说明书与 DSL 的存放关系**：同目录（.dsl + .md 成对）还是独立 docs/ 目录？
5. **数据流说明（第 4 节）**：代码自动生成的自然语言描述，需要定义句式模板（避免千篇一律）还是先简单句？

---

*讨论记录：2026-08-15 晚，志武要求参考飞书 CLI 的文档生成流水线，为 agent-coze-workflow 出"可看、无错"方案；本方案与 dsl-design.md 互补（DSL 解决机器可读，本方案解决人类可读）。*
