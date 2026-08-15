# codex 独立评审：DSL 双向方案 + 双产物说明书方案

> 评审对象：`docs/dsl-design.md`（v0.1/v0.3）+ `docs/dsl-human-readable-doc-design.md`（v0.1）
> 评审方式：通读两份方案 + 核对 7 个关键代码文件（planner/generator/code-generator/types/platform-validator/schema-converter/coze.client/deepseek.client/react-agent.service/update-workflow/generate/save 工具）
> 结论：两方案方向均成立，但价值排序应为「句柄化 > 读工作流 > 说明书 > DSL 语法」；实施顺序必须重排。
> 本次评审全程未改任何代码文件。

---

## 一、总体结论

两个方案诊断的问题是真实存在的（大 JSON 背诵、无读工作流能力、人类看不懂工作流），但**把「DSL」放在核心位置是过度设计**。真正的收益来源是：① update_workflow/save 句柄化（token 节省 80%+，直接解决用户点名的痛点，1 周可落地）；② platformToProject 反转换 + read_workflow 读能力（补能力）；③ 说明书由代码单向生成（低风险、纯旁路）。而 DSL 语法的三大卖点中——「token 节省」实际来自句柄化而非 DSL、「行级可部分解析」被 jsonMode 传输层架空（方案 1 自己承认，但未给出可落地的修复位置）、「id 引用优于下标」是对的但不需要自造 DSL 就能解决。**最该做的是句柄化 + 读工作流；最不该做的是在 DSL 输出正确率实测通过前投入 P2/P3 工程，以及为 round-trip 100% 保真投入过重。**

---

## 二、分项判定表

### A. 方案方向

**A1. 两方案整体方向是否成立？有没有更省的路径？—— ✅ 方向成立，⚠️ 但实施顺序必须颠倒**

- 三个痛点（问题 A/B/C/D）经代码核实全部属实：update-workflow.tool.ts:321-335 确实要求 `workflow: z.record(...)` 完整 JSON 参数且返回完整 JSON（:307）；工具列表（tools/index.ts:103-114）确实没有读工作流工具；schema-converter.ts 确实只有正向转换。
- 但方案 1 把「DSL 双向 IR」当作减负主杠杆是归因错误：token 大头在 **update→save 往返背诵**，这由句柄化解决，与 DSL 无关（见 A2）。
- 更省的路径（详见第五节）：**句柄化 + 读工作流 + 说明书，DSL 条件性后置**。理由：句柄化只需要 workflow-cache 一个文件 + 改 2 个工具；读工作流底层 `CozeClient.listWorkflows()`（coze.client.ts:296-306）和 `getSchema()`（:103-116）**已经存在**，只需暴露工具层 + 写 platformToProject；说明书是纯函数旁路，零风险。DSL 语法（WORKFLOW/NODE/EDGE 指令集 + parser + serializer + round-trip）是四者中工程量最大、正确率风险最高、收益最不确定的一项。

**A2. 收益量化是否可信？—— ⚠️ 归因错误，token 节省数据可信但记错了账**

- dsl-design.md 5.5 表「每轮迭代 token：输入+输出各 8-10K → 约 1-2K」：节省幅度可信，但**该收益 100% 来自句柄化**（workflowId 几十字节 + fixInstruction），把表放在 DSL 方案第五节、与 DSL 打包汇报，会让读者误以为"DSL 带来了 token 节省"。事实是：DSL 在新建场景（plan Stage 1）节省的仅是骨架 JSON 的元信息冗余（mode/inputType/outputType/needBranch 等，见 B6 证据），量级几百 token，且要冒「自造 DSL 输出正确率下降」的风险。
- 「失败率降低」：不可信。DSL 行级容错在 jsonMode 下不成立（见 B4），失败面并未收窄。
- 「可维护性提升」：说明书方案可信（人类可读），DSL 方案存疑（多一套语言 + 两个转换器 + round-trip 测试的维护成本本身不小）。
- 建议：把收益表拆成「句柄化收益」（立即可兑现）与「DSL 收益」（条件性、待实测），不要混在一张表里。

### B. DSL 本身

