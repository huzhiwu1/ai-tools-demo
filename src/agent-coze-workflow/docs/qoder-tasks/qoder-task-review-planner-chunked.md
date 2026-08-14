# Codex Review: Qoder 生成的 Planner 截断问题分析与方案

请审查以下两份文档，给出批判性评估：

## 审查文件

1. `docs/deepseek-thinking-model-token-budget-discussion.md`（90 行，问题分析）
2. `docs/qoder-tasks/qoder-task-planner-chunked-output.md`（361 行，技术方案）

## 背景

agent-coze-workflow 的 planner 用 deepseek-v4-flash（思考模型）输出结构化 JSON，频繁被 max_tokens 截断。已尝试 prompt 压缩 73%、maxTokens 调大，均无效。

## 需要审查的关键问题

### 问题 1：讨论文档的根因分析是否准确？

- 思考模型 reasoning_content 与 content 共享 max_tokens 预算 —— 这个判断对吗？
- 和 Qoder 的对比分析（Agent 循环 vs 单次 completion）是否成立？
- 有没有遗漏的关键因素？

### 问题 2：阶段 1（参数层加固）是否合理？

- `maxTokens` 按用途差异化配置（planner 16K，其他 8K）
- 截断感知提额重试（`bind({ max_tokens: 2x })`）
- 这个方案能否真正缓解？有没有副作用？

### 问题 3：阶段 2（分步生成）是最关键的——请逐条审查

- 骨架 + 逐节点并行细化的架构是否合理？
- `Promise.all` 并行调用会不会触发限流（429）？
- 单节点降级策略（失败后无 contract/config）是否安全？generator 能否兜得住？
- 全局一致性（contract 字段语义与骨架脱节）的风险有多大？
- 小需求（单 LLM 节点）下分步生成是否反而更慢、更贵？

### 问题 4：阶段 3（对照实验）设计是否合理？

- 三组对照（基线 / thinking disabled / 分步生成）是否覆盖了关键变量？
- 决策规则（成功率 ≥ 95% 定稿）是否合理？

### 问题 5：整体方案是否比当前更优？

- 和「直接关思考（modelKwargs thinking:disabled）」比，哪个更稳？
- 和「继续堆 maxTokens」比，哪个更经济？
- 这个方案最可能踩的坑是什么？

## 约束

- 不改代码，只做分析
- 不要建议"两个方案都试试看"
- 如果方案有问题，明确指出替代路径
- 给出明确的「推荐 / 不推荐」结论

## 输出格式

1. **总体评价**：一句话
2. **讨论文档评估**：根因分析是否准确（1-2 句）
3. **阶段 1 评估**：参数层加固是否可行（1-2 句）
4. **阶段 2 评估**：分步生成是否是最优解（3-5 句，这是重点）
5. **阶段 3 评估**：实验设计是否合理（1-2 句）
6. **最终建议**：推荐 / 不推荐，以及理由
7. **风险**：如果采纳这个方案，最可能踩的坑