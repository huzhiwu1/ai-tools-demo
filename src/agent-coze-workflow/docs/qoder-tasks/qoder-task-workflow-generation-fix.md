# Qoder 任务：工作流生成修复（命名规则 + 业务逻辑增强 + update_workflow 结构化）

> 项目：`/Users/huzhiwu/workspace/ai-tools-demo/src/agent-coze-workflow`
> 技术栈：NestJS 11 + LangGraph createReactAgent + pnpm workspace
> **背景：Sprint B 全链路实测发现三个问题——① 工作流名称违反平台命名规则（中文名）；② 生成的节点全是模板占位（gpt-4o/TODO代码/default连接），平台 test_run 报 720701013 invalid syntax；③ update_workflow 关键词匹配失败，LLM 的自然语言修改指令经常落空。本任务一次性修复这三个问题。**

---

## 一、问题详情（已实测确认）

### 问题 1：工作流命名违反平台规则

**平台硬性约束**（update_meta 接口实测）：工作流名称**只允许字母、数字、下划线，且必须以字母开头**。

当前问题：`WorkflowPlanner` 生成的 `plan.name` 是中文（如"识别音频链接中的歌曲歌词，判断是否属于8首训练营练习歌曲集合"），`save_to_coze` 直接用它调 `createWorkflow`，平台无法正确处理。

### 问题 2：生成节点全是模板占位（720701013 根因）

保存成功但平台执行报 `Workflow execution failure: invalid syntax`。拉取保存的 schema 确认：

```
❌ LLM 节点: modleName="gpt-4o"            ← 平台私有部署没有 gpt-4o
❌ 代码节点: code="// TODO: 填充代码逻辑"     ← 纯注释无逻辑
❌ 数据库节点: databaseInfoID="default"      ← 无效连接
❌ 条件节点: 引用 blockID="100001" 占位      ← 逻辑错误
```

**根因**：`workflow-engine/generator.ts` 的 `createNodeForStep` 是纯模板映射，节点业务内容全部是默认占位。Agent 生成的工作流"结构正确、逻辑空白"，平台一执行就挂。

### 问题 3：update_workflow 关键词匹配失败

日志连续 5 次：`工作流更新失败: 无法识别修改类型`。`update_workflow` 用关键词匹配（阈值/代码/prompt…）解析 LLM 的自然语言 `fixInstruction`，经常落空。

---

## 二、修复 1：工作流命名规则

### 目标

所有创建/保存到 Coze 的工作流名称必须满足：**字母开头 + 字母/数字/下划线**。

### 改法

**planner 生成合法英文名（LLM 负责语义，代码兜底）：**

1. `apps/api/src/prompts/plan-prompt.ts` 的 PLAN_PROMPT 增加输出要求：
   ```
   name 必须是英文：只允许字母、数字、下划线，以字母开头，长度 ≤ 50。
   根据需求语义生成简洁的英文名（如识别歌曲 → song_recognition）。
   ```

2. `workflow-engine/planner.ts` 的 zod schema 输出后，代码侧兜底 sanitize：

```ts
/** 生成合法工作流名：字母开头 + 字母/数字/下划线，超长截断 */
function sanitizeWorkflowName(name: string): string {
  // 只保留字母数字下划线
  let clean = name.replace(/[^a-zA-Z0-9_]/g, "_");
  // 去重下划线
  clean = clean.replace(/_+/g, "_");
  // 必须以字母开头
  clean = clean.replace(/^[^a-zA-Z]+/, "");
  // 截断 50
  clean = clean.slice(0, 50);
  // 空兜底
  if (!clean) clean = "workflow";
  return clean;
}
```

3. `plan_workflow` 工具 / `WorkflowPlanner.plan()` 返回前调用 sanitize，确保 `plan.name` 永远合法。

**注意**：`save_to_coze` 里 `workflow.meta.name` 也走同一保证（因为 workflow 由 plan 生成）；前端展示可用 `description`（中文），`name` 只用于平台。

---

## 三、修复 2：生成器业务逻辑增强（核心，720701013 的根治）

### 目标

Agent 生成的工作流节点**必须带真实可执行的业务逻辑**，而不是模板占位。这需要让 LLM 参与节点业务内容的生成。