**B3. 行式 DSL vs 现状骨架 JSON，DeepSeek 输出正确率会更高还是更低？—— ⚠️ 大概率更低或持平，必须实测先行**

- deepseek-v4-flash 的训练先验中 JSON 远强于任何自造 DSL；且当前链路强制 `response_format json_object`（deepseek.client.ts:238-241），jsonMode 下让模型输出「行式 DSL 文本」与格式指令本身存在张力——模型要么把 DSL 塞进 JSON 字符串字段（转义引号/换行，行式优势打折），要么违反 json_object 约束。
- 方案 1 自己也在风险表（dsl-design.md:387）写了「先 codex 实测 N=10 再定稿」——这是正确姿态，但意味着 **P2/P3 的工程投入必须排在实测之后**，而方案的实施计划（七节）把实测放在「风险与验证」而非 P1 前置门禁。建议：把「JSON vs DSL 正确率 A/B 实测」从风险应对提升为 P0 门禁，实测不通过则砍掉 DSL 只做句柄化。

**B4. 「行级可部分解析」在 jsonMode 传输层下是否真的成立？—— ❌ 不成立，方案未给出可落地的修复位置**

- 链路事实：createReactAgent 的工具参数由模型在 jsonMode 下生成 JSON，LangChain 内部反序列化（`withStructuredOutput` → `JSON.parse` + zod 校验）发生在业务代码**之前**。JSON 截断/坏引号 → 整个工具参数解析失败 → 错误回灌 LLM 重试。DSL 的「坏一行只丢一行」在这一层**完全没有发挥空间**。
- 方案 1 二点五节承认了这一点但只给结论不给位置：「JSON repair 层……插在哪一层？」审查焦点 4 的答案：**插不进去**——LangChain 工具参数反序列化由框架完成，业务代码拿不到原始 JSON 文本；能落地的是审查焦点里给的替代：**工具 schema 把 DSL 定义为 `z.string()` 字段**（信封结构保持极简：`{ needClarification, meta, dslBody }`），框架只要信封 JSON 合法就能解析，dslBody 字符串的容错/续写交给工具内部 parser。即「DSL 的容错性不是语言属性，而是字符串字段 + 独立 parser 的属性」——此时 DSL 与「结构化字段数组」相比已无优势，甚至不如直接把节点列表做成 zod schema 数组（那样 zod 校验还能兜底）。
- 更简替代：接受整体失败，截断时靠现有「截断检测提示续写」机制（deepseek.client.ts:169-198 已有截断识别）。行级容错不值得为此设计一门语言。

**B5. dsl-parser 输出 WorkflowPlan 是否真的保持 generator 零改动？—— ⚠️ 大体可行，但两处细节与方案表述矛盾**

- 可行部分：generator 消费 PlanStep[]（order/dependencies/nodeType/description/contract/nodeConfig），parser 构造该形状后 CodeGenerator、buildInputMapping、createLLMEdges/createConditionEdges 均可复用（generator.ts:392-499 确认）。dependencies 是 order 数字引用（generator.ts:432-444），parser 只需维护 id→order 映射。
- 矛盾 1：方案 3.2.1 说「EDGE 显式写了某节点的出边，就抑制 generator 的默认补边」，但六节又说「generator.ts 不动」。代码事实：`createConditionEdges`（generator.ts:249-289）**无条件删除** condition 节点全部出边再重建，`createLLMEdges`（:218-247）强制给 llm 主边打 default 端口 + 补 branch_error。不改 generator，「显式 EDGE 抑制自动补边」无法实现。正确姿势：DSL 只表达业务拓扑，平台强制边（branch_error/default/false）由 generator 补，DSL 显式端口边仅对 condition 翻译为 branches[].targetNodeId（generator 已支持读取该字段）。
- 矛盾 2：round-trip 断言「边多重集相等」会失败——反向序列化必然带出 generator 补的 branch_error/false 边。需在断言中豁免自动边（见 B7）。

**B6. per-node config 与现状按类型聚合 nodeConfig 的矛盾，成本多大？—— ⚠️ 需修改，但成本低于方案预估**

