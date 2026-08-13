# Qoder 任务：节点结构确定性生成（LLM 只梳理节点类型与连接，其余全部代码完成）

> 项目：`/Users/huzhiwu/workspace/ai-tools-demo/src/agent-coze-workflow`
> 技术栈：NestJS 11 + LangGraph + pnpm workspace
> **目标：彻底改变"LLM 发明节点结构"的现状。职责边界（用户明确要求，写进代码注释）：**
>
> **LLM 只做这些事（职责边界，用户明确要求）：**
> 1. 从需求中梳理出需要用什么节点（节点类型序列）
> 2. 梳理出节点怎么连接（依赖关系/边）
> 3. **确定每个节点的数据契约**：变量名、输入结构（接收哪些参数）、输出结构（输出哪些字段/类型）、单处理还是批处理（support_batch）
>
> **其余一切由代码完成：** 完整工作流 JSON 组装、inputMapping 自动生成、outputVariables 声明、条件分支 targetNodeId 回填、代码节点代码生成、模型选择（平台事实匹配）、prompt 文本（模板化生成）。
>
> **保存到 Coze 前必须校验工作流 JSON**（结构校验 + 平台兼容性校验），校验不过不保存。

---

## 一、问题清单（从真实运行日志确认）

运行一个"音频识别歌词→匹配歌曲"的工作流，出现以下结构性错误：

1. **节点顺序错误**：LLM 规划出 start→code→condition→llm→end（代码比对在 LLM 识别之前），LLM 反复"调整顺序"也改不对——**节点顺序不该由 LLM 决定，应由代码按 dependencies 拓扑排序**
2. **inputMapping 为空**：LLM 节点、代码节点的输入映射为空，数据流没接上——**inputMapping 应由代码根据 edges 自动生成**
3. **条件分支 targetNodeId 是 "TODO"**：condition 节点 branches 里的目标节点是占位符——**应由代码根据 edges 自动回填**
4. **代码节点缺 outputVariables 声明**：平台 panic `interface conversion: interface {} is map[string]interface {}, not []interface {}`——**代码节点 outputs 未声明，平台无法推断输出类型**
5. **update_workflow 重写代码时幻觉**：把歌词库改成了周杰伦的歌——**update_workflow 不应整体重写代码节点，只应修改业务参数**
6. **generate_workflow 生成的代码节点仍是占位**：logicDescription 未传递到代码生成器

**核心原则（用户明确要求，写进代码注释和 prompt）：**

```
LLM 只从需求中梳理：用什么节点 + 怎么连接。
其他全部由代码完成：
- 节点 schema 构造（字段/结构）
- inputMapping 自动生成（数据流接线）
- outputVariables 声明
- 条件分支 targetNodeId 回填
- 代码节点代码生成（模板 + 参考数据）
- 模型选择（按任务类型从平台事实匹配）
- prompt 文本（基于节点 description 模板化生成）
```

**影响：** 本任务不只是修 bug，还要**简化 LLM 工具契约**（见修复 5）。

---

## 二、修复 1：generator 确定性组装节点结构（核心）

### 文件：`apps/api/src/workflow-engine/generator.ts`

### 1.1 节点顺序：按 dependencies 拓扑排序

`buildWorkflow` 中，**不要按 plan.steps 的原始顺序生成节点**，改为拓扑排序：

```ts
/**
 * 按 dependencies 拓扑排序 steps
 * （LLM 输出的 order 可能错误，代码必须保证 start→...→end 的正确依赖顺序）
 */
function topoSortSteps(steps: PlanStep[]): PlanStep[] {
  const result: PlanStep[] = [];
  const visited = new Set<number>();
  const orderMap = new Map(steps.map((s) => [s.order, s]));

  const visit = (order: number): void => {
    if (visited.has(order)) return;
    visited.add(order);
    const step = orderMap.get(order);
    if (!step) return;
    for (const dep of step.dependencies) visit(dep);
    result.push(step);
  };

  for (const step of steps) visit(step.order);
  return result;
}
```

### 1.2 inputMapping：根据 edges 自动生成

生成节点后，根据 edges（数据流）自动为每个下游节点填充 inputMapping：