### 设计：plan 阶段输出节点详细配置（nodeConfig）

**扩展 WorkflowPlan 的 PlanStep**（`packages/shared/src/types/index.ts`）：

```ts
export interface PlanStep {
  order: number;
  description: string;
  nodeType: WorkflowNodeType;
  dependencies: number[];
  /** 节点业务配置（LLM 生成，generator 按此组装真实节点） */
  nodeConfig?: {
    /** LLM 节点：模型名（平台可用模型）+ 提示词 */
    llm?: { model: string; userPrompt: string; systemPrompt?: string };
    /** 代码节点：业务逻辑描述（LLM 生成真实 Python 代码用） */
    code?: { logicDescription: string; inputs?: string[] };
    /** 条件节点：分支条件描述 */
    condition?: { branches: Array<{ label: string; condition: string }> };
    /** 数据库节点：连接标识 + 查询描述（无真实连接时不要生成该节点） */
    database?: { connectionId: string; queryDescription: string };
    /** HTTP 节点：方法/URL/描述 */
    http?: { method: string; url: string; description: string };
  };
}
```

**PLAN_PROMPT 更新**（`apps/api/src/prompts/plan-prompt.ts`）：要求 LLM 对每个 step 输出 `nodeConfig`，内容具体：
- llm.model：**只能从平台真实模型列表中选择**（见 `docs/coze-platform/platform-facts.md`），禁止 gpt-4o 等平台不存在的模型；**需要识别音频/视频的任务必须选 `audio_understanding: true` 的模型**（Doubao-Seed-2.0-Lite / Doubao-Seed-2.0-mini / Doubao-Seed-1.6 / gemini-3.1-pro-preview / Qwen3.5-Omni-Plus）；纯文本任务默认 Doubao-Seed-2.0-Lite
- llm.userPrompt：完整的业务提示词（如"读取音频链接识别歌词，输出 JSON"）
- code.logicDescription：代码节点要实现的业务逻辑描述（如"计算识别歌词与8首歌参考歌词的相似度，取最高分"）
- condition.branches：真实的分支条件（如"similarity >= 0.6 → 匹配成功"）
- database：**只有当用户明确提供数据库信息、且该数据源存在于 `docs/coze-platform/platform-facts.md` 的数据库列表时才生成 database 节点**（databaseInfoID 必须用真实 res_id）；否则该 step 的 nodeType 应为 code 或 llm

**generator 增强**（`workflow-engine/generator.ts`）：

`createNodeForStep` 不再纯模板，改为按 nodeConfig 组装：

```ts
case "llm": {
  const cfg = step.nodeConfig?.llm;
  return createLLMNode({
    title,
    desc: step.description,
    userPrompt: cfg?.userPrompt ?? "{{input}}",
    systemPrompt: cfg?.systemPrompt,
    config: {
      model: cfg?.model ?? "Doubao-Seed-2.0-Lite",  // 平台默认模型
      temperature: 0.2,
      maxTokens: 4096,
    },
  });
}
```

**代码节点生成真实 Python 代码**（新增 `generateCode` 逻辑）：

代码节点不能直接写死——由 LLM 根据 `code.logicDescription` 生成真实 Python 代码。实现方式：

1. `workflow-engine/generator.ts` 或新增 `workflow-engine/code-generator.ts`：
   - 调 DeepSeekClient.chatStructured 或普通 chat，输入 `logicDescription` + 输入输出约束，输出完整 Python 代码
   - zod schema 约束：`{ code: string }`
   - **降级**：LLM 生成失败时用模板兜底（`async def main(args: Args) -> Output: ...`），但模板必须能跑（不是 TODO 注释）
2. **代码必须符合平台代码节点规范**（参考 `docs/coze-platform/coze-node-fields-guide.md`）：
   - 入口函数 `async def main(args: Args) -> Output:`
   - `params = args.params` 取输入
   - `ret: Output = {...}` 返回，与 outputs 声明一致
   - 输入兼容：`if isinstance(x, str): json.loads(x)`
3. 生成的代码里，**用户上传的参考数据（如歌词库）写入代码常量**：generator 组装时把用户文件内容（LLM 已读取）嵌入代码字符串（如 `SONG_LYRICS = {...}`）