- 代码事实：`aggregateConfigs`（planner.ts:200-226）确实「同类型多节点后者覆盖前者」（:219 `result[key] = cfg`）——这是现状真实缺陷（两个 llm 节点配置打架），方案 1 问题 A 未点名但审查焦点点到了。
- 关键发现：`PlanStep.nodeConfig` 本身是 **per-step 携带**的（planner.ts:358 `nodeConfig: cfg ? ({ [s.nodeType]: cfg } as any) : undefined`），generator 也是 per-step 读取（generator.ts:533 `step.nodeConfig?.llm`）。也就是说 **per-node config 在数据结构和下游消费两端都已支持**，唯一要改的是 planner 的聚合逻辑（甚至可直接删掉 aggregateConfigs）。成本 ≈ 改一个函数，远低于方案暗示的「改 shared 类型」。
- 未决问题：DSL 配置行（`<id>.prompt = ...`）与现有 Stage 2 逐节点生成 nodeConfig 是**两个并存来源**，方案待决策 2「倾向保留两段式」——若保留，DSL 配置行只是展示/编辑视图，parser 解析配置行会与 Stage 2 输出冲突（谁覆盖谁？）。建议：明确「DSL 配置行仅用于**读/改**场景（反向路径），正向生成仍走 Stage 2」，parser 的配置行解析降为「修改指令输入」而非「生成输入」，矛盾消除。

**B7. round-trip 保真标准是否充分？透传区够用吗？生成产物进哪？—— ⚠️ 需补充豁免清单与 id 映射机制**

- 现有断言（节点 id 集合相等、边多重集相等、显式配置键相等、透传区作用域相等）缺少三类豁免：
  1. **自动边豁免**：branch_error / false / default 端口边是 generator 产物，不应参与对比；
  2. **LLM 产物豁免**：code 节点 Python 代码由 CodeGenerator 生成（非确定性），从 DSL 的 logic 描述重建后必然不等于原 code——Python code 必须进透传区（或排除出对比），否则 round-trip 永远红；
  3. **默认值豁免**：llmParam 14 项里大部分是 schema-converter 硬编码默认值（schema-converter.ts:280-311），反向转换只需展示非默认值，默认值不参与对比。
- 透传区三级 scope 设计够用，但「平台数字 id → DSL 语义 id」的稳定映射机制缺失：platformToProject 拿到的平台 JSON 里节点只有数字 id（200101）和中文 title（「LLM 处理」，nodeLabelForType 的产物，同类型多节点重名）。下次读回来怎么知道 200101 对应 `transcribe`？title 不可靠（重名），平台保存会丢弃未知扩展字段（不能往 schema 里塞 \_dslMeta）。可行方案：id 映射按「title + 类型 + 拓扑序」确定性推导（如 `llm_1`、`llm_2`），并接受映射在节点增删后漂移——这又会破坏「LLM 用语义 id 引用节点」的卖点。**这是 DSL 反向路径最被低估的坑。**

### C. 双产物/说明书

**C8. 说明书由代码单向生成合理吗？mermaid 对 30+ 节点可读吗？要分层吗？—— ✅ 方向合理，⚠️ P1 验收标准要加「可读」**

- 代码单向生成（LLM 不参与写作）正确，杜绝幻觉与不同步，✅。
- mermaid flowchart 对 30+ 节点横向排列会极宽，**渲染合法 ≠ 可读**。方案 2 P1 验收只写「mermaid 图可渲染」（dsl-human-readable-doc-design.md:222）——达标容易，可读难。建议 P1 验收改为：「21 节点样本输出分层说明书（总览表 + 按子图分组的多张 mermaid），每张图 ≤ 10 节点」。
- 分层有必要，且成本低（概览层 = 节点清单表已有，局部层 = 按拓扑分段切图）。

**C9. 数据流说明句式模板复杂度可控吗？—— ✅ 可控，建议先简单句**

- 节点清单表 + mermaid 已承担精确信息，第 4 节文字只需顺序叙述「谁接谁」。句式模板（多样化措辞）是过度设计，会引入维护成本。先简单句（`transcribe（LLM 识别歌词）→ compare（计算相似度）→ ...`），实测生硬再加模板。方案待决策 5 的第二个选项即可。

