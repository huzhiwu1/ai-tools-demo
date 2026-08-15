# Qoder 任务单：P1 句柄化 + P2 读工作流与说明书（合并实施）

> 依据：codex 评审结论（docs/codex-review-dsl-dual-product.md）。DSL 方案暂缓（P3 门禁后决定），本期只做「句柄化 + 读工作流 + 说明书」。
> 请严格按本任务单实施，**不要引入 DSL、不要改 generator/schema-converter 的正向链路**。

---

## 一、任务目标

1. **句柄化**：update_workflow / save_to_coze 不再要求 LLM 传完整 workflow JSON，改为从服务端缓存取（workflowId 句柄 + fixInstruction）。
2. **读工作流**：新增 read_workflow / list_workflows 工具，让 LLM 能读平台已有工作流。
3. **说明书**：新增 workflow-to-doc，把工作流渲染成人类可读 Markdown 说明书（含 mermaid 拓扑图、节点清单、数据流说明、验证报告），LLM 不参与说明书写作。

## 二、项目背景

- 项目：`agent-coze-workflow`（NestJS + LangGraph createReactAgent + 私有 Coze + DeepSeek）
- 现状痛点（已核实）：
  - `update-workflow.tool.ts` schema 要求 `workflow: z.record(...)` 完整 JSON（LLM 背诵大 JSON，一个错全挂）
  - `save.tool.ts` 同样要求 workflow 参数
  - 无读工作流工具（`CozeClient.getSchema/listWorkflows` 已实现但未暴露为工具）
  - `schema-converter.ts` 只有正向（项目→平台），无反向（平台→项目）
- 平台节点类型数字（schema-converter.ts:35-49 已实测）：1=start 2=end 3=llm 5=code 8=condition(选择器) 15=text 32=merge 43=database_query 45=http；平台约定 start=100001、end=900001

## 三、必读文件（动手前先全部读一遍）

- `apps/api/src/agent/tools/update-workflow.tool.ts`（现状：完整 JSON 参数 + parseInstruction + findTargetNode）
- `apps/api/src/agent/tools/save.tool.ts`（现状：workflow 参数 + convertToPlatformSchema + validateTree + saveWorkflow）
- `apps/api/src/agent/tools/index.ts`（ALL_TOOLS 注册 + withToolLog 包装）
- `apps/api/src/agent/tools/iteration-counter.ts`（迭代计数）
- `apps/api/src/coze/coze.client.ts`（getSchema/saveWorkflow/listWorkflows/listModels/validateTree）
- `apps/api/src/coze/schema-converter.ts`（正向转换结构，反转换的对齐基准）
- `apps/api/src/workflow-engine/types.ts` 与 `packages/workflow-schema/src/types/index.ts`（CozeWorkflow 结构）
- `apps/api/src/workflow-engine/platform-validator.ts`（checkPlatformCompatibility）
- `apps/api/src/agent/react-agent.service.ts`（SYSTEM_PROMPT 工具说明）
- `docs/coze-platform/health-workflow-103-nosnack-sample.json`（21 节点平台样本，反转换验收基准）
- `docs/codex-review-dsl-dual-product.md`（评审结论，本期依据）

---

## 四、任务 A：新增 `apps/api/src/agent/workflow-cache.ts`

服务端工作流缓存（内存 Map）。约 100 行。

```ts
// 接口设计
interface CachedWorkflow {
  workflow: Record<string, unknown>; // CozeWorkflow 形状（meta/nodes/edges）
  updatedAt: number;
  commitId?: string;        // 平台 submit_commit_id（stale 检测用）
  dirty: boolean;           // update 修改后未保存
  ownerSessionId?: string;  // 写入方会话（并发警告用，可后续扩展）
}

export class WorkflowCache {
  get(workflowId: string): CachedWorkflow | undefined;
  set(workflowId: string, workflow: Record<string, unknown>, opts?: { commitId?: string }): void;
  markDirty(workflowId: string): void;      // update 修改后调用
  clearDirty(workflowId: string): void;     // save 成功后调用
  remove(workflowId: string): void;
  size(): number;
}

// 模块级单例导出
export const workflowCache = new WorkflowCache();
```

