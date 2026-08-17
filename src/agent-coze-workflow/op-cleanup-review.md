# Agent Coze Workflow OP 化后清理 & 主循环重构

## ⚠️ 铁律：先删后建，不在屎山上堆代码

本 prompt 包含大量**删除操作**和**替换操作**。具体规则：

1. **删除操作**：AB 测试脚本、legacy 目录、test-plan.ts → 直接 `rm`，不要注释掉、不要移到 `deprecated/`
2. **替换操作**：死循环检测、批量测试截断 → 旧逻辑直接替换，不要新旧并存
3. **不要保留注释掉的旧代码**：删干净，git 历史里有旧版本可以回看
4. **删除 legacy 时**：删除目录后必须同步修改 `app.module.ts` 的 import 和 imports 数组，否则编译不通过

---

## 项目背景

这是一个 Coze 工作流自动生成 Agent（NestJS + LangGraph createReactAgent + Vercel AI SDK），核心流程：用户需求 → ReAct Agent → 规划工作流 → 生成 JSON → 保存到 Coze 平台 → 批量试运行验证 → 归因迭代。

**当前状态**：OP 化（update_workflow 从 `{type, target, content}` 改为 operations 数组）已成功落地。现在需要做 5 件事：清理 AB 测试/无关代码 + 修复 React loop 死循环 + 批量测试截断 + 借鉴 DeepSeek Harness 主循环设计。

---

## 需求 1：删除 AB 测试

### 背景
OP 化前做了 `{type, target, content}` vs `operations[]` 的 A/B 对比测试，已验证新 schema 解析成功率达标。现在 OP 化已稳定，AB 测试脚本不再需要。

### 改动
- **删除文件**：`apps/api/scripts/ab-test-update-schema.ts`
- 检查是否有其他文件引用该脚本（目前没有 import 引用，只有直接 `tsx` 运行）

---

## 需求 2：删除无关代码

### 2.1 Legacy 模块（旧工作流链路）

**文件列表**：
```
apps/api/src/legacy/graph.ts              # 旧 LangGraph 状态图（已废弃）
apps/api/src/legacy/workflow-repairer.ts  # 旧修复器（已被 update_workflow 替代）
apps/api/src/legacy/workflow.controller.ts # 旧 HTTP 控制器
apps/api/src/legacy/workflow.module.ts     # 旧 NestJS 模块
apps/api/src/legacy/workflow.service.ts    # 旧服务
```

**改动**：
1. 删除整个 `apps/api/src/legacy/` 目录
2. 修改 `apps/api/src/app.module.ts`：
   - 删除 `import { LegacyModule } from "./legacy/workflow.module";`
   - 删除 `imports` 数组中的 `LegacyModule`

### 2.2 测试脚本

**文件**：`apps/api/test-plan.ts`（端到端 planner 验收脚本，手动跑的一次性脚本）

**改动**：删除 `apps/api/test-plan.ts`

### 2.3 保留的文件（不要删）

以下文件虽然看起来像"无关代码"，但实际有用：
- `apps/api/src/app.controller.ts` + `app.service.ts`：健康检查 `/health` 端点，有用
- `apps/api/src/agent/operations/apply-operation.spec.ts`：applyOperations 的 vitest 单元测试，有用
- `scripts/diagnose-coze-auth.ts`：Coze 认证诊断脚本，排查问题时有用

---

## 需求 3：React Loop 死循环修复

### 当前问题

`react-agent.service.ts` 使用 LangGraph `createReactAgent` 作为黑盒主循环，存在以下问题：

1. **无死循环检测**：Agent 会反复调用同一工具（如同一 workflowId 的 batch_validate → update_workflow → save_to_coze → batch_validate 循环），`recursionLimit: 100` 只防总步数超限，不防语义死循环。iteration-counter 只限制了 batch_validate/update_workflow 各 3 次，但 LLM 可以用其他工具组合绕过。

2. **maxTokens 偷预算导致静默停止**：`maxTokens: 16384`，但 DeepSeek 的 reasoning token 与正文共享 budget。当 plan_workflow 输出大 JSON 后，下一步 LLM 的 reasoning 吃掉大半预算，正文截断 → tool_calls 解析失败 → Agent 静默 done（不报错、不通知用户）。虽然已设 `thinking: { type: "disabled" }`，但这是治标。

3. **graphDirty 机制是 hack**：客户端断开时标记 `graphDirty`，下次重建 graph。但如果你在 Agent 执行中点了「打断并发送」，graph 重建 + checkpoint 丢失 → 打断前的工具结果（read_file 的文件内容、save 的 workflowId）全丢，靠 `summarizeToolResult` 写到 session.messages 的 tool 摘要勉强恢复，不可靠。

