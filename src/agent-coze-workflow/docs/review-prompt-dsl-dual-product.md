# 审查任务：DSL 双向方案 + 双产物说明书方案（请 qoder 独立评审）

> 用途：给 codex exec 的评审 prompt。请 codex 阅读下方必读文件，逐条审查两个方案，输出审查文档到 `docs/codex-review-dsl-dual-product.md`。**只评审，不改代码。**

---

## 一、项目背景

项目：`agent-coze-workflow`（路径：`/Users/huzhiwu/workspace/ai-tools-demo/src/agent-coze-workflow`）
定位：用户给需求 + 参考文件 → ReAct Agent 自主完成：澄清 → 梳理节点/连接/数据契约 → 代码组装工作流 JSON → 保存到私有 Coze 平台 → 批量试运行验证 → 迭代修复 → 交付可用工作流。

技术栈：NestJS + LangGraph createReactAgent + Vercel AI SDK（useChat）+ 私有 Coze（coze.dev1.dachensky.com）+ DeepSeek（deepseek-v4-flash）。

核心链路（现状）：

- LLM（DeepSeekClient.chatStructured，实测只有 jsonMode 可用）输出骨架 JSON（planner.ts 的 WorkflowPlan：steps + contracts）
- generator.ts 消费 WorkflowPlan 生成 CozeWorkflow（含 CodeGenerator 生成 Python 代码、自动接线 createLLMEdges/createConditionEdges、inputMapping）
- schema-converter.ts 正向转换（项目 → 平台格式）
- save.tool.ts 保存到平台；test-run/batch-validate 验证；update-workflow.tool.ts 修改（**参数是完整 workflow JSON**）

## 二、两个待审方案（必读）

### 方案 1：`docs/dsl-design.md`（v0.3，DSL 双向 IR + 工具句柄化）

- 动机：planner 骨架 JSON 嵌套深、dependencies 数组下标易错；完整 workflow JSON（10-30KB）在 LLM 上下文反复"背诵"（进出 4-6 次，每次 8-10K token）；update_workflow 让 LLM 传整个 JSON 一个错全挂；LLM 读不到线上工作流（无 read 工具、无 platformToProject 反转换器）
- 核心设计：
  1. 行式 DSL（WORKFLOW/INPUT/NODE/EDGE + 配置行 + #!platform 透传区），作为 LLM 与系统之间的双向中间表示（IR）
  2. 正向：LLM 设计 → DSL → dsl-parser → WorkflowPlan → generator（链路保留）
  3. 反向：平台 getSchema → platformToProject → workflowToDsl → LLM 读/改
  4. update_workflow 句柄化：参数瘦身为 { workflowId, fixInstruction }，服务端 workflow-cache + DSL 摘要承接
  5. 传输层：当前工具参数走 jsonMode（DSL 会被 JSON 信封包一层），需 JSON repair / 文本回退机制，"行式可部分解析"才成立
  6. 认知负担分析：DSL 减负有条件（语法极小 + id 引用 + 行级容错 + 透传区）；否则反而增负
- 实施：P1 读工作流能力（platformToProject + list_workflows + read_workflow）→ P2 DSL 核心（workflow-to-dsl + dsl-parser + round-trip）→ P3 planner Stage 1 改 DSL → P4 句柄化 → P5 回归

### 方案 2：`docs/dsl-human-readable-doc-design.md`（v0.1，双产物生成）

- 动机：DSL 是机器 IR 人类看不懂；LLM 直接写人类文档会幻觉/与工作流不一致；飞书 CLI（lark-doc）已证明「结构先行 → 草稿 → parse 校验 → create → fetch 验证 → 局部最小修复」流水线能让 agent 产出可看、少错、可修的文档
- 核心设计：
  1. 双产物：产物 A 机器（generator → 平台 JSON，现有链路不动）+ 产物 B 人类（workflow-to-doc 由**代码单向生成** Markdown 说明书，LLM 不参与写作，杜绝幻觉）
  2. 说明书 7 章节：概览 / mermaid 拓扑图 / 节点清单 / 数据流说明（代码拓扑遍历）/ 配置详情 / 验证报告（引用 L1/L2/L3 真实结果）/ 透传区
  3. 六步流水线对标飞书 CLI：规划（Presentation Decision↔WorkflowPlan）→ DSL 草稿 → 校验（L1 dsl-parser + L2 semantic-validator 新增）→ 双产物渲染 → 发布回读 round-trip → 局部修复（update 指令模式 + 重渲染说明书）
  4. 新增文件：workflow-to-doc.ts / mermaid-generator.ts / semantic-validator.ts / doc-validator.ts / read-workflow.tool.ts / scripts/generate-doc.ts
- 实施：P1 workflow-to-doc + mermaid（可独立先行，DSL 未定稿也能用）→ P2 semantic-validator → P3 工具集成 → P4 局部修复闭环 → P5 回归

## 三、必读文件清单（请 codex 自行阅读核实，不要只信方案转述）

### 方案文档

- `docs/dsl-design.md`
- `docs/dsl-human-readable-doc-design.md`
- `docs/react-agent-thinking-chain.md`（现状 ReAct 链路）

### 关键代码