**converter 侧配套**（`apps/api/src/coze/schema-converter.ts`）：
- LLM 节点 modleName 默认改 `Doubao-Seed-2.0-Lite`（modelType=201，见 platform-facts.md）——generator 传了错误模型会覆盖，修复 generator 后自然正确；同时把 converter 的默认值统一为 Doubao-Seed-2.0-Lite
- 数据库节点：`databaseInfoID` 若为空字符串，**该节点不应存在**（LLM 规划时已避免生成，代码再兜底：database 节点 connection 为空时跳过该节点并 warn）
- **新增能力（可选，强烈建议）**：`coze.client.ts` 加 `listDatabases()` 方法（调 `POST /api/plugin_api/library_resource_list`，res_type_filter=[7]，返回真实数据库列表），供 LLM 规划时查询可用数据源——接口契约见 `docs/coze-platform/platform-facts.md` 第三节

---

## 四、修复 3：update_workflow 改为 LLM 结构化输出

### 目标

`update_workflow` 不再用关键词猜 fixInstruction，而是让 LLM 输出结构化修改指令。

### 改法（apps/api/src/agent/tools/update-workflow.tool.ts）

工具内部：
1. 调 LLM（DeepSeekClient）解析 `fixInstruction` + 当前 workflow，用 zod 结构化输出：

```ts
const UpdateInstructionSchema = z.object({
  type: z.enum(["llm_prompt", "code_logic", "condition", "threshold", "data", "other"])
    .describe("修改类型：llm_prompt=改 LLM 节点提示词 / code_logic=改代码节点逻辑 / condition=改条件分支 / threshold=调阈值 / data=更新数据常量 / other=其他"),
  target: z.string().describe("目标节点标识（title 或 id，尽量用 title 中文名）"),
  content: z.string().describe("具体修改内容：新提示词 / 新代码 / 新条件 / 新阈值 / 新数据"),
});
```

2. 按结构化结果执行修改：
   - `llm_prompt` → 找对应 LLM 节点，更新 `userPrompt` / `systemPrompt`
   - `code_logic` → 调 LLM 生成新代码（复用修复 2 的 code-generator），替换节点 code
   - `condition` → 更新 branches
   - `threshold` → 在代码节点/条件里找阈值常量替换
   - `data` → 更新代码节点里的数据常量
   - 找不到 target 节点 → 返回明确错误（"未找到节点: xxx"）
3. 修改完返回 `{ workflow, changes: ["..."] }`

### 注意

- LLM 解析失败（JSON 格式错误）→ 降级返回错误字符串让 Agent 重新组织语言
- 工具描述更新：告诉 LLM 可以传"当前 workflow JSON + 归因分析 + 想要的修改"，工具会自己理解并结构化执行

---

## 五、验收标准

1. `pnpm typecheck` 全绿；`pnpm build` 全绿
2. **命名规则**：跑一次完整流程，平台上的工作流名称是英文（字母开头 + 字母数字下划线），不再是中文
3. **schema 业务逻辑**：拉取保存的 schema 检查——
   - LLM 节点 modleName 是 `Doubao-Seed-2.0-Lite`（不是 gpt-4o）
   - 代码节点 code 是真实 Python 逻辑（不是 `// TODO`）
   - 没有无效 databaseInfoID（无连接时不生成数据库节点）
   - 条件节点 branches 有真实条件描述
4. **test_run 能跑**：保存后 test_run 不再报 720701013 invalid syntax（业务错误除外，如"识别失败"是正常业务分支）
5. **update_workflow**：给一个自然语言修改指令（如"把相似度阈值从0.8调到0.6"），能正确识别类型并修改节点，返回 changes
6. 旧功能不回归：简单问答工作流（start→llm→end）仍能生成保存

---

## 六、红线

- ❌ 不改平台 API 调用方式（coze.client.ts 的 create/save/test_run 不动）
- ❌ 不引入外部模型名（gpt-4o/claude 等一律不用，平台模型只有 Doubao-Seed-2.0-Lite）
- ❌ 不删旧链路（legacy/）
- ❌ 不把凭证写进代码
- ✅ 新逻辑全部 try/catch 降级（LLM 失败时用可运行的兜底模板，不是空注释）
- ✅ 代码节点生成的代码必须符合平台规范（async def main / args.params / ret）