要求：
- TTL：条目超过 30 分钟视为过期（get 时检查，过期返回 undefined）。
- LRU 上限：200 条，超出淘汰最久未访问（维护 lastAccessAt）。
- dirty 语义：update_workflow 修改缓存对象后 markDirty；save_to_coze 成功后 clearDirty 并刷新 updatedAt。
- 不落盘、不持久化（重启丢失可接受，miss 时从平台拉取兜底）。
- 参考 codex 评审 D14：save 失败后缓存回滚——**save 失败时恢复 dirty 前的快照**（见任务 C 的实现细节）。

## 五、任务 B：改造 `apps/api/src/agent/tools/update-workflow.tool.ts`

### 5.1 schema 瘦身

```ts
schema: z.object({
  workflow: z.record(z.string(), z.any()).optional()
    .describe("可选。当前工作流 JSON。不传时从服务端缓存按 workflowId 获取（推荐：句柄化，避免背诵大 JSON）"),
  workflowId: z.string()
    .describe("工作流 ID（save_to_coze 返回的 platformWorkflowId），用于从缓存取工作流和迭代计数"),
  fixInstruction: z.string()
    .describe("修改指令（自然语言），如「把『相似度计算』节点的阈值从 0.8 改为 0.6」"),
})
```

### 5.2 内部逻辑（替换 workflow 获取段）

```
1. iteration 计数（保留现状 incrementIteration + MAX_ITERATIONS）
2. wf = 参数 workflow ?? workflowCache.get(workflowId)?.workflow
   - 缓存 miss 且参数也没传 → 返回错误字符串：
     "工作流更新失败: 未找到工作流缓存（workflowId=xxx）。请先调用 read_workflow 或 save_to_coze 后再修改，或在参数中传入 workflow"
3. stale 检测（缓存命中时）：
   - 若缓存条目无 commitId → 调 cozeClient.getSchema(workflowId) 取 submitCommitId 补记
   - 若缓存 commitId ≠ 平台最新 submitCommitId → 用 platformToProject(getSchema.schemaJson) 刷新缓存，返回提示：
     "线上工作流已被修改，已从平台重新拉取最新版本，请基于最新版本重新描述修改指令"
4. 其余逻辑不变：parseInstruction(summarizeNodes(wf), fixInstruction) → findTargetNode → 按 type 修改
5. 修改成功后：workflowCache.markDirty(workflowId)（若 wf 来自缓存）
6. 返回：**不再返回完整 workflow**，改为：
   `JSON.stringify({ changes, workflowId, dirty: true }, null, 2)`，
   提示 LLM「修改已应用，请调用 save_to_coze（传 workflowId）保存」
```

注意：summarizeNodes / parseInstruction / findTargetNode / 各 type 分支逻辑**全部保留不动**，只改 workflow 来源与返回值。

## 六、任务 C：改造 `apps/api/src/agent/tools/save.tool.ts`

### 6.1 schema

```ts
schema: z.object({
  workflow: z.record(z.string(), z.any()).optional()
    .describe("可选。工作流 JSON。不传时从服务端缓存按 workflowId 获取（句柄化）"),
  workflowId: z.string().optional()
    .describe("已有工作流 ID（可选）。传了=更新该工作流；不传=首次创建"),
})
```

### 6.2 内部逻辑

```
1. 解析目标工作流：
   cozeWorkflow = 参数 workflow ?? workflowCache.get(workflowId)?.workflow
   - 两者都没有 → 返回错误字符串：
     "保存失败: 未提供 workflow 且缓存中无此工作流。请先 generate_workflow 生成后再保存"
2. 结构校验 / 平台兼容校验 / convertToPlatformSchema（保留现状）
3. 创建或更新（保留现状 createWorkflowWithRetry / isUpdate 逻辑）
4. validateTree 失败处理：保留现状（首次创建删空壳；更新保留原工作流）
5. saveWorkflow 成功后：
   - 若 workflowId 来自缓存 → workflowCache.clearDirty(workflowId)
   - 若首次创建（新 platformWorkflowId）→ workflowCache.set(platformWorkflowId, cozeWorkflow)
6. 返回不变：{ workflowId, saved, name, updated }
```

### 6.3 save 失败回滚（codex D14-1）

- save 前：若目标来自缓存且 dirty，先保留 `const snapshot = JSON.parse(JSON.stringify(cached.workflow))`。
- save 失败（validate_tree 报错或抛异常）→ 用 snapshot 恢复缓存对象、dirty 保持 true，返回错误字符串（现状错误信息即可）。
- save 成功 → 丢弃 snapshot，clearDirty。