```ts
/**
 * 自动生成节点 inputMapping
 *
 * 规则：对于每条边 source→target，若 target 是 llm/code 节点，
 * 把 source 节点的输出（如 start 的 input、llm 的 output）映射为
 * target 节点的输入参数（如 user_input、recognized_lyrics）。
 *
 * 命名约定：
 * - start 的输出 → 输入参数名 user_input
 * - llm 的输出 → 输入参数名 recognized_lyrics / input
 * - code 的输出 → 输入参数名 input
 */
function buildInputMapping(
  nodes: CozeNode[],
  edges: CozeEdge[],
): Map<string, Record<string, string>> {
  // 返回 targetNodeId → { 参数名: "sourceNodeId.outputName" }
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const mapping = new Map<string, Record<string, string>>();

  for (const edge of edges) {
    const source = nodeById.get(edge.sourceNodeId);
    const target = nodeById.get(edge.targetNodeId);
    if (!source || !target) continue;
    if (target.type !== "llm" && target.type !== "code") continue;

    const sourceOutput = this.outputNameForNode(source); // start→"input", llm/code→"output"
    const paramName = target.type === "llm" ? "user_input" : "input";

    const existing = mapping.get(target.id) ?? {};
    existing[paramName] = `${edge.sourceNodeId}.${sourceOutput}`;
    mapping.set(target.id, existing);
  }
  return mapping;
}
```

**重要**：converter 里已支持 `inputMapping` 格式 `"nodeId.outputName"` → ref 引用（`refInput`），所以 generator 只需把 inputMapping 填进节点即可，converter 自动转平台格式。

### 1.3 condition 节点 branches 自动回填 targetNodeId

condition 节点的 branches 不应有 "TODO"——生成完 edges 后，把每个 branch 的 targetNodeId 指向真实的后续节点：

```ts
/**
 * 回填 condition 节点 branches 的 targetNodeId
 *
 * 规则：condition 节点有 N 个分支时，第 i 个分支指向 edges 中
 * 从该 condition 出发的第 i 条边的 target（无出边则指向 end）。
 */
function fillConditionTargets(
  nodes: CozeNode[],
  edges: CozeEdge[],
): void {
  for (const node of nodes) {
    if (node.type !== "condition") continue;
    const outgoing = edges.filter((e) => e.sourceNodeId === node.id);
    const branches = (node as ConditionNode).branches ?? [];
    branches.forEach((b, i) => {
      b.targetNodeId = outgoing[i]?.targetNodeId ?? "900001"; // 兜底 end
    });
  }
}
```

### 1.4 所有节点必须有 outputs 声明

**`packages/workflow-schema/src/types/index.ts`**：给 `CodeNode` 增加 `outputs` 字段：

```ts
export interface CodeNode extends CozeNodeBase {
  type: "code";
  /** 代码内容 */
  code: string;
  /** 运行时语言 */
  language: "javascript" | "python";
  /** 输入变量映射 */
  inputMapping?: Record<string, string>;
  /** 输出变量声明（平台要求，缺失会导致 SetOutputTypesForNodeSchema panic） */
  outputs?: Array<{ type: "string" | "object" | "list" | "integer" | "number" | "boolean"; name: string; schema?: unknown }>;
}
```

**`packages/workflow-schema/src/templates/index.ts`**：`createCodeNode` 默认带 outputs：

```ts
outputs: [{ type: "object", name: "output", schema: {} }],
```

**`apps/api/src/coze/schema-converter.ts`**：code 节点转换时，从节点 outputs 声明生成平台格式（已有 `data.outputs = [{ type: "object", name: "output", schema: {} }]`，改为读 `node.outputs`，缺失用默认）。

---

## 三、修复 2：代码生成器传参完整（不再占位）

### 文件：`apps/api/src/workflow-engine/code-generator.ts` + `generator.ts`

**问题**：`generateCode(logicDescription, inputs)` 的 `inputs` 一直没传对，导致生成占位代码。

**改法**：generator 调 codeGenerator 时，传入真实输入：

```ts
case "code": {
  const cfg = step.nodeConfig?.code;
  // 从 inputMapping 取输入变量名
  const inputNames = inputMapping.get(stepOrderToId.get(step.order) ?? "") 
    ? Object.keys(inputMapping.get(...)!)
    : ["input"];
  let code: string;
  if (this.codeGenerator && cfg?.logicDescription) {
    code = await this.codeGenerator.generateCode(cfg.logicDescription, inputNames);
  } else {
    code = CodeGenerator.buildFallbackCode(inputNames);
  }
  return createCodeNode({
    ...baseOverrides,
    code,
    language: "python",
    outputs: [{ type: "object", name: "output", schema: {} }],
  });
}
```

**CodeGenerator 加强**（`code-generator.ts`）：生成 prompt 里显式传入**用户参考数据**（如歌词库内容），避免 LLM 幻觉：

```ts
async generateCode(
  logicDescription: string,
  inputs?: string[],
  referenceData?: Record<string, string>,  // 用户上传的参考数据（歌词库等）
): Promise<string> {
  const dataHint = referenceData
    ? `用户参考数据（必须原样写入代码常量，不得修改、不得替换）：\n${JSON.stringify(referenceData, null, 2)}`
    : "";
  // prompt 拼接 dataHint，并强调："参考数据必须原样使用，禁止编造或替换为其他内容"
}
```

---