- `apps/api/src/workflow-engine/planner.ts`（WorkflowPlan 骨架输出、aggregateConfigs/configFor 按类型聚合配置、PlanSkeletonSchema）
- `apps/api/src/workflow-engine/generator.ts`（消费 WorkflowPlan → CozeWorkflow，CodeGenerator、createLLMEdges/createConditionEdges 自动补边）
- `apps/api/src/workflow-engine/code-generator.ts`（code 节点 Python 生成）
- `apps/api/src/workflow-engine/types.ts`（WorkflowPlan/CozeWorkflow/nodeConfig 结构）
- `apps/api/src/workflow-engine/platform-validator.ts`（L3 平台兼容校验）
- `apps/api/src/agent/tools/update-workflow.tool.ts`（现状：workflow: z.record(...) 完整 JSON 参数 + UpdateInstructionSchema）
- `apps/api/src/agent/tools/generate.tool.ts` / `save.tool.ts` / `test-run.tool.ts` / `batch-validate.tool.ts`
- `apps/api/src/agent/tools/plan.tool.ts` / `platform-facts.tool.ts` / `iteration-counter.ts`
- `apps/api/src/coze/schema-converter.ts`（正向转换，llmParam 14 项、节点类型数字、sourcePortID）
- `apps/api/src/coze/coze.client.ts`（getSchema 内部用、listModels、validate_tree、get_process）
- `apps/api/src/llm/deepseek.client.ts`（chatStructured 实测 jsonMode only、maxTokens 8192）
- `apps/api/src/agent/react-agent.service.ts`（ReAct 编排、工具列表、interrupt/resume）

## 四、审查焦点（逐条给出判定：✅ 同意 / ⚠️ 需修改 / ❌ 反对，附理由与具体修改建议）

### A. 方案方向

1. 两个方案的整体方向是否成立？DSL 双向 IR + 双产物说明书，是值得做还是过度设计？有没有更省的路径（例如：只做句柄化 + 摘要，不引入 DSL；说明书直接用现有 WorkflowPlan 渲染不做 DSL）？
2. 方案的收益量化是否可信：token 节省、失败率降低、可维护性提升，分别在哪一阶段兑现？

### B. DSL 本身

3. 行式 DSL 相比现状骨架 JSON，对 DeepSeek（deepseek-v4-flash）的真实输出正确率会更高还是更低？训练先验上 JSON 远强于自造 DSL，这个风险方案是否充分缓解（few-shot、语法卡、宽容词法）？
4. "DSL 行级可部分解析"在 jsonMode 传输层下是否真的成立？JSON repair 方案在 LangChain 工具反序列化链路里怎么落地（具体插在哪一层）？有没有更简单可靠的替代（如 tool call 里直接传 string 字段 + 独立校验）？
5. dsl-parser 输出 WorkflowPlan 中间体（而非 CozeWorkflow）是否真的能保持 generator 零改动？code 节点 Python 生成、自动补边、inputMapping 是否都能在 parser 输出 WorkflowPlan 后由 generator 原样完成？
6. 按节点 id 配置（DSL 配置行 <id>.prompt）与现状按类型聚合 nodeConfig 的矛盾：改 shared 类型支持 per-node config 的成本/风险多大？P3 阶段是否值得做？
7. round-trip 保真（DSL→JSON→DSL 语义相等）的可操作化标准是否充分？透传区（节点/边/工作流三级 scope）设计是否够用？生成产物（code 的 Python、llmParam 14 项）到底该进配置键还是透传区？

### C. 双产物/说明书

8. 说明书由代码单向生成（LLM 不参与）是否合理？mermaid 拓扑图对 >30 节点工作流是否仍然可读？有没有必要做"分层说明书"（概览/局部/全文）？
9. 数据流说明由代码拓扑遍历生成自然语言，句式模板的复杂度是否可控？会不会产出不可读的机翻腔？
10. 飞书 CLI 流水线（结构先行/校验/局部修复）与本项目的类比是否成立？doc-validator 检查"mermaid 可渲染、无空章节"的价值 vs 成本？
11. 说明书作为独立 Markdown 产物，与 DSL/工作流 JSON 的存放关系、同步机制、版本一致性怎么保证？

### D. 实施与边界

12. P1-P5 的实施顺序是否合理？P1（读工作流能力）和 P1（workflow-to-doc）哪个更该先做？两者能否合并成一个 P1？
13. 还有哪些边界情况两个方案都没覆盖？（例如：超大工作流 50+ 节点、循环依赖、平台侧被人工改动后的 stale 检测、并发保存、凭证过期、批处理 batch 模式、中文节点名/中文 DSL id、多会话共享缓存）
14. 缓存（workflow-cache）的内存模型、TTL/LRU、save 成功后才写入的时序，是否有遗漏？

### E. 落地建议

15. 如果只选一个方案先落地（1-2 周内见效），选哪个？具体先做哪几个文件？
16. 有没有两个方案都没考虑到的第三选择（更简单/更稳/更省）？

## 五、输出要求

1. 审查结论写入：`docs/codex-review-dsl-dual-product.md`
2. 文档结构：
   - 总体结论（一段话：方向是否成立、最该做什么、最不该做什么）
   - 分项判定表（A/B/C/D/E 每条：✅/⚠️/❌ + 理由 + 修改建议）
   - 发现的问题清单（按严重度排序：致命/重要/建议，每个问题给：现象、证据（文件:行号）、影响、修复建议）
   - 第三选择建议（如有）
   - 最终推荐的实施顺序（含每阶段交付物与验收标准）
   - 明确列出"方案里写错了/与代码事实不符"的地方
3. 全程不改任何代码文件，只写审查文档。

## 六、运行方式（给志武的，不是给 codex 的）

```bash
cd /Users/huzhiwu/workspace/ai-tools-demo/src/agent-coze-workflow
codex exec --full-auto -C . "$(cat docs/review-prompt-dsl-dual-product.md)"
```