## 七、任务 D：新增 `apps/api/src/workflow-engine/platform-to-project.ts`

平台 schema JSON → 项目 CozeWorkflow 反转换器。**这是本期最大新代码**，请对照 schema-converter.ts 正向逻辑逐项逆向。

### 7.1 接口

```ts
export interface PlatformToProjectResult {
  workflow: CozeWorkflow;          // 项目格式（meta/nodes/edges）
  warnings: string[];              // 无法还原的字段警告
  rawSchema: Record<string, unknown>; // 原始平台 schema（透传保留）
}

export function platformToProject(schemaJson: string): PlatformToProjectResult;
```

### 7.2 映射规则（对照 schema-converter.ts）

- 节点 type 数字 → 项目类型：`"1"→start "2"→end "3"→llm "5"→code "8"→condition "15"→text "32"→merge "43"→database_query "45"→http`；未知数字 → warning + 保留数字
- 节点 id：平台数字 id → 项目 id 直接用 `String(id)`（**不要做语义化映射**，保持稳定）
- start/end：平台 100001/900001 → start/end 类型（注意：样本中 start/end 可能不在 nodes 里，而是隐式的；对照 schema-converter.ts:138-183 的 start/end 处理）
- llm 节点（type=3）：
  - `data.inputs.llmParam` → `config.model`（modleName）/ `config.temperature` / `config.maxTokens`
  - `data.inputs.inputParameters`（ref 类型）→ `inputMapping`（还原 "nodeId.outputName" 形式）
  - `data.outputs` → `outputs`（业务输出，过滤 reasoning_content/errorBody/isSuccess 平台内置字段）
- code 节点（type=5）：`data.outputs` → outputs（注意 object/list schema 的还原，对照 schema-converter.ts:385-413 的 normalizeSchema 逆向）；language 数字 → "python"/"javascript"
- condition 节点（type=8）：`data.branches` → branches（保留 label/condition）
- 其他节点类型：尽力还原通用字段（inputs/outputs/title），无法还原的进 warnings
- title：平台节点 title 直接用（中文名保留）
- edges：`sourceNodeID/targetNodeID/sourcePortID` → 项目 edge（source/target/port）；无端口边 port 省略
- **无法还原的节点级字段**（如 settingOnError、llmParam 里无法映射的项）→ 存入节点 `_temp.externalData.platformRaw`（原样保留，防丢）

### 7.3 验收基准

- 对 `docs/coze-platform/health-workflow-103-nosnack-sample.json` 的 `json` 字段（{nodes, edges}）反转换：
  - 节点数 = 21，边数 = 25（样本数据）
  - 所有节点 title 非空、type 映射正确（样本 type 分布：5×8、3×5、8×3、15×3、32×1、43×1）
  - llm 节点 config.model 还原正确（对照样本 llmParam 的 modleName）
  - warnings 只含确实无法还原的字段

注意：样本是剪贴板格式（`{type:"coze-workflow-clipboard-data", json:{nodes,edges}}`），而 getSchema 返回的是 schemaJson 字符串。**函数入参统一为 schema JSON 字符串**；本地测试时可直接把样本的 `json` 字段 JSON.stringify 后传入。若 getSchema 的 schemaJson 结构与样本不同（需实测确认），在函数内做兼容适配（识别两种结构）。

## 八、任务 E：新增 `apps/api/src/workflow-engine/workflow-to-doc.ts` + `mermaid-generator.ts`

把 CozeWorkflow（项目格式）渲染成人类可读 Markdown 说明书。**纯函数、无 LLM 调用**。

### 8.1 `mermaid-generator.ts`

```ts
export function workflowToMermaid(workflow: CozeWorkflow, opts?: { maxNodesPerGraph?: number }): string[];
```

- 返回一个或多个 mermaid flowchart（字符串数组）
- 分层规则：按拓扑序分段，每张图 ≤ 10 个节点（默认）；节点 id 用 title（转义 `[`/`]`/`(`/`)`/引号/`#` 等特殊字符，避免破坏 mermaid 语法）
- 边带端口：condition 分支边标注 `-- "true/false" -->`；llm 的 branch_error 边标注 `-- "branch_error" -->`
- 图间用注释分隔：`<!-- graph 1/3 -->`

### 8.2 `workflow-to-doc.ts`

