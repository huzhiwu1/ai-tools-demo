# Qoder 任务：Sprint B — 通用文件读取 + 验证闭环（批量试运行 + 归因迭代）

> 项目：`/Users/huzhiwu/workspace/ai-tools-demo/src/agent-coze-workflow`
> 技术栈：NestJS 11 + LangGraph createReactAgent + pnpm workspace
> **目标：给 ReAct Agent 装上"验证闭环"——用户上传任意文件（Excel/CSV/Markdown 等），Agent 只做通用读取，由 LLM 理解文件用途、判断信息是否完整、缺了就向用户提问，然后设计/生成/保存/试运行工作流，对照用户期望验证准确性，不达标就归因修改重新验证，直到通过或 3 次封顶。**

---

## 零、核心设计原则（最重要，先读三遍）

**⚠️ 我们不知道用户上传的文件是干什么的。** 可能是答案表、歌词库、规则文档、参考数据……任何东西。系统不做任何业务假设：

- ❌ 不预设"这是答案表，有 url/song 列"
- ❌ 不预设"这是歌词库，用《歌名》解析"
- ❌ 不预设"文件必须包含输入列和期望输出列"
- ✅ 文件读取工具只做一件事：**把文件内容读成通用数据结构**（表格 → 行列数据；文本 → 文本内容）
- ✅ 文件用途、列含义、数据怎么用 —— **全部由 LLM 根据用户需求判断**；判断不了就调 clarify_question 问用户
- ✅ 验证闭环的"用例"由 LLM 根据文件内容和用户需求构造，不是代码写死

> 为什么？—— 这是通用系统。今天用户传"唱歌测试集"做歌曲识别，明天可能传"订单明细"做数据处理、传"产品文档"做知识库。任何业务假设都会让系统在某天坏掉。

---

## 一、项目现状（先读这些文件）

- `apps/api/src/agent/react-agent.service.ts` — ReAct Agent 核心，createReactAgent + 5 工具（clarify/plan/generate/save/test_run）+ SSE 流
- `apps/api/src/agent/tools/index.ts` — 工具注册列表（ALL_TOOLS），**新工具加到这里**
- `apps/api/src/agent/tools/` — 已有 5 个工具文件，新工具同目录新建
- `apps/api/src/mcp/cozeClient.ts` — CozeClient（testRun 已有，**缺执行结果查询，本任务补**）
- `apps/api/src/agent/react-agent.controller.ts` — 已有 `POST /api/agent/upload`（存文件到 uploads/ 目录，返回 fileId/path/name）
- `test-data/singing-testset.xlsx` — **测试用样本文件**（用于验证"通用读取"是否工作）
- `test-data/song-lyrics.md` — **测试用样本文件**（同上）

**注意**：`test-data/` 下的文件只是**测试读取功能的样本**，不是系统的业务假设。系统的业务理解 100% 由 LLM 现场判断。

---

## 二、目标

ReAct Agent 新增 3 个工具，总数 5 → 8：

| 工具 | 职责 |
|---|---|
| read_file | **通用文件读取**：xlsx/csv → 行列数据；md/txt/json → 文本内容。零业务假设 |
| batch_validate | 批量 test_run + 轮询结果 + 对照期望 → 准确率 + 错误明细 |
| update_workflow | 根据归因结果修改工作流节点（调阈值/改代码/改 prompt） |

并补强：CozeClient 增加「查询执行结果」能力（test_run 返回 execute_id 后轮询拿真实输出）。

---

## 三、关键设计决策（照此实现）

### 1. CozeClient 补执行结果查询（必须先做，batch_validate 依赖）

test_run 只返回 execute_id，**工作流跑完没跑完、输出是什么，需要查询接口**。接口路径需实测确认（平台是私有部署，接口在 `/api/workflow_api/*`）：

- **探测方法**：登录平台 → 打开一个跑过的工作流 → DevTools Network 面板 → 找执行详情/日志相关请求（关键词：execute、run、detail、log）
- **兜底候选**（按优先级尝试）：
  1. `POST /api/workflow_api/execute_detail` body `{execute_id}`
  2. `POST /api/workflow_api/execute_info` body `{execute_id}`
  3. `POST /api/workflow_api/run_log` body `{execute_id}`
