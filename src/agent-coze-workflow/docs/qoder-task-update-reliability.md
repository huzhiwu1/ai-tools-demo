# Qoder 任务单：局部更新可靠性修复（输出字段指令 + 复用 workflowId + 代码静态校验 + 放宽递归）

> 背景（2026-08-16 实测发现 4 个问题）：
> 1. update_workflow 改不了"结束节点输出字段"（用户要"输出歌名不是歌词"，LLM 归到 other 失败，3 次迭代上限被无效尝试耗光）
> 2. save 超时后 create 实际已成功 → 重试无脑加 `_2` → 平台残留第二个工作流（audio_song_recognition_2）
> 3. 代码节点运行时 EOF（代码自定义了 Args/Output 类 + `Output(...)` 构造，平台期望 dict 赋值 `ret: Output = {...}`）——应在生成时拦截
> 4. recursionLimit 40 太少（内部用户场景，update 失败→重建→save 超时→validate 8 用例→超限）

---

## 一、必读文件

- `apps/api/src/agent/tools/update-workflow.tool.ts`（UpdateInstructionSchema :45-68 / parseInstruction / 迭代计数 :163-170 / 各 type 修改分支）
- `apps/api/src/agent/tools/save.tool.ts`（createWorkflowWithRetry :58-97 / save 主流程）
- `apps/api/src/workflow-engine/code-generator.ts`（generateCode / CodeOutputSchema / buildFallbackCode）
- `apps/api/src/agent/react-agent.service.ts`（recursionLimit :171 附近）
- `apps/api/src/agent/tools/iteration-counter.ts`（迭代计数）
- `apps/api/src/agent/tools/coze-client.ts`（CozeClient 单例，save 用）
- `apps/api/src/coze/coze.client.ts`（createWorkflow / saveWorkflow / listWorkflows）

## 二、任务 1：update_workflow 支持"改输出字段/变量引用"（update-workflow.tool.ts）

### 1.1 UpdateInstructionSchema 加类型

`UpdateInstructionSchema` 的 type enum 加 `"output_field"`：

```ts
type: z.enum([
  "llm_prompt",
  "code_logic",
  "condition",
  "threshold",
  "data",
  "output_field",   // 🆕 改节点输出字段名/结束节点返回变量
  "other",
]).describe(
  "修改类型：llm_prompt=改 LLM 节点提示词 / code_logic=改代码节点逻辑 / " +
  "condition=改条件分支 / threshold=调阈值 / data=更新数据常量 / " +
  "output_field=改节点输出字段名或结束节点返回变量（如把输出从 lyrics 改为 result） / " +
  "other=其他",
);
```

### 1.2 实现 output_field 修改分支

在 switch 里加 case（放在 data 之后）：

```ts
case "output_field": {
  // 目标：改节点 outputs 声明里的字段名，或结束节点 outputVariables 引用
  // content 格式约定：`旧字段名 -> 新字段名`（或 `改为`）
  const match = /([\w.]+)\s*(?:->|→|改为)\s*([\w.]+)/.exec(instruction.content);
  if (!match) {
    return (
      `工作流更新失败: output_field 指令格式应为「旧字段名 -> 新字段名」` +
      `（如 lyrics -> result），收到: ${instruction.content}`
    );
  }
  const [, oldName, newName] = match;

  // 场景 A：改节点 outputs 声明
  const outputs = node.outputs as Array<{ name?: string }> | undefined;
  if (Array.isArray(outputs)) {
    let changed = false;
    for (const o of outputs) {
      if (o.name === oldName) {
        o.name = newName;
        changed = true;
      }
    }
    if (changed) {
      changes.push(`节点 ${targetName} 输出字段 ${oldName} -> ${newName}`);
      break;
    }
  }

  // 场景 B：改代码节点内部返回值（代码里 ret: Output = {旧字段: ...} → 新字段）
  // 仅当节点有 code 字段时做文本替换
  if (typeof node.code === "string" && node.code.includes(oldName)) {
    const oldEscaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    node.code = node.code.replace(new RegExp(oldEscaped, "g"), newName);
    changes.push(`节点 ${targetName} 代码内 ${oldName} 已替换为 ${newName}`);
    break;
  }

  return `工作流更新失败: 节点 ${targetName} 中未找到输出字段 ${oldName}`;
}
```

**注意：**
- 结束节点（type=end）的 outputVariables 也要支持：`node.outputVariables` 是 `[{name, value}]` 数组，同样按 name 匹配替换
- 代码节点场景 B 的文本替换**不能破坏 Python 语法**——只替换标识符（`Output({'lyrics': ...})` → `Output({'result': ...})`），字符串字面量里的歌词内容不能误伤。建议只在 `ret: Output = {...}` / `return {...}` 附近的 key 位置替换，或至少说明这个风险由 LLM content 精确控制