```ts
export interface WorkflowDocOptions {
  source?: "cache" | "platform" | "draft";  // 来源标注
  showRaw?: boolean;                        // 是否展示透传区原始 JSON
}
export function workflowToDoc(workflow: CozeWorkflow, opts?: WorkflowDocOptions): string;
```

输出 Markdown，章节固定（7 章节）：

```markdown
# 工作流说明书：<name>

> 来源：<source>｜节点数：N｜边数：M｜生成时间：渲染于本次调用

## 1. 概览
- 名称 / 描述 / 输入 / 输出 / 节点数 / 边数 / 校验状态

## 2. 拓扑图
（workflowToMermaid 输出的 mermaid 代码块，多图则多段）

## 3. 节点清单
| # | id | 类型 | title | 输入 | 输出 |

## 4. 数据流说明
（按拓扑序遍历：start → A（LLM 识别歌词）→ B（计算相似度）→ ... 简单句，不追求文采）

## 5. 配置详情
（每节点一节：### <title>（<type>）；列出 model/prompt/temperature/condition/branches 等关键配置；无配置写"无"）

## 6. 验证报告
- 结构校验：validateWorkflow(workflow) 结果（通过/错误列表）
- 平台兼容：checkPlatformCompatibility(workflow) 结果
- 悬空边检查：边引用的节点 id 是否存在（不存在的列出）

## 7. 透传区（如有）
（showRaw 时展示 _temp.externalData.platformRaw 的 JSON 摘要）
```

要求：
- 校验状态 = validateWorkflow + checkPlatformCompatibility 真实结果拼接（**不编造**）
- 数据流说明由代码遍历 edges 生成，节点注释用 title
- 说明书不落盘、不维护版本（即席渲染的派生产物）

## 九、任务 F：新增两个读工具

### 9.1 `apps/api/src/agent/tools/read-workflow.tool.ts`

```ts
schema: z.object({
  workflowId: z.string().describe("平台工作流 ID（list_workflows 或 save_to_coze 返回）"),
  scope: z.enum(["overview", "full"]).optional()
    .describe("overview=只输出概览+节点清单+数据流（默认，省 token）；full=完整说明书含配置详情与验证报告"),
})
```

逻辑：
1. cozeClient.getSchema(workflowId) → schemaJson
2. platformToProject(schemaJson) → workflow
3. workflowCache.set(workflowId, workflow.workflow, { commitId: submitCommitId })（写缓存，供 update/save 句柄化复用）
4. workflowToDoc(workflow.workflow, { source: "platform", showRaw: scope === "full" })
5. scope=overview 时截断：只保留 1-4 章节
6. 返回说明书 Markdown；若反转换有 warnings，追加一段 `> ⚠️ 反转换警告: ...`

### 9.2 `apps/api/src/agent/tools/list-workflows.tool.ts`

```ts
schema: z.object({
  keyword: z.string().optional().describe("按名称模糊搜索（可选）"),
  size: z.number().optional().describe("每页条数，默认 15"),
  cursor: z.string().optional().describe("分页游标（上页返回的 cursor；不传=第一页）"),
})
```

逻辑：cozeClient.listWorkflows（需改底层接口，见下）→ 过滤（keyword 匹配 name）→ 返回 `[{ workflowId, name, desc }]` 摘要数组。

**⚠️ 必须先改 `coze.client.ts` 的 `listWorkflows`（2026-08-16 志武实测确认）**：

- **现状（错误）**：调 `workflow_list` 接口，page/size 分页，返回 `workflow_list`——平台实际不支持此接口。
- **正确实现（与 listDatabases 同款接口，见 coze.client.ts:308-336 对照）**：

