# 审查任务：update_workflow 操作化重构方案（op 化）

> 用途：给 codex exec 的评审 prompt。请 codex 阅读必读文件，审查方案，输出审查文档到 `docs/codex-review-update-op.md`。**只评审，不改代码。**

---

## 一、项目背景

项目：`agent-coze-workflow`（NestJS + LangGraph createReactAgent + 私有 Coze + DeepSeek）
工具：`update_workflow`——根据 LLM 自然语言修改指令，修改已保存的工作流节点字段。

现状链路：LLM 输出 `{type, target, content}`（type 枚举 + content 自然语言）→ 工具按 type 分支 + 正则解析 content → 修改缓存中的 workflow → save 全量更新到平台。

## 二、待审方案：`docs/update-workflow-op-design.md`（v0.1）

核心改动：
1. 接口从 `{type, target, content}` 改为操作化指令 `{op, ...}`（discriminatedUnion 5 种 op：set / set_ref / rewrite_code / delete_node / delete_edge）
2. FieldPath 白名单（config.model/userPrompt/systemPrompt/code/language/branches/outputs/outputVariables/data）
3. fixInstruction 自然语言仍为入口，内部 chatStructured 解析为 operations 数组，逐条执行
4. 删除节点级联删边；rewrite_code 保留 referenceData 防幻觉；部分失败不中断

## 三、必读文件

### 方案文档
- `docs/update-workflow-op-design.md`

### 关键代码
- `apps/api/src/agent/tools/update-workflow.tool.ts`（现状：type 枚举 + applyOneInstruction + 宽容解析）
- `apps/api/src/workflow-engine/code-generator.ts`（CodeGenerator.generateCode）
- `apps/api/src/agent/tools/iteration-counter.ts`（peekIteration/incrementIteration）
- `apps/api/src/agent/workflow-cache.ts`（缓存：dirty/commitId）

## 四、审查焦点（逐条判定：✅ 同意 / ⚠️ 需修改 / ❌ 反对，附理由与具体修改建议）

### A. 方案方向
1. op 化（结构化操作指令）是否真的解决了"type 膨胀 + content 猜句式"的根本问题？还是换汤不换药？
2. 让 LLM 直接输出 `{op, field, value}` 结构化对象，相比现状 `{type, content}`，对 DeepSeek 的 zod 校验成功率是升是降？有没有实测依据？
3. 有没有更简单的替代方案？（例如：不做 op 化，只把 content 改成结构化字段；或直接用 JSON Patch / RFC 6902 语义）

### B. op 设计
4. 5 种 op（set/set_ref/rewrite_code/delete_node/delete_edge）是否覆盖所有实际修改场景？有没有遗漏（如：改节点类型、改连线端口、改 startInputs、批量改）？
5. `set` 的 value 是 `unknown`——zod 如何校验"值类型对得上字段"？（如 config.model 应为 string，branches 应为数组）要不要每个 field 配一个 value schema？
6. `set_ref` 和 `set field=outputVariables` 是否重叠？能否合并？
7. `delete_node` 级联删边后，若被删节点是 condition，其分支边如何处理？若被删节点是 LLM（有 default+branch_error 出边），删后其他节点入边是否悬空？
8. FieldPath 白名单够不够？缺哪些实际会改的字段？

### C. 解析与兼容
9. fixInstruction 自然语言 → operations 的解析，会不会从"猜句式"变成"猜 op"——同样不可靠？有没有办法让 LLM 直接用 operations 参数（跳过自然语言解析）？
10. 旧 `{type, target, content}` 调用是否要兼容？还是直接破坏性升级（旧调用方只有 LLM，prompt 同步改即可）？
11. LLM 输出 operations 时，`rewrite_code` 的 referenceData 从哪来？LLM 上下文里没有原始歌词库（句柄化后）——是否会导致每次 rewrite 丢数据？

### D. 与现有机制协同
12. 迭代计数（peek/increment）与 op 化结合：多条操作部分成功时计数策略是否合理？
13. 缓存 dirty 标记：op 修改后 markDirty，与现状一致？set_ref 改了 outputVariables 但没改 code，save 时 schema-converter 是否正确消费？
14. 这个重构与"结束节点接线（contract.outputs.source）""LLM 决定结束节点接谁"是否有冲突？

### E. 落地
15. 改动范围（一个文件重写）是否可控？有没有更好的拆分（如独立 operations.ts 模块）？
16. 验收标准的单测用例是否覆盖了所有 op + 边界？缺哪些？

## 五、输出要求

1. 审查结论写入：`docs/codex-review-update-op.md`
2. 结构：总体结论（一段话）+ 分项判定表（A-E 每条 ✅/⚠️/❌ + 理由 + 修改建议）+ 问题清单（按严重度）+ 最终推荐方案（如方案要改，给出修正后的完整设计）+ 明确列出"方案里写错/与代码事实不符"的地方
3. 全程不改代码。

## 六、运行方式（给志武，不是给 codex）

```bash
cd /Users/huzhiwu/workspace/ai-tools-demo/src/agent-coze-workflow
codex exec --full-auto -C . "$(cat docs/review-prompt-update-op.md)"
```
