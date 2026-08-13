# Qoder 任务：Sprint B — 验证闭环（答案表/歌词库解析 + 批量试运行 + 归因迭代）

> 项目：`/Users/huzhiwu/workspace/ai-tools-demo/src/agent-coze-workflow`
> 技术栈：NestJS 11 + LangGraph createReactAgent + pnpm workspace
> **目标：给 ReAct Agent 装上"验证闭环"——解析用户上传的答案表和歌词库 → 批量试运行工作流 → 对照答案表算准确率 → 错误归因 → 修改工作流 → 重新验证，直到 100% 或迭代 3 次封顶。这是系统"能保证工作流真的能用"的核心能力。**

---

## 一、项目现状（先读这些文件）

- `apps/api/src/agent/react-agent.service.ts` — ReAct Agent 核心，createReactAgent + 5 工具（clarify/plan/generate/save/test_run）+ SSE 流
- `apps/api/src/agent/tools/index.ts` — 工具注册列表（ALL_TOOLS），**新工具加到这里**
- `apps/api/src/agent/tools/` — 已有 5 个工具文件，新工具同目录新建
- `apps/api/src/mcp/cozeClient.ts` — CozeClient（testRun 已有，**缺执行结果查询，本任务补**）
- `apps/api/src/agent/react-agent.controller.ts` — 已有 `POST /api/agent/upload`（Sprint C 加的，存文件到 uploads/ 目录，返回 fileId/path/name）
- `test-data/singing-testset.xlsx` — **答案表基准**（19 条正例：url + song，空行忽略）
- `test-data/song-lyrics.md` — **歌词库基准**（8 首：《映山红》《天边》《花非花》《花又落》《珊瑚颂》《在那遥远的地方》《画你》《绒花》）

**答案表格式（已验证）：**
```
表头: url | song
19 条有效行（url 非空），song 为期望歌曲名
后续可能有空行（Excel 格式残留），解析时跳过 url 为空的行
无负例（不做"非训练营"验证）
```

**歌词库格式（已验证）：**
```
# 《映山红》
参考歌词：夜半三更哟盼天明，寒冬腊月呦盼春风，……
# 《天边》
参考歌词：天边有一对双星，……
# 《珊瑚颂》
一树红花照碧海，……（注意：有的带"参考歌词："前缀，有的没有，解析时统一去掉）
```

---

## 二、目标

ReAct Agent 新增 4 个工具，总数 5 → 9：

| 工具 | 职责 |
|---|---|
| parse_answer_sheet | 解析 xlsx/csv 答案表 → 用例列表（url + expected） |
| parse_lyrics_library | 解析 md 歌词库 → 歌曲字典（song_name → lyrics） |
| batch_validate | 批量 test_run + 轮询结果 + 对照答案表 → 准确率 + 错误明细 |
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

### 2. 答案表解析工具（parse_answer_sheet）

```
输入: filePath（upload 返回的 path）
输出: { cases: [{ url, expected }], total, skippedEmptyRows }
```

**解析实现要点：**
- 装依赖：`pnpm --filter @coze-workflow/api add xlsx`（SheetJS，一个库同时支持 xlsx 和 csv）
- 读文件 → 取第一个 sheet → 遍历行：
  - 第 1 行是表头（url/song），跳过
  - `url` 为空或非字符串 → 跳过（**空行忽略，计入 skippedEmptyRows**）
  - `song` 为空 → expected = ""（预期"无法识别或非训练营"，但当前无负例，先保留空字符串）
  - 有效行 → `{ url: url.trim(), expected: String(song ?? "").trim() }`
- 返回结构化 JSON 字符串（LLM 可读）
- **try/catch 兜底**：解析失败返回 "解析失败: xxx"（ReAct 工具铁律）

### 3. 歌词库解析工具（parse_lyrics_library）

```
输入: filePath
输出: { songs: [{ name, lyrics }], total }
```

**解析实现要点（正则，不需要库）：**
- 按 `^#+\s*《(.+?)》` 匹配歌名标题行
- 标题行到下一个标题行之间的文本 = 歌词
- 歌词清洗：去掉行首"参考歌词："前缀、去除空白字符（`\s`）、换行合并
- 输出 `[{ name: "映山红", lyrics: "夜半三更哟盼天明寒冬腊月呦盼春风..." }]`
- **try/catch 兜底**

### 4. 批量验证工具（batch_validate）—— 核心

```
输入: workflowId, cases（parse_answer_sheet 的输出）, 可选 concurrentLimit（默认 3）
输出: {
  total, passed, failed,
  accuracy,                    // passed / total，百分比
  details: [{ url, expected, actual, match, error? }],
  failurePatterns: {           // 归因分组
    recognitionFailed: number, // 输出为空/无法识别
    mismatch: number,          // 输出了但不是期望歌名
    executionError: number     // test_run/查询报错
  }
}
```

**实现流程：**