4. **无工具调用超时控制**：单个工具调用（如 batch_validate 串行执行 N 个用例）可能耗时 5+ 分钟，期间没有超时中断，前端一直转圈。

### 改进方案

在 `react-agent.service.ts` 中增加以下防护：

#### 3.1 工具调用重复检测（防死循环）

```typescript
// 在 streamAgentEvents 中维护最近 N 次工具调用记录
interface RecentToolCall {
  name: string;
  argsHash: string;  // JSON.stringify(args) 的 hash
  timestamp: number;
}

const recentToolCalls: RecentToolCall[] = [];
const MAX_RECENT = 10;
const REPEAT_THRESHOLD = 3;  // 同一工具+同一参数连续 3 次视为死循环

// 在 on_tool_start 时：
// 1. 计算 argsHash
// 2. 检查最近 REPEAT_THRESHOLD 次是否都是同一 (name, argsHash)
// 3. 如果是 → 注入 stop 消息给 LLM："检测到重复工具调用，请改变策略或向用户汇报"
// 4. 如果 LLM 继续调用 → 第 4 次直接 force stop，返回错误给前端
```

#### 3.2 显式最大步数限制

```typescript
const MAX_STEPS_PER_TURN = 25;  // 单轮对话最多 25 步（每步 = 一次 LLM 调用 + 工具执行）

// 在 streamAgentEvents 中维护 stepCount
// 达到上限时：不抛异常（会丢上下文），而是注入 stop 消息
```

#### 3.3 工具调用超时控制

```typescript
// 为每个工具调用包裹 AbortSignal + timeout
// 默认 120 秒超时（batch_validate 可单独设 300 秒）
// 超时后：取消工具执行，返回 "工具调用超时" 给 LLM，不中断整个流
```

#### 3.4 改进 graphDirty 机制

参考 Harness 的 session log 设计（见需求 5），不依赖 checkpoint 恢复，而是：
- 每次工具调用完成后，将结果写入 session.messages（已有 summarizeToolResult，但当前只覆盖 10 种工具）
- 打断恢复时，从 session.messages 重建完整上下文，完全不需要 checkpoint

---

## 需求 4：批量测试截断修复

### 当前问题

`batch-validate.tool.ts` 存在以下问题：

1. **串行 + 5 分钟/用例 = 用户等到天荒地老**：`POLL_TIMEOUT_MS = 300_000`，20 个用例串行最坏 100 分钟。LLM 经常构造 10+ 个用例，5 分钟过去什么都没返回。

2. **返回 JSON 巨大**：`details` 数组包含每个用例的 `input`/`expected`/`actual`/`error`，10 个用例就接近 8000 token，可能超出 LLM 上下文窗口，导致后续步骤出错。

3. **无进度反馈**：LLM 调用 batch_validate 后，工具内部串行执行，期间没有任何输出，LLM 干等 5+ 分钟。前端也看不到进度。

4. **超时处理不优雅**：`POLL_TIMEOUT_MS` 写死 300 秒，但注释说"90 秒"，不一致。超时后标记 `executionError` 继续下一个，但 20 个用例全超时就是 20 个 error，LLM 无法有效归因。

### 改进方案

#### 4.1 并发执行 + 限流

```typescript
// 改为并发执行，用 p-limit 控制并发数（默认 3）
// 单个用例轮询超时降到 120 秒（工作流含 LLM 节点可能慢，但 2 分钟够用）
const CONCURRENCY = 3;
const POLL_TIMEOUT_MS = 120_000;
```

#### 4.2 结果截断

```typescript
// details 数组只保留失败用例（passed 的只计数）
// 失败用例超过 10 个时，只保留前 10 个 + 汇总
// 每个用例的 actual 截断到 200 字符
// input 截断：只保留关键字段（非空值），最多 3 个 key
```

#### 4.3 进度回调（可选，复杂度高）

如果 LangGraph tool 支持流式输出，可以在批量执行时实时推送进度。但当前 LangGraph tool 是同步返回的，需要改为 generator 或使用 callback。一期可以先不做，只做 4.1 + 4.2。

#### 4.4 早期终止

```typescript
// 前 5 个用例全部失败（accuracy=0%）→ 直接终止，不等剩余用例
// 返回：已终止 + 已完成用例的明细
```

---

## 需求 5：借鉴 DeepSeek Harness 主循环

### Harness 关键设计

