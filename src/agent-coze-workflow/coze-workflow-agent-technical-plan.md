# Coze 工作流自动生成与修复 Agent 技术方案

> 目标：基于用户自然语言需求，自动生成 Coze 工作流节点 JSON，通过内部 MCP 调用企业自建 Coze 平台完成创建、保存、试运行，并支持已有工作流的编辑与修复。
>
> 适用场景：企业内部 Coze 平台（私有化/改版），当前已确认可通过浏览器网络请求直接调用 `create`、`save`、`test_run` 三个接口。

---

## 1. 背景与目标

这个项目不是做一个普通聊天机器人，而是做一个**工程型 agent**：

- 输入：用户的业务需求、流程描述、已有工作流 JSON
- 输出：可导入/可保存的 Coze 工作流 schema
- 执行：通过 MCP 调用内部 Coze 接口创建、保存、试运行
- 闭环：根据试运行结果自动修复，直到成功或达到重试上限

### 最终能力

1. **新建工作流**
   - 用户说一句需求，agent 自动生成工作流模板
   - 自动创建工作流并保存节点 JSON
   - 自动试运行验证

2. **修改已有工作流**
   - 用户给出 workflow_id 或现有 schema
   - agent 拉取当前配置，做局部 patch
   - 保存后试运行

3. **自动修复**
   - 试运行失败后，agent 根据错误定位问题节点
   - 做最小修改 patch
   - 再次保存并试运行

---

## 2. 已确认的 Coze 接口（2026-08-12 实测，私有部署 coze.dev1.dachensky.com）

> **认证**：只认 cookie `session_key`（PAT 调 /api 接口会报 `missing session_key in cookie`）；cookie 为短期凭证，需定期更新。
>
> **完整保存链路（关键！）**：`create → edit_lock(acquire) → canvas → save（循环）→ test_run`。没有 edit_lock 直接 save 会报 `777777759 当前工作流已经不是最新副本`。

### 2.0 编辑锁（首次保存必需，用户发现）

`POST /api/workflow_api/edit_lock`

```json
{ "workflow_id": "7672840315094433792", "space_id": "7560621359533916160", "action": "acquire" }
```

返回：`{ "config_ttl": 900, "remaining_ttl": 900 }`（编辑锁 15 分钟）

- 作用：建立可编辑会话，让后续 save 接受（绕过“不是最新副本”）
- 锁内可多次保存；TTL 过期后需重新 acquire

### 2.1 创建工作流

`POST /api/workflow_api/create`

```json
{
  "name": "auto_flow",
  "desc": "全自动闭环",
  "icon_uri": "",
  "space_id": "7560621359533916160",
  "flow_mode": 2
}
```

要点：`space_id` 必须为**字符串**；`flow_mode` 必须为**数字 2**（WorkflowMode）；`icon_uri` 必填（可空串）。

返回：`data.workflow_id`（name 为空是正常的，内容靠 save 提交）

### 2.2 读取画布（每次保存前必调）

`POST /api/workflow_api/canvas`

```json
{ "workflow_id": "7672840315094433792", "space_id": "7560621359533916160" }
```

返回：`workflow.schema_json`（平台节点格式字符串）+ `vcs_data.submit_commit_id` / `draft_commit_id`

**核心机制**：每次 save 成功都会推进 commit，所以**每次 save 前必须重新 canvas 拿最新 submit_commit_id**，否则报 777777759。

### 2.3 保存工作流

`POST /api/workflow_api/save`

```json
{
  "workflow_id": "7672840315094433792",
  "schema": "{...平台节点格式 JSON 字符串...}",
  "space_id": "7560621359533916160",
  "submit_commit_id": "7672840315136376832",
  "ignore_status_transfer": true
}
```

返回 `code: 0` 即成功（`data.remaining_ttl` 为锁剩余时间）。

### 2.4 试运行工作流

`POST /api/workflow_api/test_run`

```json
{ "workflow_id": "7672840315094433792", "input": { "input": "hello" }, "space_id": "7560621359533916160" }
```

返回 `data.execute_id`（`commit_id` 不是必填）。若返回业务错误（如 `database info is required` / `BlockID is empty`），说明工作流节点配置不完整，而非接口问题。