**C10. 飞书 CLI 类比成立吗？doc-validator 价值 vs 成本？—— ⚠️ 类比方向成立，doc-validator 要降级**

- 「结构先行 → 草稿 → 校验 → 发布 → 回读 → 局部修复」是通用工程模式，类比成立。但注意不等价：飞书 CLI 的 fetch 验证是文档发布回读；本项目回读 getSchema 已有（且 save 链路内建乐观锁）。doc-validator 若引入 mermaid CLI 做可渲染校验，成本远大于收益；建议只做轻量检查：章节存在性 + mermaid 语法括号/箭头配对 + 图中节点 id 与节点清单一致。**「mermaid 可渲染」不作为阻断项。**

**C11. 说明书与 DSL/JSON 的存放关系、同步机制、版本一致性？—— ⚠️ 方案只提问未作答，需明确「派生产物」定位**

- 建议：说明书是 WorkflowPlan/CozeWorkflow 的**纯函数派生产物**，不落盘、不维护版本——工具（generate/update/read）返回时即席渲染；需要给 Qoder 看时用 scripts/generate-doc.ts 从 .dsl/.json 现生成，.md 文件标注 generated 不进 git。版本一致性靠「只从源头单向渲染、禁止手改」保证，不靠同步机制。
- 注意方案 2 说明书模板头部写「生成时间/来源」（dsl-human-readable-doc-design.md:84）——「生成时间」暗示落盘产物，与即席生成建议冲突，若走即席生成应去掉时间戳或改为「渲染于本次调用」。

### D. 实施与边界

**D12. P1-P5 顺序合理吗？两个 P1 哪个先做？能否合并？—— ⚠️ 两 P1 可合并且应合并，但句柄化要插到最前面**

- 最该先做的是**句柄化**（方案 1 P4 的前半），不依赖 DSL、不依赖反转换（cache hit 路径），直接解决用户点名痛点，工作量最小（新增 workflow-cache.ts + 改 update-workflow/save 两个工具）。
- 两个方案的 P1 天然合并：read_workflow 的输出**就是** workflow-to-doc 的产物（方案 1 P1 说「先转 LLM 可读简化版喂给它」与方案 2 的说明书是同一件事）。合并后 P1 = platformToProject + read_workflow（输出说明书格式），一份反转换同时喂饱「LLM 读」和「人类读」两个需求。
- 建议顺序：P1 句柄化 → P2 读工作流 + 说明书 → P3 DSL 实测（A/B 门禁）→ P4 DSL 落地（仅当 P3 通过）→ P5 回归。

**D13. 两方案都没覆盖的边界情况？—— ⚠️ 以下四项遗漏，按重要性排序**

1. **缓存 stale 覆盖平台人工修改**（最重要）：saveWorkflow 每次都重新 getSchema 拿最新 commit 后提交（coze.client.ts:130-131），但**提交内容来自缓存**——若用户（或另一个 Agent 会话）在平台侧手工改过工作流，缓存未刷新时 save 会用旧内容覆盖平台改动，且乐观锁拦不住（commit 是新的）。方案 5.3 提了「stale 检测可用 submit_commit_id 比对」，但没把它写进 update/save 流程步骤。必须加：cache hit 时先 getSchema 比对 submit_commit_id，不一致 → platformToProject 刷新缓存并提示 LLM「线上已被改动，已重新拉取」。
2. **并发保存 / 多会话共享缓存**：模块级 iteration-counter 按 workflowId 计数（iteration-counter.ts），两个会话同时修同一 workflowId 会互相耗尽对方的 3 轮上限；缓存是单 Map，无 owner 概念。建议缓存条目记录 ownerSessionId + lastModifiedAt，跨会话访问时警告。
3. **DSL id 命名规则未定义**：DSL 示例 id 全英文（transcribe/compare），但语法约束没写 id 是否允许中文、非法字符如何处理。现状平台 title 是中文（「LLM 处理」），platformToProject 推导 id 时若 title 含中文/重名，规则缺失（见 B7）。
4. **50+ 节点测试样本缺失**：两份方案的分层策略都只在 21 节点样本上验收（dsl-design.md:211），大图分层/切片逻辑无样本可测。建议从平台拉一个 40+ 节点真实工作流做基准。

