# Coze 工作流自动生成 Agent - MVP 开发清单 & 面试考点

> 作用：配合 `coze-workflow-agent-mvp-plan.md` 使用。
>
> 目标：把 MVP 拆成你能自己动手做的任务，同时把每一步能学到的 AI Agent 知识点和面试考点一起沉淀下来。

---

## 1. MVP 开发分工建议

这版建议采用“你做实现，我做架梯子 + 审核 + 补知识点”的方式。

### 你负责
- 搭项目骨架
- 接 MCP 接口
- 写基础的 prompt
- 实现 JSON 结构校验
- 串起 create → save → test_run

### 我负责
- 帮你拆任务
- 帮你设计 prompt
- 帮你 review JSON schema
- 帮你整理 AI Agent 学习点
- 帮你准备面试答法

---

## 2. MVP 开发总路线

### Phase 0：先定技术栈

#### 推荐选择 A：TypeScript
适合你如果：
- 前端/Node 更熟
- 想和 Web/MCP 接得更自然
- 以后可能要做 UI

#### 推荐选择 B：Python
适合你如果：
- 想最快把 agent 逻辑跑通
- 更看重实验速度
- 后面主要是脚本/服务端工具

### 我的建议
- **如果目标是尽快出 MVP：Python 优先**
- **如果目标是后续和前端/平台融合：TypeScript 更顺**

---

## 3. MVP 任务拆解

### Task 1：项目初始化

#### 目标
先搭出最小目录结构和运行入口。

#### 交付物
- 一个能启动的项目
- 一个最简单的 CLI 或 API 入口
- 一个 `.env` 配置文件

#### 学习点
- Agent 工具项目如何分层
- 项目入口如何承载 tool use / workflow orchestration

#### 面试考点
- 你怎么设计一个 agent 项目骨架？
- 为什么要把 agent、schema、validator、mcp 分目录？

---

### Task 2：需求解析器

#### 目标
把自然语言需求转成结构化字段。

#### 建议输出
```json
{
  "mode": "create",
  "goal": "...",
  "inputType": "text",
  "outputType": "workflow_json",
  "needBranch": false,
  "needCodeNode": true,
  "needDatabaseNode": false,
  "constraints": ["..."],
  "riskHints": ["..."]
}
```

#### 学习点
- 需求结构化
- 任务分解
- 信息抽取与约束识别

#### 面试考点
- 为什么 agent 第一步不能直接生成 JSON？
- 为什么要先做结构化需求理解？

---

### Task 3：工作流草图生成器

#### 目标
先输出 nodes / edges 草图，不直接输出最终 Coze schema。

#### 建议输出
```json
{
  "nodes": [
    {"id": "start", "type": "start", "purpose": "接收输入"},
    {"id": "llm_1", "type": "llm", "purpose": "分析需求"},
    {"id": "end", "type": "end", "purpose": "返回结果"}
  ],
  "edges": [
    {"from": "start", "to": "llm_1"},
    {"from": "llm_1", "to": "end"}
  ]
}
```

#### 学习点
- Planner / Executor 分层
- 先规划后执行
- 复杂任务拆解成图结构

#### 面试考点
- 为什么要先生成草图？
- 规划器和生成器的职责边界是什么？

---

### Task 4：Coze JSON 生成器

#### 目标
把草图转成 Coze 可保存的节点 JSON。

#### MVP 约束
- 节点 ID 唯一
- start/end 节点必须存在
- 边只能连到存在的节点
- 代码节点不要乱加非法端口字段
- 节点输出类型必须和声明一致

#### 学习点
- 结构化输出
- Schema 驱动生成
- LLM 生成结果约束

#### 面试考点
- 如何防止 LLM 输出的 JSON 不合法？
- 为什么必须加本地校验，而不能全信模型？

---

### Task 5：本地校验器

#### 目标
在调用 Coze save 之前，先把明显错误挡住。

#### 校验项
- JSON 是否能 parse
- 节点是否重复
- 起止节点是否齐全
- 边是否引用了不存在的节点
- 代码节点是否带了非法端口字段
- 输出字段类型是否一致

#### 学习点
- Rule-based guardrail
- LLM + programmatic validation 结合
- 工程兜底

#### 面试考点
- 为什么要做本地校验？
- 本地校验和模型约束输出分别负责什么？

---

### Task 6：MCP 客户端

#### 目标
封装内部 Coze 接口。

#### MVP 工具
- `create_workflow`
- `save_workflow`
- `test_run_workflow`

#### 学习点
- Tool use / function calling
- 外部系统能力封装
- agent 如何调用真实世界动作

#### 面试考点
- 什么是 MCP / tool use？
- 为什么要把 Coze 接口封装成工具？

---

### Task 7：主流程编排

#### 目标
把需求解析、草图、JSON、校验、MCP 调用串起来。

#### 流程
```text
需求输入
→ 需求解析
→ 草图规划
→ JSON 生成
→ 本地校验
→ create
→ save
→ test_run
→ 返回结果
```

#### 学习点
- agent orchestration
- 状态流转
- pipeline design

#### 面试考点
- 为什么要分步执行而不是单轮生成？
- 你怎么设计一个 agent 的执行链？