### 2.5 其他已实测接口

| 接口 | 用途 | 关键参数 |
|---|---|---|
| `update_meta` | 改名称/描述（不碰 schema） | `{workflow_id, space_id, name, desc, icon_uri}`；name 只允许字母数字下划线且字母开头 |
| `workflow_list` | 工作流列表 | `{space_id, page, size}` |
| `workflow_detail` | 工作流详情 | `{workflow_ids: []}` |
| `node_template_list` | 节点模板 | `{need_types: []}` |
| `workflow_references` | 引用信息 | `{workflow_id, space_id}` |

### 2.6 平台节点 Schema 格式（与项目 workflow-schema 包格式不同！）

平台内部格式（我们生成器要输出的目标格式）：

```json
{
  "nodes": [
    {
      "id": "100001",
      "type": "1",
      "meta": { "position": { "x": 0, "y": 0 } },
      "data": {
        "nodeMeta": { "title": "开始", "icon": "...", "description": "...", "mainColor": "...", "subTitle": "" },
        "outputs": [{ "type": "string", "name": "input", "required": false }],
        "trigger_parameters": []
      }
    }
  ],
  "edges": [{ "sourceNodeID": "100001", "targetNodeID": "900001" }],
  "versions": { "loop": "v2" }
}
```

- 节点 `id` / `type` 都是**字符串数字**：1=start、2=end、43=查询数据、1300=企业定制“生成人工任务”
- 数据流靠 `data.inputs` 里的引用：`{ "type": "ref", "content": { "source": "block-output", "blockID": "100001", "name": "input" } }`（blockID 指向上游节点；edges 只是展示）
- 节点 ID 惯例：start=100001、end=900001
- `_temp.bounds` 是画布布局，丢了会导致粘贴不连线（你踩过的坑）
- 参考样本：`docs/coze-platform/coze-clipboard-node-sample.json`

---

## 3. 总体架构设计

建议采用 **“规划器 + 生成器 + 校验器 + MCP 执行器 + 修复器”** 的五段式架构。

```text
用户需求
   ↓
需求解析器
   ↓
工作流规划器
   ↓
Coze JSON 生成器
   ↓
结构校验器 / 静态规则校验
   ↓
MCP 执行器（create / save / test_run）
   ↓
试运行结果分析
   ↓
修复器（必要时循环）
```

### 3.1 各模块职责

#### A. 需求解析器
把自然语言需求转成结构化任务。

输出建议包含：

- 目标类型：新建 / 修改 / 修复
- 输入数据源
- 输出目标
- 节点类型列表
- 是否需要条件分支
- 是否需要代码节点
- 是否需要外部工具节点
- 是否需要数据库 / HTTP / MCP 工具
- 预期运行输入

#### B. 工作流规划器
把需求转成**工作流草图**，不是直接生成 JSON。

建议输出：

- 节点列表
- 节点顺序
- 节点之间的数据流
- 分支逻辑
- 失败回退策略

#### C. Coze JSON 生成器
把草图转成 Coze 节点 JSON。

这一层必须受 schema 约束，不能让 LLM 自由发挥。

#### D. 结构校验器
在调用 Coze save 之前先做本地校验：

- JSON 能否解析
- 节点是否缺字段
- 边是否能连通
- 起始节点与结束节点是否存在
- 端口/分支规则是否正确
- 是否违反已知平台约束

#### E. MCP 执行器
封装内部 Coze 接口：

- create
- save
- test_run

#### F. 修复器
读取错误信息，结合原始 schema 做最小 patch。

---

## 4. 工作流生成策略

这里最关键：**不要让 LLM 直接一次性吐出“可执行最终 JSON”**。

推荐使用三层输出：

### 第 1 层：需求摘要
LLM 先输出结构化需求理解，例如：

```json
{
  "goal": "自动生成工作流",
  "mode": "create",
  "inputs": ["需求文本"],
  "outputs": ["Coze 工作流 JSON"],
  "constraints": ["尽量使用最少节点", "优先可运行", "必要时可编辑"]
}
```

### 第 2 层：工作流草图
例如：