**D14. workflow-cache 模型有遗漏吗？—— ⚠️ 三处遗漏**

1. **dirty 中间态**：update_workflow 修改的是缓存对象，save 失败（validate_tree/凭证）后缓存已是脏状态，下次 update 会基于脏缓存继续——需要 dirty 标记或「save 前快照」，save 失败时回滚缓存。
2. **commitId 获取时序**：saveWorkflow 不返回 commit id（coze.client.ts:125-157），方案说缓存记录 commitId，但 save 成功后拿不到新 commit——要么 save 后额外调一次 getSchema（多一次请求），要么接受「缓存无 commitId、下次使用时再 getSchema」。方案 5.3 未说明。
3. **内存上限与 TTL 基准**：Map 无上限。21 节点 workflow ≈ 10-30KB，LRU 上限 200 条即可；TTL 建议对齐 session 生命周期（session 销毁清缓存），不要与平台 15 分钟编辑锁耦合（语义不同）。

### E. 落地建议

**E15. 只选一个先落地（1-2 周），选哪个？—— 句柄化 + 读工作流，不含 DSL**

具体文件（按依赖序）：

1. `agent/workflow-cache.ts`（新增，~100 行：Map + TTL/LRU + dirty 标记 + commitId 记录）
2. `agent/tools/update-workflow.tool.ts`（参数瘦身：workflow 改 optional，从缓存取；返回只给 changes 摘要不给完整 JSON）
3. `agent/tools/save.tool.ts`（workflow 参数 optional，workflowId 命中缓存时从缓存取；save 成功后写缓存 + 记录 commitId）
4. `workflow-engine/platform-to-project.ts`（新增反转换：类型数字→字符串、100001/900001→start/end、ref→inputMapping、llmParam→LLM 配置）
5. `agent/tools/read-workflow.tool.ts`（新增：workflowId → platformToProject → 说明书格式摘要）+ list_workflows 工具（包装现有 CozeClient.listWorkflows）
6. `agent/tools/index.ts` + `react-agent.service.ts` 系统提示词（新工具说明 + save 规则更新）

验收标准：一个完整迭代闭环（plan→generate→save→batch_validate→update→save）中，LLM 上下文不再出现完整 workflow JSON（以日志 `tool_start` 入参长度 ≤ 200 字节为准）；read_workflow 能读回 21 节点样本并输出可读说明书。

第二周增量：workflow-to-doc + mermaid-generator（与 read_workflow 合并输出，见 D12）。

**E16. 第三选择（两方案都没想到的）—— 读路径用说明书，写路径用句柄化，DSL 后置**

- 方案 1 假设「LLM 需要一种既能读又能写的 IR」，于是 DSL 要双向、要 round-trip——这是复杂度的主要来源。但拆开看：**读**的需求（LLM 读线上工作流、人类看工作流）由「platformToProject → workflow-to-doc 说明书」天然满足（说明书就是 LLM 可读的简化版，Markdown/mermaid 的 token 效率不低于自造 DSL，且模型先验更强）；**写**的需求由句柄化满足（LLM 只传 workflowId + fixInstruction，一行 DSL 都不写）；**全量重设计**场景才需要 LLM 重新输出结构——此时仍用现有骨架 JSON（zod 校验 + 下标依赖），仅当 A/B 实测证明 JSON 正确率确实不达标时，才把「设计 DSL」作为替换品引入，且只需正向（parser），不需要反向（workflow-to-dsl）——round-trip 复杂度直接砍半。
- 这个组合的总工程量 ≈ 方案 1 的 40%，收益覆盖方案 1 的 90%（唯一放弃的是「LLM 用 DSL 文本做全量重设计」的未验证收益）。

---

## 三、发现的问题清单（按严重度）

### 致命

**F1. DSL「行级可部分解析」在 jsonMode 传输层下不成立，方案未给出可落地的修复位置**

