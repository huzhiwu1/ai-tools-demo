# Coze 工作流自动生成 Agent - MVP 详细技术方案

> 目标：先做一个最小可用版本（MVP），实现“用户输入需求 → LLM 生成工作流草图/JSON → 调用内部 MCP 创建/保存/试运行 → 返回结果”的主链路。
>
> 额外目标：在实现过程中同步学习 AI Agent 的核心知识，并沉淀面试可讲的关键点。

---

## 0. 这版 MVP 的定位

这不是“完整自愈型工作流工厂”，而是一个**能跑通、能讲清楚、能继续迭代**的第一版。

### MVP 要解决的核心问题

1. 用户用自然语言描述需求
2. LLM 把需求结构化，并规划工作流
3. LLM 输出符合 Coze 约束的节点 JSON
4. 通过 MCP 调用企业内部 Coze 接口完成：
   - 创建工作流
   - 保存工作流
   - 试运行工作流
5. 把执行结果返回给用户

### MVP 暂时不做

- 自动修复闭环
- 工作流详情读取/编辑完善
- 运行日志智能归因
- 多轮对话式设计
- 完整节点库/全类型节点覆盖
- 复杂版本回滚/发布管理

> 原则：先做“生成 + 保存 + 试跑”最小闭环，别一开始就上天。

---

## 1. 已确认的平台能力

当前已通过浏览器网络请求确认以下接口存在：

### 1.1 Create
`POST /api/workflow_api/create`

作用：创建工作流壳子，返回 `workflow_id`。

返回里已确认字段：
- `data.workflow_id`
- `data.name`
- `data.url`
- `data.status`
- `data.type`
- `data.node_list`
- `code`
- `msg`
- `BaseResp`

### 1.2 Save
`POST /api/workflow_api/save`

作用：保存工作流 schema。

返回里已确认字段：
- `data.name`
- `data.url`
- `data.status`
- `data.workflow_status`
- `data.remaining_ttl`
- `code`
- `msg`
- `BaseResp`

### 1.3 Test Run
`POST /api/workflow_api/test_run`

作用：试运行工作流。

返回里已确认字段：
- `data.workflow_id`
- `data.execute_id`
- `data.session_id`
- `code`
- `msg`
- `BaseResp`

---

## 2. MVP 总体架构

建议把系统拆成 6 层：

```text
用户需求
  ↓
1) 需求解析器
  ↓
2) 工作流规划器
  ↓
3) Coze JSON 生成器
  ↓
4) 本地校验器
  ↓
5) MCP 执行器（create / save / test_run）
  ↓
6) 结果包装器
```

### 2.1 模块职责

#### 1）需求解析器
把用户输入的自然语言需求，转成结构化信息。

输出内容建议包括：
- `goal`：用户目标
- `mode`：create / modify / repair
- `inputType`：文本 / 文件 / 现有 workflow_id / JSON
- `outputType`：工作流 / 节点 JSON / 执行结果
- `constraints`：节点数量、是否需要分支、是否需要代码节点等

#### 2）工作流规划器
把需求转成工作流草图，不直接输出最终 Coze JSON。

输出建议：
- 节点列表
- 边列表
- 节点职责
- 数据流方向
- 是否需要条件分支
- 是否需要代码节点

#### 3）Coze JSON 生成器
把草图映射成 Coze 的节点 schema。

重点：
- 节点 ID 唯一
- 节点类型明确
- 输入输出字段可解析
- 连线合法
- 严格遵守 Coze 的节点/端口规则

#### 4）本地校验器
在 save 之前做静态检查，避免把明显错误发到 Coze。

最少校验：
- JSON 可解析
- start/end 节点存在
- 节点 ID 不重复
- edges 引用的节点都存在
- 代码节点不加非法端口字段
- 节点输出类型与声明一致

#### 5）MCP 执行器
封装内部 Coze 接口，先只做三件事：
- create
- save
- test_run

#### 6）结果包装器
把 MCP 返回结果转成对用户友好的结果：
- workflow_id
- 是否创建成功
- 是否保存成功
- 是否试运行成功
- 如果失败，失败发生在哪一步

---

## 3. MVP 执行流程

### 3.1 新建工作流流程

```text
用户输入需求
  → LLM 解析需求
  → LLM 生成工作流草图
  → LLM 输出 Coze JSON
  → 本地校验 JSON
  → 调 MCP create
  → 调 MCP save
  → 调 MCP test_run
  → 返回结果
```

### 3.2 为什么要这样分层

