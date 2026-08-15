# Qoder 任务单：Agent 卡住修复 —— 上下文瘦身 + generate 句柄化 + 防重复规划

> 依据：2026-08-16 日志分析（plan_workflow 两次成功 → done，无 generate_workflow）。主 LLM 已修复关思考（见 react-agent.service.ts maxTokens 16384 + thinking disabled），但运行中仍卡在第二次 plan 之后。
> 根因：① `get_platform_facts` 输出 63301 字符模型列表（全量塞给 LLM）；② `generate_workflow` 仍需 LLM 背诵完整 plan JSON（未句柄化）；③ 主 LLM 重复调用 plan_workflow 放大上下文。

---

## 一、任务目标

1. **get_platform_facts 输出瘦身**：模型列表从全量（63KB）改为摘要（~2KB），大幅降低上下文压力。
2. **generate_workflow 句柄化**：plan 输出写入服务端缓存，generate 只传 planId，不传完整 JSON（与 update/save 对齐）。
3. **防重复规划**：plan_workflow 输出增加"可接受标记"或提示词约束，避免主 LLM 反复重新规划。

## 二、必读文件

- `apps/api/src/agent/tools/platform-facts.tool.ts`（get_platform_facts：全量模型列表输出处）
- `apps/api/src/agent/tools/generate.tool.ts`（generate_workflow：plan 参数背诵模式）
- `apps/api/src/agent/tools/plan.tool.ts`（plan_workflow 工具入口）
- `apps/api/src/agent/workflow-cache.ts`（已有缓存：TTL/LRU/dirty/commitId，复用）
- `apps/api/src/agent/react-agent.service.ts`（SYSTEM_PROMPT 工具说明）
- `apps/api/src/agent/tools/index.ts`（工具注册）

## 三、任务 1：get_platform_facts 输出瘦身

`apps/api/src/agent/tools/platform-facts.tool.ts` 当前 `result.models = models.value`（listModels 返回的完整对象，含 model_quota/model_params/model_desc，25 模型 × 2.5KB ≈ 63KB）。

**改为只输出摘要字段**：

```ts
if (models.status === "fulfilled") {
  // 瘦身：只保留 LLM 选模型需要的字段（name/modelType/audio/image/video），
  // 砍掉 model_quota/model_params/model_desc 等大字段（63KB → ~2KB）
  result.models = models.value.map((m) => ({
    name: m.name,
    modelType: m.modelType,
    audio: m.audio,
    image: m.image,
    video: m.video,
  }));
}
```

要求：
- `coze.client.ts` 的 `listModels()` **不动**（它返回全量，供 save 时 modelType 映射用，那是内部使用不经过 LLM）
- 只改 `platform-facts.tool.ts` 的工具输出组装
- 验证：工具返回 JSON 里 models 数组每个元素只有 5 个字段

## 四、任务 2：generate_workflow 句柄化

### 背景

现状：`generate.tool.ts` schema 是 `{ plan: z.record(...)（完整 WorkflowPlan）, referenceData? }`。主 LLM 在 plan_workflow 返回后，必须**重新背诵整个 plan JSON** 作为 generate_workflow 参数——大 JSON + 长上下文时输出质量崩，导致静默 done。

### 4.1 plan.tool.ts：plan 成功后写缓存

`plan.tool.ts` 工具函数内，plan_workflow 成功返回 WorkflowPlan 后：

```ts
import { workflowCache } from "../workflow-cache";
import { randomUUID } from "crypto";

// plan 成功后写缓存（句柄化：generate 只传 planId，不传完整 plan）
const planId = randomUUID();
workflowCache.set(planId, plan as unknown as Record<string, unknown>);
```

返回结果改为：

```ts
return JSON.stringify({
  planId,                       // 🆕 句柄，generate_workflow 用它取 plan
  plan,                         // 保留完整 plan（前端草图画板渲染用，不能删）
  // 其余字段保持现状
}, null, 2);
```