- **实现**：CozeClient 加 `queryExecute(executeId: string)` 方法：
  - 请求拿执行状态和输出
  - 状态字段：running/success/fail（字段名以实测为准，代码里注释说明）
  - 输出字段：工作流 end 节点的返回值（可能嵌套在 data 里，需要递归找第一个非空 output 对象）
  - **失败降级**：接口探测不到时，方法抛 CozeError 带清晰提示（"执行详情接口未打通，需在平台 DevTools 抓包确认路径"），batch_validate 能感知并返回错误信息给 LLM

**⚠️ 如果接口实在探测不到**：先让 batch_validate 只做"提交成功"验证（拿到 execute_id 即视为运行中），并在返回信息里注明"结果轮询待接口打通"，不要卡死整个闭环。但要优先尝试打通。

### 2. 通用文件读取工具（read_file）—— 核心，零业务假设

```
输入: filePath（upload 返回的 path）
输出: {
  fileName, fileType,        // 如 xlsx / csv / md / txt / json
  format: "table" | "text",  // 表格类 → table；文档类 → text
  columns?: string[],        // format=table 时：表头数组
  rows?: Array<Record<string, unknown>>, // format=table 时：行数据（列名→值）
  content?: string,          // format=text 时：全文内容
  totalRows?, skippedEmptyRows?
}
```

**解析实现要点：**
- 装依赖：`pnpm --filter @coze-workflow/api add xlsx`（SheetJS，一个库同时支持 xlsx 和 csv）
- **按扩展名分派**：
  - `.xlsx` / `.xls` / `.csv` → 表格解析（读第一个 sheet）：第 1 行作表头，后续行转 `{列名: 值}` 对象；空行跳过（计入 skippedEmptyRows）；行内空单元格值为 null
  - `.md` / `.txt` / `.json` / 其他 → 文本解析：`fs.readFileSync` 读全文，放 `content` 字段
- **不做任何业务处理**：不翻译列名、不推断列含义、不提取"歌曲名"、不剥离"参考歌词"前缀——原样返回
- 返回完整 JSON 字符串（LLM 可读）
- **try/catch 兜底**：解析失败返回 "读取失败: xxx"（ReAct 工具铁律）
- **工具 description 必须写清楚**："返回文件原始内容。文件的具体用途、列的含义、数据如何参与工作流，由你（LLM）根据用户需求判断；如果无法判断，调用 clarify_question 向用户询问。"

### 3. 批量验证工具（batch_validate）—— 核心

```
输入: workflowId, cases, 可选 concurrentLimit（默认 3）
     cases 由 LLM 构造：[{ input: Record<string, unknown>, expected: string }]
     说明：LLM 根据用户需求 + read_file 读到的文件内容，决定"哪些行/哪些数据是测试用例、期望值是什么"
输出: {
  total, passed, failed,
  accuracy,                    // passed / total，百分比
  details: [{ input, expected, actual, match, error? }],
  failurePatterns: {           // 归因分组
    emptyOutput: number,       // 输出为空/找不到
    mismatch: number,          // 输出了但不是期望结果
    executionError: number     // test_run/查询报错
  }
}
```

**实现流程：**

```
1. 遍历 cases（串行或小并发，默认串行优先，稳）
2. 每个用例：
   a. cozeClient.testRun(workflowId, case.input) → executeId
   b. 轮询 queryExecute(executeId)：每 2 秒查一次，最多 90 秒
      - 超时 → executionError，error="执行超时"
      - 查询报错 → executionError，error=错误信息
   c. 取输出中的结果字段（从 execute 结果里递归找非空字符串值）
   d. 比对：
      - actual === expected → passed
      - actual 为空/找不到 → emptyOutput
      - actual !== expected → mismatch
3. 汇总 accuracy = passed / total * 100（保留 1 位小数）
4. 返回完整 JSON（含 details 和 failurePatterns）
```

**轮询注意**：
- 用 `setInterval` 或 `for` 循环 + `await sleep(2000)`，**不要阻塞事件循环**
- 90 秒超时上限，超时标记 executionError 继续下一个用例
- 用例多时提示 LLM 串行跑（或并发 2-3 个，注意平台限流，健康食养项目踩过坑）