## 四、修复 3：update_workflow 禁止整体重写代码（防幻觉）

### 文件：`apps/api/src/agent/tools/update-workflow.tool.ts`

**问题**：update_workflow 用 LLM 重写整个代码节点，导致歌词库被改成周杰伦。

**改法**：update_workflow 改为**参数级修改**，不整体重写：

1. **阈值修改**：保留现有 `replaceThreshold`（正则替换数字）
2. **prompt 修改**：只改 LLM 节点的 userPrompt/systemPrompt 文本
3. **数据常量修改**：只改代码里的 `SONG_LYRICS = {...}` 等常量块（用正则定位常量名替换）
4. **代码逻辑重写**：**仅当 fixInstruction 明确要求"重写逻辑"时**才允许调 CodeGenerator，且必须传入原工作流的 referenceData（歌词库等），prompt 强调"保留原有参考数据，只改逻辑部分"
5. **禁止**：不允许 LLM 凭空生成全新代码（无 referenceData 时不重写代码节点）

**工具 description 更新**：明确"本工具只修改参数（阈值/prompt/数据），代码逻辑重写需要提供 referenceData"

---

## 五、修复 4：planner 输出顺序规范化

### 文件：`apps/api/src/prompts/plan-prompt.ts` + `workflow-engine/planner.ts`

**PLAN_PROMPT 增加硬约束**：

```
节点顺序必须符合数据流逻辑：start → (llm 识别/处理) → (code 计算/比对) → (condition 分支) → end。
依赖关系（dependencies）必须正确：下游节点的 dependencies 必须包含其直接上游。
禁止出现"代码节点在 LLM 节点之前处理 LLM 的输出"这类逻辑错误。
```

**planner 映射时**：如果 LLM 输出的 steps 顺序明显违反"start 第一、end 最后"，代码修正（start 排第一、end 排最后，其余按依赖拓扑排序）。

---

## 六、修复 5：LLM 输出数据契约，代码组装 JSON（职责边界落地）

**用户原则：LLM 从需求中梳理——用什么节点 + 怎么连接 + 每个节点的数据契约（变量名/输入结构/输出结构/单批处理）；完整工作流 JSON 由代码组装；保存前先校验。**

### 6.1 plan_workflow 输出契约（workflow-engine/planner.ts + PLAN_PROMPT）

**当前问题**：PLAN_PROMPT 要求 LLM 输出 nodeConfig（llm.model / llm.userPrompt / code.logicDescription / condition.branches / database.connectionId 等）——LLM 自由发挥这些业务细节导致幻觉（周杰伦歌词库、错误模型、错误顺序）。

**改法**：LLM 输出**结构化数据契约**（不是节点 JSON，是节点的"接口定义"）：

```ts
// WorkflowPlan 的 steps：
interface PlanStep {
  order: number;
  description: string;        // 节点职责描述（给代码生成 prompt/逻辑用）
  nodeType: WorkflowNodeType; // 节点类型
  dependencies: number[];     // 连接关系
  /** 数据契约（LLM 确定，代码按此组装节点） */
  contract?: {
    /** 输入变量：该节点接收哪些参数（名称 + 来源说明） */
    inputs?: Array<{ name: string; source: string }>;
    /** 输出变量：该节点输出哪些字段（名称 + 类型） */
    outputs?: Array<{ name: string; type: "string" | "object" | "list" | "integer" | "number" | "boolean" }>;
    /** 单处理还是批处理 */
    batchMode?: "single" | "batch";
  };
}
// ❌ 删除 nodeConfig 里的模型名/prompt 全文/代码/阈值/分支条件等业务细节
```

**PLAN_PROMPT 重写要求**：
- 节点类型序列 + 依赖关系 + 每步简短 description
- **每个节点的数据契约**：输入变量名（如 user_input / audio_url）、输出变量名+类型（如 result: string）、单批处理
- **禁止输出**：模型名、prompt 全文、代码、阈值、分支条件、节点 JSON 结构

### 6.2 代码根据契约 + description 组装节点（generator + 模板）

节点业务内容由代码基于 `contract` + `description` + 平台事实生成：

- **变量名/输出结构**：直接用 contract.inputs / contract.outputs 填充节点的 inputParameters / outputs 声明
- **模型选择**：根据节点 description 判断任务类型——包含"音频/视频/识别/理解"等词 → 从 platform-facts 选 audio_understanding=true 的模型（默认 Doubao-Seed-2.0-Lite）；纯文本 → 默认 Doubao-Seed-2.0-Lite。**代码规则匹配，不靠 LLM 选**
- **prompt 生成**：用模板基于 description 生成（如 `你是一个多模态识别助手。任务：${description}。请输出 JSON 格式结果。`），不靠 LLM 写全文
- **代码节点逻辑**：description 作为 logicDescription 传给 CodeGenerator，**参考数据（歌词库等）由代码从用户上传文件读取后传入**，LLM 生成代码时必须保留参考数据（修复 3 已约束）
- **条件分支**：根据 description 中出现的"如果/否则/判断/分支"语义，用代码生成默认分支结构（如"匹配成功 → true 分支 / 未匹配 → false 分支"），targetNodeId 由代码回填（修复 1.3）
- **批处理**：contract.batchMode === "batch" → 节点标记批处理相关字段；否则单处理