源码位置：`~/workspace/deepseek-harness-study/source/packages/core/agent-loop/src/agent.ts`（496 行）

**核心架构**：

```
┌─────────────────────────────────────────────────────┐
│                  ReactLoopAgent                      │
│                                                      │
│  Phase 状态机:  idle ←→ running ←→ maintenance       │
│                                                      │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐        │
│  │  turn 1  │   │  turn 2  │   │  turn 3  │  ...   │
│  │ step1    │   │ step1    │   │ step1    │        │
│  │ step2    │   │ step2    │   │          │        │
│  │ step3    │   │          │   │          │        │
│  └──────────┘   └──────────┘   └──────────┘        │
│                                                      │
│  Inbox: followup(下一轮) / steer(打断当前步)          │
│         / inject(不唤醒)                              │
│                                                      │
│  Session: append-only Event Log (不可变)              │
└─────────────────────────────────────────────────────┘
```

**5 个可借鉴的核心模式**：

#### 5.1 Turn/Step 双层循环

当前项目：只有 `sessionId` + `messages[]`，没有 turn/step 边界。

改进方案：
```typescript
// 在 react-agent.service.ts 中增加 turn/step 追踪
interface AgentState {
  turn: number;     // 第几轮用户对话（每次 chat() 调用 +1）
  step: number;     // 当前 turn 内的第几步
  phase: 'idle' | 'running' | 'error';
  lastTurnEndReason?: 'completed' | 'max_tokens' | 'error' | 'aborted';
}
```

好处：
- 可以精确限制"每 turn 最多 N 步"（需求 3.2）
- 可以检测"连续 N 步没有实质性进展"
- 日志中能看到 Agent 在哪一 turn 哪一步卡住

#### 5.2 Phase 状态机

当前项目：没有显式状态机，只靠 `graphDirty` 标记 + try/catch 兜底。

改进方案：
```typescript
type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'running'; turn: number; step: number; abort: AbortController }
  | { kind: 'error'; turn: number; step: number; error: string };

// 每次状态转换时打日志 + 推事件给前端
// 前端可以展示 "Agent 正在思考 (第 3/25 步)" 而不是一直转圈
```

好处：
- 状态转换可观测（前端可以展示实时状态）
- 错误恢复有明确边界（error 状态 → 可以 resume，也可以 reset）
- AbortController 全程传递（Harness 的 `signal.throwIfAborted()` 模式）

#### 5.3 Inbox 消息队列

当前项目：`session.messages` 是扁平数组，user/assistant/tool 混在一起，无法区分"本轮新消息"和"历史消息"。

改进方案：
```typescript
// 把消息队列分层
interface Inbox {
  nextTurn: Message[];   // 下一轮才处理的消息
  nextStep: Message[];   // 当前轮下一步就处理的消息（工具结果等）
}

// 用户消息 → nextTurn
// 工具结果 → nextStep
// 打断消息 → nextStep（steer）
```

好处：
- 工具结果不会污染用户消息序列
- 打断消息可以精准插入当前步
- 清理时只清理 nextStep，不丢用户消息

#### 5.4 max-tokens sticky

Harness 的做法：一旦某个 step 触发了 max-tokens，turn 的结束原因就被锁定为 `max-tokens`，后续 step 即使正常完成也不能降级。

当前项目的 maxTokens 问题（需求 3 第 2 点）：reasoning 吃掉预算 → 正文截断 → 静默停止。

改进方案：
```typescript
// 在 streamAgentEvents 中检测截断：
// 1. 检查 LLM 返回的 finish_reason === 'length'
// 2. 如果是 → 标记 turnEndReason = 'max_tokens'
// 3. 注入提示："上一步输出因 token 限制被截断，请简化输出或拆分步骤"
// 4. 如果连续 2 步 max_tokens → 直接终止，向用户报告
```

#### 5.5 结构化错误处理

当前项目：所有错误都是 `try/catch` + 字符串返回，没有错误分类。

Harness 的做法：
```typescript
// LlmError 包含 code（错误码）+ message + failure（原始错误）
// 错误码：NO_ADAPTER / RATE_LIMITED / CONTEXT_TOO_LONG / UNKNOWN
// 不同错误码有不同恢复策略：
//   RATE_LIMITED → 等待后重试
//   CONTEXT_TOO_LONG → 触发 compaction
//   NO_ADAPTER → 不可恢复，直接报错
```