```
1. 遍历 cases（串行或小并发，默认串行优先，稳）
2. 每个用例：
   a. cozeClient.testRun(workflowId, { url: case.url }) → executeId
   b. 轮询 queryExecute(executeId)：每 2 秒查一次，最多 90 秒
      - 超时 → executionError，error="执行超时"
      - 查询报错 → executionError，error=错误信息
   c. 取输出中的歌曲名字段（从 execute 结果里递归找字符串值）
   d. 比对：
      - actual === expected → passed
      - actual 为空/找不到 → recognitionFailed
      - actual !== expected → mismatch
3. 汇总 accuracy = passed / total * 100（保留 1 位小数）
4. 返回完整 JSON（含 details 和 failurePatterns）
```

**轮询注意**：
- 用 `setInterval` 或 `for` 循环 + `await sleep(2000)`，**不要阻塞事件循环**
- 90 秒超时上限，超时标记 executionError 继续下一个用例
- 每个用例最多耗时 ~2 分钟，19 个用例串行 ~38 分钟——**可以接受但提示 LLM 串行跑**（或并发 2-3 个，注意平台限流，健康食养项目踩过坑）

### 5. 工作流更新工具（update_workflow）

```
输入: workflow（当前工作流 JSON）, fixInstruction（LLM 归因后给出的修改指令）
输出: { workflow: 修改后的工作流, changes: 修改说明列表 }
```

**修改能力（按 fixInstruction 的关键词匹配规则优先，LLM 兜底）：**
- "阈值" → 找代码节点里的相似度阈值常量，按指令调（如 0.8 → 0.6）
- "匹配算法" → 重写代码节点的匹配逻辑（规则模板：字符重叠率/Jaccard 相似度）
- "prompt"/"提示词" → 修改 LLM 节点的 userPrompt/systemPrompt（如补充"输出格式必须是歌名"）
- "歌词库" → 更新代码节点里的歌词常量数据
- 其他 → 返回错误提示让 LLM 明确指令

**实现**：基于 `WorkflowGenerator` 生成的 CozeWorkflow 结构，直接改对应节点的字段。改完返回完整 workflow + changes 列表。**本工具不调平台 API**（保存是 save_to_coze 的事）。

### 6. 系统提示词更新（react-agent.service.ts 的 SYSTEM_PROMPT）

更新「可用工具」列表为 9 个，并新增使用流程规则：

```
## 工作流构建+验证流程（当用户提供答案表/歌词库时）
1. 先调用 parse_answer_sheet 解析答案表，parse_lyrics_library 解析歌词库
2. plan_workflow 设计工作流（歌词库作为代码节点常量或 prompt 上下文）
3. generate_workflow 生成 → 检查 validation
4. save_to_coze 保存 → 拿 workflowId
5. batch_validate 批量试运行 → 看 accuracy
6. 若 accuracy < 100% 且迭代次数 < 3：
   分析 failurePatterns → 给出 fixInstruction → update_workflow → 重新 save → batch_validate
7. 迭代 3 次仍 < 100%：向用户说明情况，或 clarify_question 索取信息，用户确认后继续
8. 准确率 100%：总结交付（含最终 workflowId 和 accuracy）
```

---

## 四、验收标准

1. `pnpm typecheck` 全绿；`pnpm build` 全绿
2. **解析单测**（用 test-data 两个文件实测）：
   - parse_answer_sheet 解析 `test-data/singing-testset.xlsx` → 19 个用例，空行跳过
   - parse_lyrics_library 解析 `test-data/song-lyrics.md` → 8 首歌，歌词无"参考歌词："前缀
3. **批量验证实测**（可选，依赖平台认证）：
   - 用已保存的工作流 + 19 条用例跑 batch_validate → 返回 accuracy + details + failurePatterns
   - 若 COZE_SESSION_KEY 过期，返回明确错误信息（不是 500）
4. **Agent 全链路**（curl 或前端）：给 Agent 一条消息包含"需求 + 答案表路径 + 歌词库路径"，观察它自动走完 parse → plan → generate → save → batch_validate →（迭代）→ 交付
5. 旧功能不回归：5 个旧工具仍正常

---

## 五、红线

- ❌ 不改 react-agent.service.ts 的 SSE 协议（Data Stream 格式是 Sprint C 刚定的）
- ❌ 不删除旧链路（agents/graph.ts）
- ❌ 不加 UI 相关依赖
- ❌ 不把凭证写进代码（COZE_* 从 .env 读）
- ❌ 不在答案表里处理负例（当前无负例，song 空时 expected=""，验证逻辑按"有期望值才算通过"）
- ✅ 新工具全部走 try/catch 返回错误字符串（ReAct 铁律）
- ✅ 工具用模块级单例（参考 save.tool.ts 的写法）

---

## 六、实现顺序建议

1. CozeClient 加 queryExecute（先探测平台接口路径，探测不到用兜底候选 + 降级）
2. 装 xlsx 依赖，写 parse_answer_sheet + parse_lyrics_library（纯本地，先单独验证）
3. 写 batch_validate（依赖 1，先串行跑通 3 个用例再全量）
4. 写 update_workflow（基于规则修改）
5. tools/index.ts 注册 4 个新工具 + SYSTEM_PROMPT 更新
6. 全链路实测（用 test-data 两个文件 + 平台）