### 6.3 shared 包类型同步（packages/shared/src/types/index.ts）

- `WorkflowPlan` / `PlanStep` 类型更新：移除 nodeConfig，新增 contract（或标记 deprecated）
- 前端/其他引用处同步（若有）

### 6.4 验收

- 给 Agent 需求后，LLM 只输出节点类型 + 连接 + description + 数据契约（无模型名/prompt/代码/阈值）
- 生成的工作流仍包含完整业务逻辑（模型/prompt/代码由代码填充）
- 不再出现"LLM 把歌词库改成周杰伦"这类幻觉

---

## 七、修复 6：保存前校验工作流 JSON（save_to_coze 前置）

**用户要求：保存到 Coze 前，先校验工作流 JSON，校验不过不保存。**

### 文件：apps/api/src/agent/tools/save.tool.ts + workflow-engine/validator 增强

**当前问题**：generate_workflow 已做本地 `validateWorkflow`（结构校验），但 save_to_coze 直接保存，未做**平台兼容性校验**——导致结构对但平台执行失败（如代码节点缺 outputs、条件 targetNodeId 为 TODO、LLM 节点模型不存在）。

**改法**：save_to_coze 保存前增加两层校验，任一不过直接返回错误不调平台 API：

```ts
// save_to_coze 工具内，convertToPlatformSchema 之前：
// 1. 结构校验（现有 validateWorkflow）
const validation = validateWorkflow(cozeWorkflow);
if (!validation.valid) {
  return `保存失败: 工作流结构校验未通过，请先修复:\n${validation.errors.map(e => "- " + e.message).join("\n")}`;
}

// 2. 平台兼容性校验（新增，针对已知平台坑）
const platformIssues = checkPlatformCompatibility(cozeWorkflow);
if (platformIssues.length > 0) {
  return `保存失败: 平台兼容性校验未通过:\n${platformIssues.join("\n")}`;
}
```

**`checkPlatformCompatibility(workflow)` 检查项**（写进新文件 `workflow-engine/platform-validator.ts`）：
1. 所有节点有 outputs 声明（code/llm 节点必须有，否则平台 SetOutputTypesForNodeSchema panic）
2. condition 节点 branches 无 "TODO" targetNodeId（必须指向真实节点）
3. LLM 节点 model 在 platform-facts 模型列表内（防 gpt-4o 等不存在模型）
4. database 节点 connection 非空（为空说明不该有 database 节点）
5. 所有边引用的节点 ID 存在（防悬空引用）
6. start/end 节点存在且唯一

**验收**：
- 给一个结构不完整的工作流调 save_to_coze → 返回校验错误，不调平台 API（日志无 CozeAPI 请求）
- 合法工作流 → 正常保存


---

## 八、验收标准

1. `pnpm typecheck` 全绿；`pnpm build` 全绿
2. **确定性生成实测**：给 Agent 一个"音频识别歌词→匹配歌曲"需求，检查生成的工作流 JSON：
   - 节点顺序正确：start→llm→code→condition→end（LLM 识别在代码比对之前）
   - LLM 节点 inputMapping = `{ user_input: "startId.input" }`
   - 代码节点 inputMapping = `{ input: "llmId.output" }`
   - condition 节点 branches 的 targetNodeId 是真实节点 ID，**没有 "TODO"**
   - 代码节点有 outputs 声明（不再是 panic 错误）
   - 代码节点 code 是真实逻辑（不是占位）
3. **保存后 test_run 不 panic**：保存到平台后试运行，不再报 `interface conversion: interface {} is map[string]interface {}, not []interface {}`
4. **update_workflow 不幻觉**：给"把相似度阈值从0.8调到0.6"指令，只改阈值数字；歌词库数据不被替换
5. 旧功能不回归：简单问答工作流仍正常

---

## 九、红线

- ❌ **LLM 永远不输出节点 JSON 结构**（generate_workflow 工具输入只有 plan 参数，没有 workflow JSON 让 LLM 改）
- ❌ 不整体重写代码节点（除非有 referenceData 且明确要求）
- ❌ 不加新依赖
- ❌ 不改平台 API 调用
- ✅ 结构（顺序/映射/输出声明/分支引用）全部代码确定性生成
- ✅ 业务内容（模型/prompt/逻辑描述/阈值/数据）由 LLM 提供参数