改进方案：
```typescript
// 定义错误类型
type AgentErrorCode = 
  | 'TOOL_TIMEOUT'        // 工具执行超时
  | 'LLM_MAX_TOKENS'      // LLM 输出截断
  | 'LLM_RATE_LIMITED'    // LLM 限流
  | 'RECURSION_LIMIT'     // 步数超限
  | 'DEAD_LOOP'           // 死循环检测
  | 'TOOL_REPEATED';      // 工具重复调用

// 不同 code 不同恢复策略
```

---

## 实施建议

### 优先级

| 优先级 | 需求 | 理由 |
|--------|------|------|
| P0 | 需求 1 + 2（删除 AB 测试 + 无关代码） | 无风险，直接删，5 分钟搞定 |
| P0 | 需求 3（死循环修复） | 当前最大的用户体验问题，Agent 经常卡死 |
| P1 | 需求 4（批量测试截断） | 影响批量验证功能可用性 |
| P2 | 需求 5（借鉴 Harness 主循环） | 架构改进，可以在 P0/P1 中部分落地 |

### 建议实施顺序

1. **先做需求 1+2**：删除 AB 测试脚本 + legacy 目录，提交一个干净 commit
2. **再做需求 3 的 3.1 + 3.2 + 3.3**：工具重复检测 + 最大步数 + 工具超时（这三项改动都在 `react-agent.service.ts` 的 `streamAgentEvents` 方法中，约 100 行新增）
3. **再做需求 4 的 4.1 + 4.2 + 4.4**：并发执行 + 结果截断 + 早期终止（改动集中在 `batch-validate.tool.ts`）
4. **最后做需求 5**：在 P0/P1 改动中顺带引入 turn/step 计数和 Phase 状态机，不需要一次性全部重写主循环

### 需求 5 的渐进式落地

不需要立刻把 LangGraph `createReactAgent` 替换为自研主循环。可以渐进式地：

- **Phase 1**：在现有 `streamAgentEvents` 外层加 turn/step 计数 + 死循环检测 + 工具超时（改动量小，收益大）
- **Phase 2**：引入 AbortController 全程传递（替代当前的 `graphDirty` hack）
- **Phase 3**：如果 LangGraph 黑盒限制太多，再考虑自研主循环（借鉴 Harness 的 turn/step 双层 + Inbox 队列）

---

## 参考文件清单

请逐一阅读以下文件后再动手：

| 文件 | 用途 |
|------|------|
| `apps/api/src/agent/react-agent.service.ts` | 主循环，需求 3、5 的核心改动点 |
| `apps/api/src/agent/tools/batch-validate.tool.ts` | 批量验证，需求 4 的核心改动点 |
| `apps/api/src/agent/session.store.ts` | 会话存储，需求 5 的 Inbox 改造涉及 |
| `apps/api/src/agent/tools/iteration-counter.ts` | 迭代计数器，需求 3 的重复检测会涉及 |
| `apps/api/src/app.module.ts` | 根模块，需求 2 需要删除 LegacyModule 引用 |
| `apps/api/scripts/ab-test-update-schema.ts` | 需求 1 删除目标 |
| `apps/api/src/legacy/` | 需求 2 删除目标目录 |
| `apps/api/test-plan.ts` | 需求 2 删除目标 |
| DeepSeek Harness `agent.ts` | 参考 `~/workspace/deepseek-harness-study/source/packages/core/agent-loop/src/agent.ts`（496 行） |

---

## 验收标准

### 需求 1
- [ ] `ab-test-update-schema.ts` 已删除
- [ ] `git grep ab-test` 无结果

### 需求 2
- [ ] `legacy/` 目录已删除
- [ ] `app.module.ts` 中无 LegacyModule 引用
- [ ] `test-plan.ts` 已删除
- [ ] `npm run build` 通过

### 需求 3
- [ ] 同一工具同一参数连续调用 3 次 → 第 4 次被拦截，Agent 收到警告
- [ ] 单 turn 超过 25 步 → Agent 终止并向用户报告
- [ ] 单个工具调用超过 120 秒 → 超时标记，Agent 继续执行（不崩溃）
- [ ] maxTokens 截断被检测到 → Agent 提示用户简化需求

### 需求 4
- [ ] 10 个用例并发执行，总耗时 < 3 分钟（原来串行 10+ 分钟）
- [ ] 返回的 JSON 中 details 只包含失败用例
- [ ] 前 5 个用例全部失败时立即终止

### 需求 5
- [ ] `streamAgentEvents` 中有 turn/step 计数
- [ ] 前端能收到 Agent 当前状态的实时事件（如 `{ type: "status", phase: "running", turn: 1, step: 3 }`）
- [ ] 每个工具调用包裹 AbortSignal
- [ ] 错误类型有 code 区分（不再只是字符串）