- 现象：dsl-design.md 二点五节承认「DSL 会被 JSON 包一层，JSON 断了外层仍整体失败」，但只给结论，未说明 repair 插在哪一层。
- 证据：LangChain 工具参数反序列化在框架内完成，业务代码拿不到原始 JSON 文本；deepseek.client.ts:238-241 强制 jsonMode。
- 影响：DSL 的三大卖点之一失效，行式容错收益无法兑现。
- 修复建议：放弃「行级容错」叙事，改为「工具 schema 用 z.string() 接收 DSL 文本 + 工具内独立 parser + 截断续写」；或接受整体失败依赖现有截断检测（deepseek.client.ts:169-198）。

**F2. 「generator 零改动」与「EDGE 显式边抑制自动补边」自相矛盾**

- 现象：dsl-design.md 3.2.1 说「EDGE 优先级高于自动补边」，六节说「generator.ts 不动」。
- 证据：generator.ts:249-289 createConditionEdges 无条件删除 condition 节点全部出边重建；:218-247 createLLMEdges 强制补 branch_error + default 端口。
- 影响：按方案实施后，DSL 显式端口边会被 generator 静默删除，生成产物与 DSL 不一致。
- 修复建议：明确「DSL 只表达业务拓扑，平台强制边由 generator 补」；DSL 条件分支边翻译为 branches[].targetNodeId 而非依赖边。

### 重要

**I1. 方案 2 把 dsl-parser 当作「已有」文件，与代码事实不符**

- 现象：dsl-human-readable-doc-design.md:187 写「dsl-parser.ts # 已有（接 L1）」「dsl.spec.ts # 已有」。
- 证据：workflow-engine/ 目录现状只有 planner/generator/code-generator/types/platform-validator 五个文件，dsl-parser.ts、dsl.spec.ts 均不存在（它们属于方案 1 的 P2 新增物）。
- 影响：方案 2 的 L1 层实际没有地基，P2「接入 dsl-parser」意味着要先落地方案 1 P2。
- 修复建议：方案 2 的 P1 增加「若不依赖 DSL，L1 校验层先用现有 validateWorkflow + platform-validator 顶替」，或明确依赖方案 1 P2 先行。

**I2. 缓存 stale 会覆盖平台侧人工修改**

- 现象：dsl-design.md 5.3 提到 stale 检测但未纳入 update/save 流程。
- 证据：coze.client.ts:125-157 saveWorkflow 每次重新 getSchema 拿最新 commit 后提交，但提交内容来自缓存——乐观锁只防 commit 过期，不防内容覆盖。
- 影响：多会话/人工协作场景下，旧缓存 save 会抹掉平台上的最新改动。
- 修复建议：cache hit 时先 getSchema 比对 submit_commit_id，不一致 → platformToProject 刷新缓存并告知 LLM。

**I3. per-node config 与两段式 Stage 2 的并存关系未定义**

- 现象：DSL 配置行（`<id>.prompt`）与 Stage 2 逐节点 nodeConfig 是两个来源，方案待决策 2「倾向保留两段式」但未定义冲突时谁覆盖谁。
- 证据：planner.ts:200-226 aggregateConfigs 现状「同类型多节点后者覆盖前者」是真实缺陷；PlanStep.nodeConfig per-step 携带（planner.ts:358）说明 per-node 化只需改聚合函数。
- 修复建议：定义「DSL 配置行仅用于读/改（反向）场景，正向生成仍走 Stage 2」，parser 配置行解析降级为修改指令输入。

**I4. round-trip 断言缺三类豁免，且平台数字 id → 语义 id 无稳定映射机制**

- 现象：dsl-design.md 4.5 断言「节点/边/端口/配置/透传区」语义相等，未豁免自动边（branch_error/false/default）、LLM 产物（Python code 非确定性）、平台默认值（llmParam 14 项大部分硬编码）；4.4 承认需要「id 生成策略」补充但未给机制。
- 证据：generator.ts:218-289 自动补边；code-generator.ts LLM 生成非确定性；schema-converter.ts:280-311 硬编码默认值；平台 title 由 nodeLabelForType 生成、同类型重名（generator.ts:668-681）。
- 影响：round-trip 测试将永远红；读工作流后 LLM 引用节点的 id 不稳定。
- 修复建议：豁免清单 + 按「title+类型+拓扑序」确定性推导 id，并接受节点增删后 id 漂移。