### 4. 工作流更新工具（update_workflow）

```
输入: workflow（当前工作流 JSON）, fixInstruction（LLM 归因后给出的修改指令）
输出: { workflow: 修改后的工作流, changes: 修改说明列表 }
```

**修改能力（按 fixInstruction 的关键词匹配规则优先，LLM 兜底）：**
- "阈值" → 找代码节点里的相似度/判断阈值常量，按指令调（如 0.8 → 0.6）
- "代码"/"逻辑" → 重写代码节点的业务逻辑（LLM 生成新代码）
- "prompt"/"提示词" → 修改 LLM 节点的 userPrompt/systemPrompt
- "数据"/"常量" → 更新代码节点里的数据常量（如把用户提供的参考数据写入节点）
- 其他 → 返回错误提示让 LLM 明确指令

**实现**：基于 `WorkflowGenerator` 生成的 CozeWorkflow 结构，直接改对应节点的字段。改完返回完整 workflow + changes 列表。**本工具不调平台 API**（保存是 save_to_coze 的事）。

### 5. interrupt 交互改造（合并输入框，方案 B）—— 附加任务

**背景**：当前实现（Sprint C）里 AI 提问时弹独立回答卡片（chat-message-list.tsx 的 AnswerForm），卡片自带输入框，**没有上传文件按钮**；上传按钮只在底部主输入框（ChatInput）里。用户困惑该用哪个框，且需要传文件时无法在回答卡片里操作。

**目标**：合并成一个输入框——AI 提问时，**底部主输入框切换为"回复 AI 的问题"模式**，用户始终只有一个输入框，上传按钮天然保留。

**前端改动（apps/web/）：**

- `App.tsx`：
  - 新增状态 `replyMode: boolean`（是否处于回复 AI 问题模式）
  - `handleDataEvent` 收到 `interrupt` 事件时：`setPendingQuestion({...})` + `setReplyMode(true)`
  - `handleSend`（普通发送）时：`setReplyMode(false)`
  - 提交回答：走现有 `handleAnswer(answer, fileIds?)`，完成后 `setReplyMode(false)`
- `chat-message-list.tsx`：
  - 提问卡片**只展示问题文本和 context**，不再渲染 AnswerForm 输入框
  - 提示文案改为"请在下方输入框回复 AI 的问题"
  - 删除 AnswerForm 组件（或保留但不再使用）
- `chat-input.tsx`：
  - 新增 prop：`mode: "normal" | "reply"`、`onAnswer: (text: string, fileIds: string[]) => void`、`pendingQuestionText?: string`
  - reply 模式：placeholder 改为"回复 AI 的问题…（Ctrl+Enter 发送）"，输入框上方显示当前问题摘要（可滚动，最多 2 行截断）
  - 提交逻辑：reply 模式调 `onAnswer(text, fileIds)`（文件引用同样拼接/传 fileIds），normal 模式调 `onSend(text)`
  - **上传按钮两模式都保留**（天然满足"AI 询问时可传文件"）
  - 发送按钮文案：reply 模式 "回复"，normal 模式 "发送"

**后端改动（apps/api/）：**

- `react-agent.controller.ts` 的 `POST /api/agent/chat/resume`：body 增加可选 `fileIds?: string[]`（本次回答附带的上传文件）
- `react-agent.service.ts` 的 `handleResume`：接收 `fileIds` 参数，把文件引用信息拼进 resume 的 answer 文本（如 `answer + "\n\n[用户上传了文件]\n- xxx (fileId: ...)"`），再 `Command({ resume })`——这样 LLM 能感知到回答时带了文件
- 文件的实际读取由 read_file 负责，本任务只做到"传递 fileIds 引用"

**验收（前端浏览器实测）**：
- 发缺信息需求 → AI 提问 → 底部输入框变为"回复 AI 的问题"模式（有提示文案）→ 输入回答提交 → AI 继续执行 → 完成后输入框恢复普通模式
- 回复模式下上传按钮可用，上传后提交，resume 请求体里带 fileIds

### 6. 系统提示词更新（react-agent.service.ts 的 SYSTEM_PROMPT）