### 1.3 code_logic 放宽关键词

`update-workflow.tool.ts` 的 code_logic 分支里 `isRewriteRequest` 正则（当前要求"重写/改.*逻辑"）放宽——**用户明确要求改代码就执行**，不再强制关键词：

```ts
// 放宽：用户明确指向该代码节点并给出修改内容即执行。
// 原逻辑要求"重写/改逻辑"关键词，实测 LLM 说"把 Output 的 key 改掉"不触发导致失败。
const isRewriteRequest = true;  // 不再强制关键词
```

同时保留 referenceData 非空校验（防幻觉编造数据）——**这个校验不动**。

### 1.4 迭代计数只对成功修改计

现状：`incrementIteration(workflowId)` 在工具函数**开头**（每次调用 +1），无效尝试也消耗上限。

改为：**修改成功后**再计数：

```ts
// 现状（开头）：
const iteration = incrementIteration(workflowId);
if (iteration > MAX_ITERATIONS) return iterationLimitMessage(workflowId);

// 改为：
// - 开头只做检查（不递增）：用 peek 语义，iteration-counter 加一个只读方法或读当前值
// - 每个 case 成功 push changes 后，统一在返回前 incrementIteration
```

实现方案（二选一，倾向 A）：
- **方案 A**：iteration-counter.ts 加 `peekIteration(workflowId): number`（只读当前值），update-workflow 开头用 peek 检查上限；所有修改成功（changes.length > 0）且即将返回时调用一次 `incrementIteration`
- **方案 B**：保持开头 increment，但失败分支（return 错误字符串）前调 `decrementIteration`（回滚）——不推荐，容易漏

**采用方案 A**。注意 iteration-counter.ts 的现有接口（incrementIteration/resetIteration/iterationLimitMessage）不动，只加 peek。

## 三、任务 2：save 超时/重名时复用同名 workflowId（save.tool.ts）

### 2.1 createWorkflowWithRetry 改造

现状：重名自动加 `_2/_3/_4` 后缀新建。
改为：**重名或超时 → 先查同名工作流，存在则复用其 workflowId（走更新路径）**：

```ts
import { cozeClient } from "./coze-client"; // 已有

/** 按名称搜索平台工作流，返回第一个同名的工作流 */
async function findWorkflowByName(
  name: string,
): Promise<{ workflowId: string } | null> {
  try {
    const { workflows } = await cozeClient.listWorkflows(50);
    const hit = workflows.find(
      (w) => w.name.toLowerCase() === name.toLowerCase(),
    );
    return hit ? { workflowId: hit.workflowId } : null;
  } catch {
    return null; // 查询失败不阻塞，走原逻辑
  }
}

async function createWorkflowWithRetry(name, desc) {
  try {
    const workflowId = await cozeClient.createWorkflow(name, desc);
    return { workflowId, usedName: name };
  } catch (e) {
    const msg = (e as Error).message;

    // 🆕 超时错误：create 可能已成功 → 查同名复用（避免残留空壳 + 第二个工作流）
    if (/超时|timeout/i.test(msg)) {
      const existing = await findWorkflowByName(name);
      if (existing) {
        console.warn(`[save_to_coze] create 超时但同名工作流已存在，复用 ${existing.workflowId} 更新`);
        return { workflowId: existing.workflowId, usedName: name };
      }
    }

    // 🆕 重名错误：先查同名，存在则复用（不再无脑 _2）
    if (/已存在|exist|duplicate/i.test(msg)) {
      const existing = await findWorkflowByName(name);
      if (existing) {
        console.warn(`[save_to_coze] 名称冲突，复用同名工作流 ${existing.workflowId} 更新（不新建）`);
        return { workflowId: existing.workflowId, usedName: name };
      }
      // 查不到同名（罕见：可能是大小写/截断差异）→ 保留原 _2 后缀兜底
      for (let i = 2; i <= 4; i++) { /* 原逻辑保留 */ }
    }

    throw e;
  }
}
```

### 2.2 save 主流程配合

- `createWorkflowWithRetry` 返回的 workflowId 可能来自"复用"（已存在的工作流）——此时 `isUpdate` 判断（:149 `typeof workflowId === "string" && workflowId.length > 0`）是看**入参** workflowId，不受影响；但复用场景返回的 `usedName` 用原名即可
- **注意**：复用同名工作流后，save 走 `saveWorkflow(workflowId, schemaJson)` 全量更新——这符合"平台只有全量更新"的约束

## 四、任务 3：代码生成静态校验（code-generator.ts）

### 3.1 generateCode 生成后校验