```json
{
  "nodes": [
    {"id": "start", "type": "start", "purpose": "接收输入"},
    {"id": "llm_1", "type": "llm", "purpose": "提取关键信息"},
    {"id": "code_1", "type": "code", "purpose": "格式化结构化输出"},
    {"id": "end", "type": "end", "purpose": "返回结果"}
  ],
  "edges": [
    {"from": "start", "to": "llm_1"},
    {"from": "llm_1", "to": "code_1"},
    {"from": "code_1", "to": "end"}
  ]
}
```

### 第 3 层：Coze 节点 JSON
最后把草图转换成平台 schema。

这样做的好处是：

- 先规划，减少胡乱生成
- 先抽象，再落到平台字段
- 出错时更容易定位是“规划错”还是“字段错”

---

## 5. Prompt 设计方案

Prompt 建议分为 **系统提示词**、**任务提示词**、**输出约束提示词**、**修复提示词** 四层。

### 5.1 系统提示词
系统提示词要定义 agent 的身份和边界：

- 你是 Coze 工作流工程助手
- 目标是把用户需求转换为可执行工作流
- 必须优先考虑可运行性和最小修改原则
- 不能编造平台不存在的节点字段
- 所有输出必须符合指定 JSON schema

示例：

```text
你是一个企业内部 Coze 工作流工程 agent。
你的任务是：根据用户需求，规划、生成、修复 Coze 工作流。
你必须遵守以下原则：
1. 优先保证可执行性，不追求花哨。
2. 输出必须是严格可解析的 JSON。
3. 不允许编造平台未知字段。
4. 生成工作流时先规划再输出最终 schema。
5. 修复时只做最小 patch，避免破坏已有结构。
```

### 5.2 任务提示词
根据不同模式分三类：

#### A. 新建工作流
输入：需求文本
目标：生成可保存的工作流 JSON

#### B. 修改工作流
输入：现有 workflow JSON + 修改要求
目标：返回最小 patch 或更新后的完整 JSON

#### C. 修复工作流
输入：失败日志 + 当前 JSON
目标：定位报错节点并修复

### 5.3 输出约束提示词
这里非常重要，必须强制模型按结构输出。

建议要求：

- 只输出 JSON，不要夹带解释
- 字段名必须精确
- 所有字符串使用双引号
- 节点 ID 必须唯一
- 边必须引用真实存在的节点 ID
- 起始节点必须唯一
- 结束节点必须唯一
- 代码节点出边不要乱加端口字段

### 5.4 修复提示词
修复提示词必须喂入：

- 原始 schema
- 报错信息
- 出错节点上下文
- 平台规则

并要求模型：

- 只修复相关部分
- 不要重写整张图
- 如果信息不足，先输出缺失信息清单

---

## 6. Coze 节点 JSON 生成建议

### 6.1 分阶段生成，不要一步到位
建议采用：

1. **生成节点清单**
2. **生成边清单**
3. **生成节点详细配置**
4. **组装成最终 schema**
5. **本地校验**
6. **调用 save**

这样做比一步生成完整 JSON 更稳。

### 6.2 节点模板化
对于常见节点，建议先做模板库。

例如：

- start
- end
- llm
- code
- branch/condition
- database query
- http request
- MCP tool node（如果平台支持）

每个模板固定：

- 输入字段
- 输出字段
- 连接规则
- 默认值

### 6.3 结构化输出建议
模型如果要输出最终 JSON，建议使用一个固定 schema：

```json
{
  "workflow_meta": {},
  "nodes": [],
  "edges": [],
  "versions": {},
  "meta_checks": {
    "is_valid": true,
    "warnings": []
  }
}
```

然后再由程序转换为 Coze 需要的最终格式。

---

## 7. MCP 调用链设计

### 7.1 新建工作流流程

```text
用户输入需求
  → LLM 生成草图
  → 本地校验
  → MCP create_workflow
  → MCP save_workflow
  → MCP test_run_workflow
  → 如果失败，进入修复循环
```

### 7.2 修改已有工作流流程

```text
用户给 workflow_id / schema
  → MCP get_workflow（或等价读取接口）
  → LLM 分析修改点
  → 生成 patch
  → 本地校验
  → MCP save_workflow
  → MCP test_run_workflow
```

### 7.3 自动修复流程