更新「可用工具」列表为 8 个，并新增使用流程规则：

```
## 文件与验证流程（当用户上传文件或要求验证时）
1. 用户上传文件 → 调用 read_file 读取内容（通用读取，不做业务假设）
2. 根据用户需求 + 文件内容，判断：
   - 文件是干什么的？（数据源？期望结果？参考文档？）
   - 信息是否完整？是否还缺关键信息（如判断标准、字段含义、输出格式）？
   - 不确定 → 调用 clarify_question 向用户询问
3. LLM 完全理解需求后，再 plan_workflow 设计工作流
4. generate_workflow 生成 → 检查 validation
5. save_to_coze 保存 → 拿 workflowId
6. batch_validate 批量试运行（cases 由 LLM 根据文件内容构造）→ 看 accuracy
7. 若 accuracy < 100% 且迭代次数 < 3：
   分析 failurePatterns → 给出 fixInstruction → update_workflow → 重新 save → batch_validate
8. 迭代 3 次仍 < 100%：向用户说明情况，或 clarify_question 索取信息，用户确认后继续
9. 验证通过：总结交付（含最终 workflowId 和 accuracy）
```

---

## 四、验收标准

1. `pnpm typecheck` 全绿；`pnpm build` 全绿
2. **read_file 通用读取实测**（用 test-data 两个文件）：
   - 读取 `test-data/singing-testset.xlsx` → format=table，columns=[url,song]，19 行有效数据，空行跳过
   - 读取 `test-data/song-lyrics.md` → format=text，content 含原文（不剥离任何前缀）
3. **批量验证实测**（可选，依赖平台认证）：
   - 用已保存的工作流 + LLM 构造的用例跑 batch_validate → 返回 accuracy + details + failurePatterns
   - 若 COZE_SESSION_KEY 过期，返回明确错误信息（不是 500）
4. **Agent 全链路**（curl 或前端）：给 Agent 一条消息包含"需求 + 文件路径"，观察它自动走完 read_file → 理解/提问 → plan → generate → save → batch_validate →（迭代）→ 交付
5. **缺信息提问实测**：给 Agent 一个模糊需求 + 一个不明确用途的文件，观察它会调用 clarify_question 询问文件用途/列含义，而不是瞎猜
6. 旧功能不回归：5 个旧工具仍正常
7. **合并输入框验收**（前端浏览器实测）：
   - 发缺信息需求 → AI 提问 → 底部输入框变为"回复 AI 的问题"模式（有提示文案）→ 输入回答提交 → AI 继续执行 → 完成后输入框恢复普通模式
   - 回复模式下上传按钮仍可用，上传后提交，resume 请求体里带 fileIds

---

## 五、红线

- ❌ 不改 react-agent.service.ts 的 SSE 协议（Data Stream 格式是 Sprint C 刚定的）
- ❌ 不删除旧链路（agents/graph.ts）
- ❌ 不加 UI 相关依赖
- ❌ 不把凭证写进代码（COZE_* 从 .env 读）
- ❌ **不做任何业务假设**：read_file 里禁止出现"歌曲""歌词""答案""url/song""《》"等业务相关解析逻辑（test-data 文件名可以出现，因为那是测试样本）
- ❌ batch_validate 不解析文件（文件理解是 LLM 的事），只接收 LLM 构造好的 cases
- ✅ 新工具全部走 try/catch 返回错误字符串（ReAct 铁律）
- ✅ 工具用模块级单例（参考 save.tool.ts 的写法）

---

## 六、实现顺序建议

1. CozeClient 加 queryExecute（先探测平台接口路径，探测不到用兜底候选 + 降级）
2. 装 xlsx 依赖，写 read_file（通用读取，先单独验证两个样本文件）
3. 写 batch_validate（依赖 1，先串行跑通 3 个用例再全量）
4. 写 update_workflow（基于规则修改）
5. tools/index.ts 注册 3 个新工具 + SYSTEM_PROMPT 更新
6. **合并输入框改造**（前端）：replyMode 状态机 + chat-input 双模式 + resume 接口支持 fileIds
7. 全链路实测（用 test-data 两个文件 + 平台）