```ts
/**
 * 获取工作流列表
 *
 * 接口：POST /api/plugin_api/library_resource_list（res_type_filter=[2]=工作流）
 * 2026-08-16 实测：返回 resource_list[]，workflowId 在 res_id 字段，
 * 分页用 cursor + has_more（不是 page/size）。
 * 请求体示例：{user_filter:0, res_type_filter:[2], name:"", publish_status_filter:0,
 *             space_id, size:15, is_get_imageflow:true, owner_ids:[], desc:"", res_id:""}
 */
async listWorkflows(size = 15, cursor?: string): Promise<{
  workflows: Array<{ workflowId: string; name: string; desc: string }>;
  cursor: string;
  hasMore: boolean;
}> {
  const res = await this.request<{
    cursor: string;
    has_more: boolean;
    resource_list: Array<{
      res_id?: string;   // ⚠️ 工作流 ID 在 res_id，不是 id
      name?: string;
      desc?: string;
      res_type?: number; // 2=工作流
      publish_status?: number;
    }>;
  }>(
    "plugin_api/library_resource_list",
    {
      user_filter: 0,
      res_type_filter: [2],
      name: "",
      publish_status_filter: 0,
      space_id: this.spaceId,
      size,
      is_get_imageflow: true,
      owner_ids: [],
      desc: "",
      res_id: "",
      ...(cursor ? { cursor } : {}),
    },
    "/api/",
  );
  return {
    workflows: (res.data.resource_list ?? []).map((item) => ({
      workflowId: item.res_id ?? "",
      name: item.name ?? "",
      desc: item.desc ?? "",
    })),
    cursor: res.data.cursor ?? "",
    hasMore: res.data.has_more ?? false,
  };
}
```

- list_workflows 工具内：size/cursor 透传给底层；keyword 过滤在工具层做（底层不传 name 过滤，保持简单，或实测 name 参数可用则透传）。

### 9.3 注册（`apps/api/src/agent/tools/index.ts`）

- 新增两个 export + 加入 ALL_TOOLS（用 withToolLog 包装，位置放 save 之后）
- 工具描述要写清使用场景：list_workflows=「用户没给 ID 时先搜」；read_workflow=「读线上工作流/解释为什么错/准备修改」

## 十、任务 G：更新系统提示词（`apps/api/src/agent/react-agent.service.ts`）

SYSTEM_PROMPT（:60 附近）「## 可用工具」段补充/更新：

- 新增说明：
  - list_workflows：先搜索后读取
  - read_workflow：读线上工作流，输出人类可读说明书；修改前先读
- 修改 save_to_coze / update_workflow 说明：
  - 工作流 JSON 参数现在**可选**，优先用 workflowId 句柄（不传大 JSON）
  - update_workflow 后必须 save_to_coze（传 workflowId）保存，保存成功才生效

## 十一、验收标准（全部满足才算完成）

1. `npm run build` 通过（apps/api），无 TS 报错。
2. 单元测试（新增 `platform-to-project.spec.ts`）：
   - 21 节点样本反转换：节点数 21、边数 25、type 映射全对、llm config.model 正确
   - workflowToDoc 输出含 7 章节、mermaid 代码块可被基础正则校验（`flowchart` 关键字存在、箭头数量 = 边数或按分层）
3. 端到端手测（写一个 `scripts/e2e-handle-check.ts` 或说明手动步骤）：
   - read_workflow 读回 21 节点样本 → 输出说明书（概览/节点清单/数据流可读）
   - update_workflow 不传 workflow 参数、只传 workflowId + fixInstruction → 从缓存取 → 返回 changes 摘要（不再返回完整 workflow）
   - save_to_coze 不传 workflow、传 workflowId → 从缓存取 → 保存成功 → clearDirty
   - 日志验证：`[Tool] update_workflow 入参=` 长度 ≤ 200 字节（不再出现完整 workflow JSON）
4. stale 检测：手动改平台工作流后，update_workflow 返回"线上已被修改，已重新拉取"提示。

## 十二、约束与明确不做

- **不做**：DSL 语法、workflow-to-dsl 反向序列化、DSL round-trip、mermaid CLI 渲染校验、说明书句式模板多样化
- **不改**：generator.ts、schema-converter.ts 正向转换逻辑、coze.client.ts 核心方法、packages/workflow-schema
- 保持项目风格：文件头注释、zod 字段 describe、错误以字符串返回给 LLM（不抛异常给框架）、工具用 withToolLog 注册
- 中文注释、中文错误提示（与现状一致）
- 不要删除现有工具或改现有工具的描述语义（只增强）

## 十三、实施顺序建议

1. 任务 A（workflow-cache）→ 2. 任务 B/C（句柄化，依赖 A）→ 3. 任务 D（反转换，最大件）→ 4. 任务 E（说明书）→ 5. 任务 F（读工具，依赖 D/E）→ 6. 任务 G（提示词）→ 7. 验收测试

> 提交时说明：本次为 P1+P2 合并（句柄化 + 读工作流 + 说明书），DSL 留待 P3 门禁后决定。