`CodeGenerator.generateCode()` 在 `chatStructured` 返回 `result.code` 后、return 前加静态校验：

```ts
/** 平台代码节点规范违规检测（生成时拦截，避免运行时 EOF） */
const CODE_VIOLATIONS: Array<{ pattern: RegExp; msg: string }> = [
  {
    pattern: /^class\s+Args\b/m,
    msg: "禁止自定义 Args 类（平台已内置 Args）",
  },
  {
    pattern: /^class\s+Output\b/m,
    msg: "禁止自定义 Output 类（平台已内置 Output，返回值应为 dict 赋值 ret: Output = {...}）",
  },
  {
    pattern: /ret\s*=\s*Output\s*\(/,
    msg: "返回值必须是 dict 赋值（ret: Output = {...}），不能 Output(...) 构造",
  },
  {
    pattern: /```/,
    msg: "代码不能包含 Markdown 代码块围栏",
  },
];

function findCodeViolations(code: string): string[] {
  return CODE_VIOLATIONS.filter((v) => v.pattern.test(code)).map((v) => v.msg);
}
```

`generateCode` 流程改为：

```ts
// 第 1 次生成
let result = await this.client.chatStructured(CodeOutputSchema, CODE_SPEC_PROMPT, prompt);
let code = result.code?.trim() ?? "";

// 静态校验：违规 → 追加违规说明到 prompt 重试一次
const violations = findCodeViolations(code);
if (violations.length > 0) {
  this.logger.warn(`[CodeGenerator] 生成代码违规，重试: ${violations.join("; ")}`);
  const retryPrompt = `${prompt}\n\n【上轮生成被拒绝】违规项：${violations.join("；")}\n请修正后重新生成，严格遵守平台代码节点规范（Args/Output 为平台内置类型，禁止自定义；返回值用 ret: Output = {...} dict 赋值）。`;
  const retry = await this.client.chatStructured(CodeOutputSchema, CODE_SPEC_PROMPT, retryPrompt);
  const retryCode = retry.code?.trim() ?? "";
  const retryViolations = findCodeViolations(retryCode);
  if (retryViolations.length === 0) {
    code = retryCode;
  } else {
    this.logger.warn(`[CodeGenerator] 重试仍违规，使用兜底模板: ${retryViolations.join("; ")}`);
    return CodeGenerator.buildFallbackCode(inputs);
  }
}
```

**注意**：
- 原 try/catch 兜底保留（chatStructured 抛异常仍走 buildFallbackCode）
- 重试时 `maxRetries` 用 1（chatStructured 默认参数即可），避免过多重试
- CODE_SPEC_PROMPT 里补一句更明确的规范说明（防止 LLM 再犯）：
  ```
  8. Args 和 Output 是平台内置类型，禁止自定义同名类；返回值必须用 ret: Output = {...} dict 赋值，禁止 Output(...) 构造
  ```

## 五、任务 4：recursionLimit 放宽（react-agent.service.ts）

- `createGraph()` 里 `recursionLimit: 40`（:171 附近）→ **100**
- `handleChat` 的 config `recursionLimit: 40`（:241 附近）→ **100**
- 注释说明：内部用户场景，update 失败→重建→save 超时重试→validate 多用例会叠加步数，40 太紧

## 六、验收标准

1. `npm run build`（apps/api）通过。
2. 单元手测：
   - update_workflow 的 output_field：对 code 节点执行 `{"type":"output_field","target":"代码处理","content":"lyrics -> result"}` → outputs 和代码内 key 都被替换
   - 迭代计数：先发一条失败指令（如 type=other）→ 再发一条成功指令 → peek 值只 +1（失败不消耗）
3. 端到端手测（关键）：
   - 场景 A：save 首次创建超时 → 重试 save（同 workflow）→ 日志显示"复用同名工作流"，**平台不产生 _2**
   - 场景 B：代码生成含 `class Output` → 日志显示"生成代码违规，重试"→ 重试成功或兜底，**保存后平台工作流代码无 class Output**
   - 场景 C：整链路（plan→generate→save→validate→update(output_field)→save）跑通，update 后 save 复用原 workflowId，不新建

## 七、提交要求（直接在 main 上改）

1. 当前分支就是 main，**不要切分支**
2. 完成改动后直接提交：`fix(agent-coze-workflow): 局部更新可靠性——output_field 指令 + 复用同名 workflowId + 代码静态校验 + 放宽递归`
3. push 到 origin main

## 八、约束与不做

- **不改**：coze.client.ts 核心方法、generator.ts、schema-converter.ts、workflow-cache.ts
- iteration-counter.ts 只加 peekIteration，不动现有方法语义
- 保持项目风格：中文注释、错误字符串返回、工具 withToolLog 注册
- 不引入 DSL、不改前端