**I5. update_workflow 句柄化后「LLM 分析 DSL」步骤多余**

- 现象：dsl-design.md 5.4 流程第 3-4 步「workflowToDsl → LLM 分析 DSL + fixInstruction → 输出结构化指令」。
- 证据：现状工具内部已有 parseInstruction 用 DeepSeekClient.chatStructured 解析指令（update-workflow.tool.ts:92-109），输入是「节点摘要 + fixInstruction」——句柄化后节点摘要从缓存取即可，主循环 LLM **不需要**看 DSL。
- 影响：方案 1 的句柄化仍给主循环 LLM 塞 DSL 文本，token 节省打折、设计复杂化。
- 修复建议：update_workflow 完全黑盒化（{workflowId, fixInstruction} → changes 摘要），DSL 展示仅保留给 read_workflow/说明书。

### 建议

**S1. 文档内部版本号不一致**：dsl-design.md 头部 v0.1（:3），末尾讨论记录 v0.3（:446），review prompt 引为 v0.3。统一为 v0.3。
**S2. 章节编号重复**：dsl-design.md 出现两个「## 十」（:383 风险与验证、:425 待决策问题），第二个应为「十二」且与 :434「十二、最终建议」冲突，需整体重编号。
**S3. DSL 示例与语法约束自相矛盾**：3.4 示例写 `NODE done END IN()` 与 `EDGE judge:true->done`，与 3.2.1「start/end 不写在 NODE 里」矛盾；透传区 3.2 写 `#!platform <scope>: {...}`，3.4 示例写 `#!platform compare: {...}`，格式不一致。
**S4. 收益表归因错误**：5.5 表把句柄化收益（token 8-10K→1-2K）计入 DSL 方案，应拆分（见 A2）。
**S5. list_workflows 被列为 P1 新能力，实际底层已有**：coze.client.ts:296-306 listWorkflows() 已实现（page/size），P1 只需包装工具层。
**S6. 50+ 节点样本缺失**：两方案分层策略均只在 21 节点样本验收，需补大图基准。
**S7. 说明书模板「生成时间」字段暗示落盘产物**：与即席生成的派生产物定位冲突（见 C11）。
**S8. 方案 1 问题 B「4-6 次背诵」表述**：与现状一致（generate 输出→save 传入→update 传入+返回→save 再传），属实，无问题；但「每次 8-10K token」为估算值，建议以实测 tool_start 日志（react-agent.service.ts:434-439）入参长度为准。

---

## 四、第三选择建议（详见 E16）

**读路径用说明书，写路径用句柄化，DSL 仅作为「全量重设计正确率实测不达标」时的条件性替换品，且只做正向不做反向。**

- 读：platformToProject → workflow-to-doc 说明书（LLM 和人类共用一份产物）
- 改：update_workflow / save 句柄化（LLM 零 DSL、零 JSON 背诵）
- 重设计：先用现有骨架 JSON；仅当 A/B 实测（JSON vs DSL 各 N=10）证明 JSON 不达标时引入正向 DSL（parser 一项），不做 workflow-to-dsl、不做 round-trip

---

## 五、最终推荐的实施顺序