注意：
- **plan 完整输出必须保留**（前端 plan 面板/草图区渲染依赖它），只是**额外**加一个 planId
- 缓存 key 用 planId（不是 workflowId），因为 plan 阶段还没有平台 workflowId
- 复用现有 workflowCache（TTL 30 分钟足够覆盖 plan→generate 间隔）

### 4.2 generate.tool.ts：支持 planId

schema 改为 `planId` 可选：

```ts
schema: z.object({
  planId: z.string().optional()
    .describe("plan_workflow 返回的 planId 句柄（推荐）。不传时从服务端缓存按 planId 获取 plan"),
  plan: z.record(z.string(), z.any()).optional()
    .describe("可选。完整 WorkflowPlan JSON。推荐用 planId 句柄化，避免背诵大 JSON"),
  referenceData: z.record(z.string(), z.any()).optional()
    .describe("参考数据（如歌词库 {歌名: 歌词}），必须来自 read_file 读取的文件内容，禁止凭空编造"),
})
```

工具函数内：

```ts
// 解析 plan 来源：参数 plan ?? 缓存按 planId 取
const planSource = plan ?? (planId ? workflowCache.get(planId)?.workflow : undefined);
if (!planSource) {
  return "生成失败: 未提供 plan 且缓存中无此规划（planId=...）。请先调用 plan_workflow 后再生成";
}
const workflowPlan = planSource as unknown as WorkflowPlan;
```

其余逻辑不变（generator.generateWorkflow 消费 workflowPlan）。

### 4.3 react-agent.service.ts SYSTEM_PROMPT 更新

工具说明第 4 条 generate_workflow 补充：

```
4. generate_workflow: 将规划结果映射为 Coze 平台可部署的工作流 JSON（plan 参数可选，优先用 planId 句柄，不传完整 plan）
```

使用规则里加：

```
- **句柄化**：plan_workflow 返回 planId 后，generate_workflow 传 planId 即可（不传完整 plan JSON）
```

## 五、任务 3：防重复规划

### 5.1 plan.tool.ts 返回增加规划质量标记

plan_workflow 返回 JSON 里增加：

```ts
{
  planId,
  plan,
  _meta: {
    planningComplete: true,   // 标记：本次规划已完成，可直接进入 generate，无需重复规划
  }
}
```

### 5.2 react-agent.service.ts SYSTEM_PROMPT 约束

「## 使用规则」加一条：

```
- **不要重复规划**：plan_workflow 返回 planningComplete=true 后，直接进入 generate_workflow（传 planId）。
  除非规划结果与用户需求明显不符（如漏了关键步骤/选错模型），否则不要再次调用 plan_workflow
```

## 六、验收标准

1. `npm run build`（apps/api）通过。
2. get_platform_facts 输出 models 数组每个元素只有 5 个字段（name/modelType/audio/image/video），总输出 < 5KB。
3. 端到端手测（关键）：
   - 复现原场景（上传 xlsx + md → 识别音频 → 匹配歌曲）
   - 观察日志：`tool_start plan_workflow` 只出现 **1 次**（不再重复规划）
   - `tool_start generate_workflow` 入参里 plan 参数为空/省略，只有 planId（日志入参 ≤ 200 字节）
   - Agent 全链路走通：plan → generate → save → validate，不再静默 done
4. 回归：原有功能不破坏（plan 输出仍含完整 plan 供前端渲染；save/update 句柄化不受影响）

## 七、约束与不做

- **不改**：coze.client.ts 的 listModels()、generator.ts、schema-converter.ts、workflow-cache.ts（复用）
- 保持项目风格：文件头注释、zod 字段 describe、错误以字符串返回、工具用 withToolLog 注册
- 中文注释、中文错误提示
- 不引入 DSL、不改前端

## 八、实施顺序

任务 1（瘦身，最小改动）→ 任务 2（generate 句柄化）→ 任务 3（防重复规划）→ 验收手测

> 提交说明：修复 Agent 静默 done——上下文瘦身 + generate 句柄化 + 防重复规划（2026-08-16）