```text
test_run 失败
  → 读取错误信息
  → 识别失败节点
  → LLM 生成最小 patch
  → 重新 save
  → 再 test_run
```

### 7.4 MCP 工具建议

#### create_workflow
输入：

- name
- desc
- icon_uri
- space_id
- flow_mode

输出：

- workflow_id
- status
- url

#### save_workflow
输入：

- workflow_id
- schema
- space_id
- submit_commit_id
- ignore_status_transfer

输出：

- status
- workflow_status
- remaining_ttl

#### test_run_workflow
输入：

- workflow_id
- input
- space_id
- commit_id

输出：

- execute_id
- session_id

> 后续必须补一个 result/log 查询工具，否则无法真正闭环。

---

## 8. 当前可行性判断

### 8.1 已经可行的部分

基于目前已掌握的接口，这个 MVP 已经可以实现：

- 生成工作流
- 保存工作流
- 试运行工作流

也就是说：**“生成 + 落库 + 验证”** 已具备。

### 8.2 还缺的关键能力

要做成“修复型 agent”，还缺：

1. **工作流读取接口**
   - 用于编辑已有工作流

2. **试运行结果查询接口**
   - 用于获取执行状态和日志

3. **失败样例**
   - 用于训练修复逻辑

4. **节点模板字典**
   - 用于提高生成稳定性

### 8.3 可行性结论

- **做 MVP：高可行**
- **做自动修复闭环：可行，但需要补读和日志接口**
- **做成稳定工程工具：可行，但要模板化 + 规则化 + 版本管理**

---

## 9. 风险与对策

### 风险 1：LLM 直接生成 JSON 不稳定

**对策**：

- 先生成草图，再组装 JSON
- 强制结构化输出
- 加本地校验

### 风险 2：Coze schema 很多细节不透明

**对策**：

- 先沉淀模板库
- 从最常见节点开始
- 每发现一个坑就补规则

### 风险 3：试运行失败后不知道怎么修

**对策**：

- 补试运行日志查询接口
- 失败时先做规则定位，再让 LLM 参与修复

### 风险 4：整图覆盖导致误伤

**对策**：

- 修复时只做最小 patch
- 保留历史版本
- 支持回滚

---

## 10. 建议的 MVP 路线

### Phase 1：先跑通最小闭环

目标：

- 用户输入需求
- 生成一个最小工作流 JSON
- 调 `create` / `save` / `test_run`

### Phase 2：补充读取能力

目标：

- 支持编辑已有工作流
- 支持局部 patch

### Phase 3：补充修复能力

目标：

- 试运行失败后自动分析错误
- 自动修复并重试

### Phase 4：模板库与评估

目标：

- 形成常见节点模板
- 评估生成成功率和修复成功率

---

## 11. 这个项目的面试价值

这个项目很适合 AI Agent 面试，因为它覆盖的知识点非常完整：

- 需求结构化
- Prompt 设计
- JSON 结构化输出
- Tool use / Function calling / MCP
- 工作流规划
- 试运行闭环
- 错误分析与修复
- 最小 patch 策略
- 工程化与可靠性

### 面试可重点讲的能力

1. 为什么要先规划再输出 JSON
2. 怎么保证生成结果可执行
3. 怎么处理平台 schema 的不确定性
4. 怎么做自动修复闭环
5. 怎么设计 MCP 工具边界
6. 怎么避免整图重写造成误伤

---

## 12. 当前最需要补充的支持

如果要尽快落地，建议继续补以下材料：

1. **工作流详情读取接口**
2. **试运行结果 / 日志查询接口**
3. **失败案例**（save 失败、test_run 失败）
4. **更多节点类型模板**
5. **字段语义说明**（status、workflow_status、remaining_ttl、commit_id 等）

---

## 13. 推荐实现顺序

1. 先写 MCP server 外壳
2. 再封装 create / save / test_run
3. 再做 LLM 需求解析与草图生成
4. 再做 Coze JSON 组装
5. 再补校验器
6. 最后做修复循环

---

## 14. 最终建议

这个项目不要一上来就追求“全自动完美生成”。

正确姿势是：

- **先模板化**
- **再结构化**
- **再试运行**
- **再修复**
- **最后才是全自动**

这样才是真正能上线、能讲给面试官听的 AI Agent 工程方案。