| 阶段                                        | 内容                                                                                                                                               | 交付物                 | 验收标准                                                                                                                                               |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **P1 句柄化**（1 周）                       | workflow-cache（Map+TTL/LRU+dirty 标记+commitId）+ update_workflow 参数瘦身 + save 支持缓存 + stale 检测（getSchema 比对 submit_commit_id）        | 3 个文件改动           | 一个完整迭代闭环中 LLM 上下文无完整 workflow JSON（tool_start 日志入参 ≤ 200 字节）；save 失败后缓存回滚（dirty 标记生效）                             |
| **P2 读工作流 + 说明书**（1 周）            | platformToProject 反转换 + read_workflow（输出说明书格式）+ list_workflows 工具 + workflow-to-doc/mermaid-generator（分层：总览表 + ≤10 节点子图） | 4 个新文件 + 2 个工具  | 21 节点样本反转换正确（字段对照 platform-facts.md）；说明书 7 章节齐全、mermaid 每张 ≤10 节点；LLM 能基于 read_workflow 输出回答「这个工作流为什么错」 |
| **P3 DSL A/B 实测**（3 天，门禁）           | 同一批复杂需求（3 个：含分支/merge/多输入），JSON vs DSL 各 N=10，统计语法合法率/语义正确率/平均 token                                             | 实测报告               | 若 DSL 语义正确率 < JSON 的 90% → 砍掉 DSL，方案终止于此；否则继续 P4                                                                                  |
| **P4 DSL 正向落地**（仅当 P3 通过，1-2 周） | dsl-parser（→WorkflowPlan）+ plan-prompt 改写（Stage 1 输出 DSL）+ 自动边/LLM 产物豁免清单                                                         | parser + prompt + 测试 | 3 个复杂需求 DSL 正确率 ≥ 实测基线；round-trip（仅正向：DSL→WorkflowPlan→generator 产物与 JSON 路径一致）                                              |
| **P5 回归**（3 天）                         | 歌曲识别等原有用例全链路 + 真实样本（含平台拉取的 40+ 节点工作流）                                                                                 | 回归报告               | 原有用例全部通过；大图分层策略在真实样本上可读                                                                                                         |

**明确不建议做的**：workflow-to-dsl 反向序列化器与 DSL→JSON→DSL 双向 round-trip（价值未验证、成本最高、被 id 映射问题拖累）；doc-validator 引入 mermaid CLI 渲染校验；说明书句式模板多样化。

---

## 六、「方案里写错了 / 与代码事实不符」的地方

1. **dsl-human-readable-doc-design.md:187-189**：「dsl-parser.ts # 已有」「dsl.spec.ts # 已有」——均不存在，属方案 1 P2 的新增物（见 I1）。
2. **dsl-design.md 3.4 示例 vs 3.2.1 约束**：示例写了 `NODE done END`，约束说 start/end 不写 NODE（见 S3）。
3. **dsl-design.md 六节「generator.ts 不动」 vs 3.2.1「EDGE 优先抑制自动补边」**：createConditionEdges 无条件重建，不改 generator 无法实现（见 F2）。
4. **dsl-design.md 5.3「save 成功后写入缓存并记录 commitId」**：saveWorkflow 不返回 commit id，需要 save 后额外 getSchema（见 D14-2）。
5. **dsl-design.md 5.5 收益表归因**：token 节省来自句柄化，非 DSL（见 A2）。
6. **dsl-design.md 4.4「platformToProject 是读工作流能力的地基」**：方向对，但方案 1 P1 把 list_workflows 列为新增能力——CozeClient.listWorkflows（coze.client.ts:296）已存在，只差工具层包装（见 S5）。
7. **dsl-design.md 5.4「LLM 分析 DSL + fixInstruction」**：工具内部 parseInstruction（update-workflow.tool.ts:92-109）已承担指令解析，主循环 LLM 不需要读 DSL（见 I5）。
8. **dsl-human-readable-doc-design.md 六节 L3 写「platform-validator（现有）」**：属实（platform-validator.ts 存在），无问题；但 L1 dsl-parser 写「已有」错误（见第 1 条）。
9. **review-prompt 引 dsl-design 为 v0.3**：文件头仍是 v0.1（:3），需同步（见 S1）。
10. **dsl-design.md 问题 B「JSON 进出 LLM 上下文 4-6 次」**：与 generate/save/update 三工具的现状一致，属实。
11. **dsl-design.md 三节「引用用 id 不用下标」的动机**：属实（planner.ts:347-349 dependencies 用 steps 下标 + `d === -1` 约定，易错）；但「40% token 是元信息冗余」为估算——mode/inputType/outputType/needBranch/needCodeNode/needDatabaseNode 六个字段在权威路径（explicitSteps 存在时）确实只被 superRefine 要求输出、不被消费（planner.ts:342-383 仅 fallback 路径用 needXxx），冗余属实，比例待实测。