如果让 LLM 一步到位直接输出最终 Coze JSON，常见问题是：
- 结构混乱
- 节点 ID 乱飞
- 连线不合法
- 节点出边规则错
- 输出字段类型错

先规划、再落 JSON，会稳定很多。

---

## 4. MVP 的 Prompt 设计

建议采用“四段式 Prompt 体系”：

### 4.1 系统 Prompt
定义 agent 身份和规则。

核心要求：
- 你是企业内部 Coze 工作流工程 agent
- 目标是把用户需求变成可执行 workflow
- 优先保证可运行，不追求炫技
- 不能编造平台不存在的字段
- 输出必须可解析

示例：

```text
你是一个企业内部 Coze 工作流工程 agent。
你的任务是根据用户需求生成可执行的 Coze 工作流。
你必须遵守：
1. 优先保证工作流可执行。
2. 不允许编造平台未知字段。
3. 先规划草图，再输出最终 JSON。
4. JSON 必须严格可解析。
5. 修复时优先做最小修改。
```

### 4.2 需求解析 Prompt
让 LLM 把输入转成结构化摘要。

输出格式建议固定为 JSON，例如：

```json
{
  "mode": "create",
  "goal": "生成一个文章总结工作流",
  "input": "用户输入的文章链接",
  "output": "摘要文本",
  "needBranch": false,
  "needCodeNode": true,
  "needDatabaseNode": false,
  "riskHints": ["需要提取正文", "需要总结"]
}
```

### 4.3 草图规划 Prompt
先输出节点草图。

输出格式建议：

```json
{
  "nodes": [
    {"id": "start", "type": "start", "purpose": "接收输入"},
    {"id": "llm_1", "type": "llm", "purpose": "提取关键信息"},
    {"id": "end", "type": "end", "purpose": "返回结果"}
  ],
  "edges": [
    {"from": "start", "to": "llm_1"},
    {"from": "llm_1", "to": "end"}
  ]
}
```

### 4.4 Coze JSON 生成 Prompt
把草图转成平台 schema。

必须强制模型：
- 只输出 JSON
- 所有字段名精确
- 节点 ID 唯一
- 不要输出解释文本
- 代码节点不要乱加端口字段
- 分支节点严格遵守分支规则

### 4.5 修复 Prompt（MVP 暂不启用自动修复）
MVP 阶段先预留，不真正执行自动修复。

未来输入：
- 原 workflow JSON
- 试运行错误信息
- 报错节点上下文

目标：生成最小 patch。

---

## 5. Coze JSON 生成策略

### 5.1 不要一步生成全部最终 JSON
推荐三步：
1. 生成节点草图
2. 生成节点模板实例
3. 组装最终 Coze schema

### 5.2 节点模板化
MVP 只支持少量节点模板：
- 开始节点
- 结束节点
- LLM 节点
- 代码节点
- 条件分支节点
- 查询节点

先把这些模板吃透，再扩展。

### 5.3 必须内置的规则
结合已知坑，MVP 至少要硬编码以下规则：

- 代码节点出边不要写非法 `sourcePortID`
- 起始节点和结束节点必须存在
- 节点之间的边必须引用真实存在的节点 ID
- 节点输出类型必须和声明一致
- 尽量避免生成 Coze 平台未知字段

这些规则可以先写在本地 validator 里，不要全指望 LLM 记住。

---

## 6. MCP 设计（MVP 版）

### 6.1 只做 3 个工具

#### Tool 1：`create_workflow`
作用：创建工作流壳子。

输入：
- `name`
- `desc`
- `icon_uri`
- `space_id`
- `flow_mode`

输出：
- `workflow_id`
- `status`
- `url`

#### Tool 2：`save_workflow`
作用：保存 workflow schema。

输入：
- `workflow_id`
- `schema`
- `space_id`
- `submit_commit_id`
- `ignore_status_transfer`

输出：
- `status`
- `workflow_status`
- `remaining_ttl`

#### Tool 3：`test_run_workflow`
作用：试运行 workflow。

输入：
- `workflow_id`
- `input`
- `space_id`
- `commit_id`

输出：
- `execute_id`
- `session_id`

### 6.2 为什么先不做更多工具
因为 MVP 的目标是跑通主链路，不是把所有平台能力一次包完。

后续再补：
- workflow 详情读取
- 运行结果查询
- 日志查询
- 版本管理

---

## 7. MVP 的实施步骤