---

### Task 8：结果包装与错误提示

#### 目标
把 Coze/MCP 的返回包装成用户能理解的结果。

#### 输出建议
- workflow_id
- create 是否成功
- save 是否成功
- test_run 是否成功
- 失败阶段
- 失败原因（简化版）

#### 学习点
- 错误信息分层
- 用户可理解的反馈设计

#### 面试考点
- 为什么 agent 的错误反馈不能直接照搬底层错误？
- 如何把工程错误翻译成用户能懂的话？

---

## 4. MVP 的最小 prompt 模板

### 4.1 需求解析 Prompt

```text
你是 Coze 工作流需求分析器。
请把用户输入的需求转成结构化 JSON。
要求：只输出 JSON，不要解释。
字段包括：mode、goal、inputType、outputType、needBranch、needCodeNode、needDatabaseNode、constraints、riskHints。
```

### 4.2 草图生成 Prompt

```text
你是 Coze 工作流规划器。
根据结构化需求，输出工作流草图。
要求：只输出 JSON，包含 nodes 和 edges。
不要输出最终 Coze schema。
```

### 4.3 Coze JSON 生成 Prompt

```text
你是 Coze 工作流 JSON 生成器。
根据工作流草图，输出可保存的 Coze 节点 JSON。
要求：
1. 只输出 JSON。
2. 节点 ID 唯一。
3. 边必须连接真实存在的节点。
4. 代码节点不得添加非法端口字段。
5. 输出字段类型必须与节点声明一致。
```

### 4.4 轻量修复 Prompt（后续扩展）

```text
你是 Coze 工作流修复器。
根据原始 schema 和错误信息，只输出最小修改 patch。
不要重写整张工作流图。
```

---

## 5. MVP 里一定要保留的工程原则

### 原则 1：先草图，后 JSON
这是防止模型直接乱写 schema 的第一道墙。

### 原则 2：先规则校验，再发请求
不要把明显错误直接发给 Coze。

### 原则 3：最小闭环优先
先让 create/save/test_run 能跑通，再扩展。

### 原则 4：模板化优先
先支持少量常见节点，再扩展到全量节点。

### 原则 5：错误分层
底层错误先保留给开发者，上层给用户简化说明。

---

## 6. 目前最适合你来做的部分

你可以先做以下 3 块，这三块最适合学习 AI Agent：

### 第一块：需求解析器
学的是：
- 信息抽取
- 任务分解
- 结构化输出

### 第二块：草图生成器
学的是：
- Planner 思维
- 任务图建模
- 先规划后执行

### 第三块：本地校验器
学的是：
- 规则 + 模型协作
- 工程兜底
- Agent 可靠性设计

这三块做完，你会对 AI Agent 的骨架有非常真实的理解。

---

## 7. 这个项目的面试考点清单

### 7.1 Agent 基础
- 什么是 agent？
- 和普通 LLM 有什么区别？
- 为什么 agent 需要工具调用？
- 为什么 agent 需要 planning？

### 7.2 Prompt Engineering
- 系统 prompt / 任务 prompt / 约束 prompt 的区别
- 怎么减少 JSON 幻觉
- 怎么让模型稳定输出结构化内容

### 7.3 Tool Use / MCP
- 什么是 tool use？
- 为什么要封装 Coze 接口成工具？
- 工具的边界怎么定？

### 7.4 Workflow / Orchestration
- 为什么要先生成草图？
- 为什么要分层处理？
- 复杂任务如何拆成多个子步骤？

### 7.5 可靠性与工程化
- 为什么要本地校验？
- 为什么不能直接相信模型输出？
- 为什么自动修复一定要有日志/读取接口？

### 7.6 产品化思维
- 为什么先做 MVP 而不是一次性做全功能？
- 如何定义“可用”而不是“看起来很强”？

---

## 8. MVP 后续扩展路线

### Phase 2：读取与编辑
补：
- workflow detail / get
- execution logs / result

### Phase 3：自动修复
补：
- 失败分析
- 最小 patch
- 再运行

### Phase 4：模板库
补：
- 常见节点模板
- 常见错误模板
- 修复规则库

---

## 9. 你做完 MVP 后，面试怎么讲

建议按这个顺序讲：

1. 我先做了需求结构化
2. 再做工作流规划
3. 再把草图映射到 Coze schema
4. 再封装 MCP 调用平台接口
5. 再做本地校验兜底
6. 最后把生成、保存、试跑串成闭环

### 这套讲法的好处
- 有工程分层
- 有 AI Agent 思维
- 有 tool use 实战
- 有可靠性意识
- 不像“只会 prompt 调 API”

---

## 10. 当前建议的下一步

### 你先做
1. 项目骨架
2. 需求解析器
3. 草图生成器
4. 本地校验器

### 我继续帮你
1. 审 prompt
2. 评 schema
3. 提炼面试考点
4. 帮你拆异常场景

---

## 11. 结论

这个 MVP 非常适合你现在学习 AI Agent：

- 它足够真实
- 它有工程闭环
- 它能暴露 agent 的核心能力
- 它能直接沉淀成面试素材

**先把“生成 + 保存 + 试跑”跑通，已经很有价值。**