### 阶段 1：骨架搭建
你来完成：
- 建一个 Node/TS 或 Python 项目骨架
- 预留 agent / mcp / schema / validator 目录
- 能接收用户输入

我负责：
- 帮你定义结构
- 帮你设计 prompt
- 帮你 review schema

### 阶段 2：需求解析 + 草图生成
你来完成：
- 写需求解析 prompt
- 写草图输出 schema
- 做最小的本地 JSON 校验

我负责：
- 帮你打磨 prompt
- 帮你判断输出结构是否稳

### 阶段 3：MCP 封装
你来完成：
- 封装 `create_workflow`
- 封装 `save_workflow`
- 封装 `test_run_workflow`

我负责：
- 帮你梳理入参/出参
- 帮你检查流程是否完整

### 阶段 4：打通闭环
你来完成：
- 让 agent 串起 create → save → test_run

我负责：
- 帮你分析试运行结果
- 帮你沉淀面试要点

---

## 8. MVP 需要的最小文件结构

建议如下：

```text
agent-coze-workflow/
  ├── src/
  │   ├── agent/
  │   │   ├── index.ts
  │   │   ├── prompts.ts
  │   │   └── planner.ts
  │   ├── mcp/
  │   │   ├── cozeClient.ts
  │   │   └── types.ts
  │   ├── schema/
  │   │   ├── workflowSchema.ts
  │   │   └── nodeTemplates.ts
  │   ├── validator/
  │   │   └── validateWorkflow.ts
  │   └── utils/
  │       └── json.ts
  └── docs/
      └── mvp-notes.md
```

如果你偏 Python，也可以换成：

```text
agent_coze_workflow/
  ├── agent/
  ├── mcp/
  ├── schema/
  ├── validator/
  └── docs/
```

---

## 9. MVP 验收标准

### 功能验收
1. 输入一个需求，能生成结构化工作流草图
2. 能输出可解析的 Coze JSON
3. 能调 `create`
4. 能调 `save`
5. 能调 `test_run`
6. 能返回 workflow_id / execute_id

### 稳定性验收
1. JSON 不乱格式化
2. 节点 ID 不重复
3. 明显非法结构能在本地被拦住
4. 生成结果可复现

---

## 10. 当前最需要补的能力

做 MVP 前，建议先把下面几件事补齐：

1. **工作流详情读取接口**（未来做编辑/修复必须要）
2. **test_run 结果查询 / 日志接口**（未来自动修复必须要）
3. **节点模板字典**（提高生成稳定性）
4. **错误样例**（用于修复逻辑和规则沉淀）

---

## 11. AI Agent 学习点沉淀

你做这个 MVP，本身就是一套很好的 AI Agent 学习路径。

### 会学到的核心知识
- 需求结构化
- 任务规划
- 工具调用（Tool Use / MCP）
- 结构化输出
- Prompt 分层设计
- 规则 + 模型协作
- 本地校验与工程兜底

### 做完后能回答的面试问题
- 为什么不能直接让 LLM 一次吐完整 JSON？
- 如何保证输出可执行？
- 如何设计 tool boundary？
- 什么是“最小 patch”策略？
- 为什么要先草图后落地？
- 如何处理平台 schema 不稳定？

---

## 12. 面试重点考点预埋

这个项目天然适合面试讲以下点：

### 12.1 Agent 设计
- 规划器 / 生成器 / 校验器 / 执行器的分层
- 为什么要把复杂任务拆成多阶段

### 12.2 Prompt Engineering
- 系统 prompt、任务 prompt、输出约束 prompt 的分工
- 如何减少 hallucination 和 JSON 结构漂移

### 12.3 Tool Use / MCP
- 为什么要把外部平台能力封成工具
- 工具入参/出参如何设计
- 为什么要做统一错误处理

### 12.4 可靠性设计
- 本地 validator 的意义
- 为什么要先草图后 JSON
- 为什么自动修复前要有日志读取

### 12.5 工程落地
- API 逆向与接口封装
- workflow schema 模板化
- 失败与回滚策略

---

## 13. 最后建议

### 现在就做什么
1. 先把项目骨架搭起来
2. 先实现需求解析 + 草图生成
3. 再实现 Coze JSON 输出
4. 再封 MCP 的 create/save/test_run
5. 最后串起最小闭环

### 暂时不要做什么
- 不要先做自动修复
- 不要先做完整日志归因
- 不要先做全节点覆盖
- 不要先追求完美 schema 兼容

> 先跑通，再变强。先做 MVP，再谈自愈。