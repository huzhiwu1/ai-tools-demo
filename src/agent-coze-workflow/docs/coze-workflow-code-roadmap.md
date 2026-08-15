# Coze 工作流 Agent 项目 · 深度阅读手册（2026-08-15 补充版）

> 本文是对飞书《AI Agent 知识点手册 · 08-13 · Coze 工作流 Agent 项目代码阅读地图》的补充。
> 目标：让你能**一个文件一个文件**读完全项目，读完就懂"这个项目是什么、怎么跑起来、每行代码在干嘛、踩过哪些坑、接下来往哪走"。
> 阅读方式：按章节顺序读，每节先读"看什么"，再打开对应文件。全部读完约 2-3 小时。

---

## 目录

1. 项目上下文（先建立全局感）
2. 架构总览（四层 + 双链路 + 设计哲学）
3. 逐文件代码地图（核心章节）
4. 端到端数据流（一次完整对话发生了什么）
5. 功能清单（已实现 / 未实现）
6. 坑清单（血泪史分类速查）
7. 代码 Roadmap（演进历史 + 下一步）
8. 学习要点 / 面试考点

---

## 一、项目上下文

### 1.1 一句话定位

用户输入自然语言需求（如"判断音频是否是训练营歌曲"），AI Agent 自主完成 **需求澄清 → 工作流规划 → 节点生成 → 部署到私有 Coze 平台 → 试运行验证 → 归因迭代修复**，全程可对话、可追问。这是"用 AI 构建 AI 工作流"的自动化系统。

### 1.2 为什么做这个项目

- 公司有私有 Coze 平台（coze.dev1.dachensky.com），平时搭工作流要靠人肉拖节点、配参数，低效。
- 想验证：能不能让 LLM 直接"听懂需求 → 生成平台可运行的工作流 JSON → 自动部署验证"。
- 同时也是学习 AI Agent 开发的实战项目（LangGraph ReAct、工具调用、interrupt/resume、SSE 流式）。

### 1.3 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 后端 | NestJS 11 + Express | 之前是 Express + tsx，已迁移 |
| Agent 编排 | LangChain + LangGraph（createReactAgent） | 新链路核心 |
| LLM | DeepSeek（deepseek-chat / deepseek-v4-flash） | 官方 API，OpenAI 兼容协议 |
| 前端 | React 18 + Vite + Vercel AI SDK（useChat） | 对话界面 |
| 包管理 | pnpm workspaces + Turborepo | monorepo |
| 校验 | Zod 4 | LLM 结构化输出 schema |
| 表格解析 | SheetJS（xlsx） | read_file 工具用 |
| 平台 | 私有 Coze（coze.dev1.dachensky.com） | Cookie session_key 认证 |

### 1.4 代码规模

- 全项目 TS/TSX 源码约 **1.08 万行**（含前端、共享包）。
- 后端最大文件：schema-converter.ts（797 行）、react-agent.service.ts（644 行）、generator.ts（682 行）、coze.client.ts（483 行）。
- git 仓库：ai-tools-demo 主仓库的 main 分支（不是独立仓库），约 30+ 个相关 commit。

### 1.5 项目演进简史（git log 提炼）

```
2026-08-11 立项：README/技术方案/mvp-plan，Express + 预留骨架
2026-08-12 迁移 NestJS；CozeClient 接入真实平台；schema-converter 落地
2026-08-12 晚 节点结构排雷：对照平台真实样本修 llm/http/text/start 节点结构
2026-08-13 新链路 Sprint A：createReactAgent + 10 工具 + interrupt/resume + SSE
2026-08-13 晚 Sprint B：batch_validate / update_workflow 验证迭代闭环 + 迭代上限
2026-08-14 节点结构大修：对照 coze-studio 源码 + 平台样本，补全 14 项 llmParam、
          http 节点结构、text concatParams、validate_tree 保存前校验、deleteWorkflow
2026-08-14 晚 planner 两段式改造：骨架 + 逐节点 config，解决 max_tokens 截断
2026-08-15 分步生成 + 关思考 + contracts 留骨架（进行中）；前端 Sprint C 排队
```

### 1.6 当前状态（2026-08-15）

- 全链路已通：需求 → 对话 → 规划 → 生成 → 保存 → 试运行 → 批量验证 → 迭代修复。
- 正在做：planner 分步生成收尾、前端 Sprint C（Vercel AI SDK 改造 + 文件上传）。
- 未做：答案表解析闭环（Sprint B 的一部分）、多轮持久化（MemorySaver 是内存态）、并发试运行。

---

## 二、架构总览

### 2.1 Monorepo 结构

```
agent-coze-workflow/
├── apps/
│   ├── api/                  # NestJS 后端（核心）
│   │   └── src/
│   │       ├── main.ts           # 启动入口（dotenv + NestFactory）
│   │       ├── app.module.ts     # 根模块（导入 3 个子模块）
│   │       ├── agent/            # 🆕 新链路：ReAct Agent
│   │       │   ├── react-agent.controller.ts  # SSE 接口
│   │       │   ├── react-agent.service.ts     # ⭐ ReAct 大脑（644 行）
│   │       │   ├── react-agent.module.ts
│   │       │   ├── session.store.ts            # 会话存储（graph + messages）
│   │       │   ├── upload-store.ts             # 上传文件登记
│   │       │   └── tools/                      # 10 个工具
│   │       ├── coze/             # 平台接入层
│   │       │   ├── coze.client.ts       # ⭐ 平台 API 客户端（483 行）
│   │       │   ├── schema-converter.ts  # ⭐ 项目格式 → 平台格式（797 行）
│   │       │   ├── mcp-server.ts        # MCP 协议包装（可选通道）
│   │       │   ├── types.ts             # Coze API 响应类型
│   │       │   └── coze.module.ts
│   │       ├── legacy/           # 旧链路（保留，教学/调试）
│   │       │   ├── graph.ts             # StateGraph 固定流水线
│   │       │   ├── workflow.service.ts  # REST 业务服务（带 mock 降级）
│   │       │   ├── workflow.controller.ts
│   │       │   ├── workflow.module.ts
│   │       │   └── workflow-repairer.ts # 规则修复 + LLM 兜底
│   │       ├── llm/
│   │       │   └── deepseek.client.ts   # ⭐ LLM 封装（withStructuredOutput）
│   │       ├── workflow-engine/    # 确定性生成（LLM 只做语义决策）
│   │       │   ├── planner.ts           # ⭐ 两段式规划（骨架 → 逐节点 config）
│   │       │   ├── generator.ts         # ⭐ 节点组装（拓扑排序 + 自动接线）
│   │       │   ├── types.ts             # zod schema（LLM 输出契约）
│   │       │   ├── code-generator.ts    # 代码节点 Python 代码生成
│   │       │   └── platform-validator.ts# 平台兼容性校验
│   │       ├── prompts/           # 提示词集中管理
│   │       │   ├── plan-prompt.ts       # 骨架 prompt + 节点 config prompt
│   │       │   └── repair-prompt.ts
│   │       ├── schema/            # ⚠️ 空壳 TODO（早期预留，未使用）
│   │       └── validator/         # ⚠️ 空壳 TODO（早期预留，未使用）
│   └── web/                   # React 前端
│       └── src/
│           ├── App.tsx             # ⭐ 对话界面主组件（586 行）
│           ├── api/data-stream.ts  # ⭐ Data Stream 协议解析/转换
│           ├── api/workflow.ts     # 保存工作流 API
│           └── components/         # Header / ChatInput / ChatMessageList /
│                                   # ToolCallPanel / WorkflowCanvas / JsonPreview
├── packages/
│   ├── shared/               # 跨模块类型（WorkflowPlan/PlanStep/校验结果...）
│   └── workflow-schema/      # 节点类型/工厂/本地校验（前后端共享数据契约）
│       └── src/
│           ├── types/        # CozeNode 联合类型（9 种节点）
│           ├── templates/    # createXxxNode 工厂
│           └── validator/    # validateWorkflow 本地校验
├── docs/                     # 大量文档（见 3.9）
├── scripts/                  # clean-tsbuildinfo.mjs / diagnose-coze-auth.ts
├── test-data/                # singing-testset.xlsx / song-lyrics.md（测试样本）
└── uploads/                  # 前端上传的文件（gitignore）
```

### 2.2 四层职责（从外到内）

| 层 | 目录 | 一句话职责 |
|---|---|---|
| 接口层 | agent/react-agent.controller.ts | HTTP + SSE 边界，参数校验，流式输出 |
| 核心层 | agent/react-agent.service.ts | ReAct 大脑：graph 生命周期、事件流、interrupt 检测 |
| 工具层 | agent/tools/ | 10 个 LangChain 工具，每个是薄封装 |
| 能力层 | coze/ + llm/ + workflow-engine/ + legacy/ | 平台 API、格式转换、确定性生成、LLM 封装 |

### 2.3 新旧两条链路

| 维度 | 旧链路（legacy/graph.ts） | 新链路（agent/react-agent.service.ts） |
|---|---|---|
| 编排方式 | StateGraph 固定流水线 plan→sketch→generate→validate→repair | createReactAgent ReAct 循环，LLM 自主决策 |
| 灵活性 | 低，加节点要改代码 | 高，加工具即可扩展 |
| 对话能力 | 无，一次性输入输出 | 多轮 + interrupt 澄清 + resume 恢复 |
| 状态 | 无持久化 | MemorySaver checkpointer 按 thread_id |
| 当前角色 | 保留（教学/调试 + 工具复用其能力） | 主链路（前端对话走这里） |

**为什么保留旧链路？** ① 教学对比（面试讲"为什么从 StateGraph 升级到 ReAct"）；② 旧链路里的 planner/generator/repairer 被新链路工具直接复用；③ /workflow/* REST 接口还挂在上面。

### 2.4 核心设计哲学（读懂这个就看懂一半）

**LLM 只做语义决策，代码做结构组装。**

- LLM 输出：用什么节点、怎么连、每个节点的数据契约（变量名/输入/输出/单批处理）、业务配置（prompt、逻辑描述、阈值）。
- 代码做：拓扑排序、inputMapping 自动接线、条件分支端口回填、代码节点 Python 代码生成、平台 schema 转换、双层校验。
- 理由：LLM 直接输出完整工作流 JSON 会幻觉、会截断、结构不可控；拆成"语义 + 结构"后，LLM 输出小（1-2K），结构由代码保证 100% 正确。

---

## 三、逐文件代码地图

> 按推荐阅读顺序。每个文件标注：**看什么** + 关键细节 + 注意点。

### 3.1 项目骨架（5 分钟）

| 文件 | 看什么 |
|---|---|
| package.json | postinstall 自动 turbo build（拉代码后 dist 不重建会报错）；scripts 一览 |
| turbo.json | dev/build/typecheck 的 dependsOn 关系 |
| pnpm-workspace.yaml | 只有两行：apps/* 和 packages/* |
| .env.example | 环境变量模板：LLM_*（网关）、DEEPSEEK_*（官方）、COZE_*（平台） |

**注意**：`.env` 不随 git 同步，每台机器单独配。COZE_SESSION_KEY 只填 cookie 里的 session_key（约 214 字符），不是完整 cookie（322 字符），填错认证必挂。

### 3.2 后端入口与模块装配（10 分钟）

**apps/api/src/main.ts**
- dotenv 从 `__dirname/../../../.env` 加载（dist 运行时层级不同，已兼容）。
- LOG_LEVEL=debug 时全量输出日志，否则只输出 log/warn/error。
- 端口 API_PORT，默认 3000。

**apps/api/src/app.module.ts**
- 导入三个模块：LegacyModule + CozeModule + ReactAgentModule。
- 三个模块职责分明：CozeModule 提供 CozeClient（DI），LegacyModule 挂旧链路，ReactAgentModule 挂新链路。

**apps/api/src/agent/react-agent.module.ts**
- ReactAgentService 无构造依赖，工具内部直接 new（模块级单例），不走 NestJS DI——设计选择：简单可靠。

**apps/api/src/coze/coze.module.ts**
- useFactory 从 process.env 创建 CozeClient 单例，导出供 LegacyModule 注入。

**apps/api/src/legacy/workflow.module.ts**
- useFactory 组装 DeepSeekClient → WorkflowPlanner → WorkflowGenerator → WorkflowRepairer → WORKFLOW_GRAPH（编译后的 StateGraph）。
- 注意：planner/generator 已拆到 workflow-engine/，被新链路工具直接 new，不走 DI。

### 3.3 新链路核心（ReAct Agent）—— ⭐ 重点

#### ① apps/api/src/agent/react-agent.controller.ts（接口层）

**看什么**：三个接口 + 两个防御性细节。

- `POST /api/agent/chat`：接收 { sessionId?, message }，转发给 service.handleChat。
- `POST /api/agent/chat/resume`：接收 { sessionId, answer, fileIds? }，转发 handleResume。
- `POST /api/agent/upload`：multipart 文件上传，存到 uploads/，返回 fileId。
- **坑1：文件名乱码**——busboy 默认按 latin1 解码 multipart 头，中文文件名乱码，`fixFilenameEncoding` 把 latin1 字节序列转回 UTF-8（转换结果含 U+FFFD 则保留原值）。
- **坑2：路径穿越**——只取 path.basename(文件名)，fileId 前缀重命名防重名覆盖。
- SSE 用 @Res() 手动写流（@Sse() 只支持 GET）。

#### ② apps/api/src/agent/react-agent.service.ts（核心中的核心，644 行）

**看什么**：整个项目信息密度最高的文件，三个必懂机制。

**机制 A：LLM 实例配置（模块级单例）**
- ChatOpenAI 内部有连接池，所有会话共享一个实例。
- 模型选择：LLM_*（网关）→ DEEPSEEK_*（官方）→ deepseek-chat。
- **maxTokens: 8192**：思考模型 reasoning 与正文共用 completion tokens，官网默认 4K 会把含工具参数调用的输出截断 → 工具参数解析失败 → 错误反馈 LLM 反复重试（观感死循环）。
- **timeout 60s + maxRetries 1**：默认 maxRetries=6 会把单次失败放大成 6 次静默重试，前端表现为长时间无事件一直转圈。

**机制 B：graph 生命周期**
- `createGraph()`：createReactAgent({ llm, tools, checkpointer: MemorySaver, prompt: SYSTEM_PROMPT, recursionLimit: 40 })。
- @langchain/langgraph ^1.4.9 的 createReactAgent 直接返回编译后的图，无需再 .compile()。
- **每个会话独立 graph + 独立 MemorySaver**：InMemorySaver 不支持跨实例恢复，不能全局共享。
- recursionLimit 40：默认 25 步，ReAct 循环含多次工具调用容易撞上限。

**机制 C：SSE 事件流（Data Stream 协议）**
- 协议：`0:"text"`（LLM 文本增量）/ `d:{json}`（结构化事件）/ `e:{json}`（结束标记），每行一个事件。
- on_chat_model_stream → 拆 reasoning_content（DeepSeek 思考）单独发 `d:reasoning_delta`，正文发 `0:`。
- on_tool_start / on_tool_end → 发 `d:tool_start` / `d:tool_end`。
- 流结束后 graph.getState(config) 检查 interrupt：state.tasks[].interrupts[].value（**不是** state.values.__interrupt__，实测坑）。
- 客户端断开处理：res.on("close") 立即打 graphDirty 标记（不能只靠 for await 里查 res.destroyed，LLM 思考期间事件迭代器阻塞）；下次 chat 时重建 graph 清脏 checkpoint。还有 `stream.cancel()` 防止被放弃的执行后台跑完触发未捕获异常崩溃服务。

**机制 D：工具输出提取（extractToolContent）**
- tool_end 的 output 是 ToolMessage 的 JSON 序列化（{ lc, type, kwargs: { content } }），要解析后取 kwargs.content，兼容三种形态（对象/JSON 字符串/普通字符串）。

**系统提示词（SYSTEM_PROMPT）**：10 个工具说明 + 使用规则 + 三条硬约束（迭代上限、save 规则、凭证问题不瞎改工作流）+ 文件与验证流程（read_file → clarify → plan → generate(带 referenceData) → save → batch_validate → update_workflow 迭代）。

#### ③ apps/api/src/agent/session.store.ts

- Map&lt;string, Session&gt; 内存存储，重启即清（可接受）。
- Session = { graph, messages, graphDirty?, createdAt }。
- 单例模式。graphDirty 是打断残留标记。

#### ④ apps/api/src/agent/upload-store.ts

- Map&lt;fileId, { path, name }&gt;，resume 时按 fileId 还原文件名与磁盘路径拼入消息文本，让 LLM 用 read_file 直接读。
- 热载会清空（内存态），可接受的演示行为。

### 3.4 工具层（10 个工具）

**apps/api/src/agent/tools/index.ts**
- ALL_TOOLS 数组，**顺序影响 LLM 选择偏好**（clarify 第一、read_file 第二）。
- withToolLog 包装：覆盖实例 invoke 方法统一埋入参/出参/耗时日志（不用改每个工具文件）。
- GraphInterrupt 记为 debug 而非 error（interrupt 是正常暂停不是失败）。

| 工具 | 文件 | 职责 | 关键细节 |
|---|---|---|---|
| clarify_question | clarify.tool.ts | 需求信息不完整时暂停问用户 | 内部调 interrupt({question, context})；resume 后返回 "用户回答: xxx" |
| read_file | read-file.tool.ts | 通用文件读取 | xlsx/xls/csv → 行列数据；md/txt/json → 全文；零业务假设；CSV 先按 UTF-8 读再解析（防 latin1 中文乱码 + BOM） |
| get_platform_facts | platform-facts.tool.ts | 平台事实查询 | listModels + listDatabases 实时 API；44 个节点类型静态数据；防止 LLM 臆造模型/数据源 |
| plan_workflow | plan.tool.ts | 需求 → WorkflowPlan | 模块级单例 planner |
| generate_workflow | generate.tool.ts | Plan → CozeWorkflow JSON | 返回 { workflow, validation }；referenceData 必须传（否则代码节点幻觉编数据） |
| save_to_coze | save.tool.ts | 部署到平台 | 结构校验 → 平台兼容校验 → 动态拉模型映射 → convert → create/update → validate_tree → save；名称冲突自动加 _2/_3/_4 后缀；**传 workflowId = 更新，不传 = 新建**；validate_tree 失败时首次创建删空壳 |
| test_run_workflow | test-run.tool.ts | 试运行 | 返回 executeId |
| batch_validate | batch-validate.tool.ts | 批量试运行对照期望 | 串行执行（防限流）；5s 轮询最多 5 分钟；executeStatus=2 完成 / 3 失败；返回 accuracy + details + failurePatterns（emptyOutput/mismatch/executionError 归因分组） |
| update_workflow | update-workflow.tool.ts | 按归因修改节点 | LLM 把自然语言指令解析为 {type, target, content} 结构化指令；支持 llm_prompt / code_logic / condition / threshold / data；code_logic 重写需 referenceData 防幻觉；threshold 用正则替换"旧值 改为 新值" |
| rename_workflow | rename-workflow.tool.ts | 改名称/描述 | 不走 save；平台约束：字母开头 + 字母数字下划线 + ≤50 |

**apps/api/src/agent/tools/iteration-counter.ts（硬约束）**
- Map&lt;workflowId, count&gt;，只增不减；batch_validate 和 update_workflow 共用计数器。
- MAX_ITERATIONS = 3；达到上限工具直接返回"已达迭代上限"错误，LLM 收到必须停止。
- save 成功时 resetIteration。
- **意义**：不靠 LLM 自觉，代码硬计数，防止"验证失败→修改→再验证"无限循环烧钱。

**apps/api/src/agent/tools/coze-client.ts**
- 共享 CozeClient 单例（save/test-run/batch-validate/update 等工具共用，编辑锁状态统一）。

### 3.5 能力层

#### ① apps/api/src/coze/coze.client.ts（平台接入基石，483 行）—— ⭐ 重点

**看什么**：外部系统集成的防御式写法。

- **认证**：Cookie `session_key=xxx` + Agw-Js-Conv: str + x-requested-with: XMLHttpRequest。PAT 不被接受。
- **请求统一封装**（request 方法）：10s 超时（AbortController）、GET 参数拼查询串、统一 CozeError[code] 格式、日志脱敏（session_key/api_key 只留前 8 位）。
- **编辑锁**：acquireEditLock 拿 15 分钟锁，类内记录 lockExpireAt，save 前 ensureLock 检查过期自动重取。
- **乐观锁重试**：save 返回 777777759（commit 过期）或 777777770（资源变更通知失败）自动重试，最多 3 次，重试前清锁 + 等 2s。
- **工作流生命周期**：create（icon_uri 必须传默认图标，空字符串导致资源不完整无法打开；flow_mode=0 工作流，2=智能体）→ validateTree（保存前校验连通性）→ saveWorkflow → testRun → getProcess 轮询。
- **动态事实**：listModels（模型能力标记在 model_ability 嵌套对象里，不在顶层！）→ listDatabases（res_type=7）→ listWorkflows → deleteWorkflow（清空壳）→ updateMeta。

#### ② apps/api/src/coze/schema-converter.ts（格式转换核心，797 行）—— ⭐ 重点

**看什么**：项目 CozeWorkflow → 平台内部 schema 的完整映射。

- **节点类型映射**：start=1, end=2, llm=3, code=5, condition=8, text=15, merge=32, database_query=43, http=45（未知降级 3）。
- **ID 重映射**：start → 100001，end → 900001（平台固定约定）。
- **数据流核心**：ref 引用 `{ type:"ref", content:{ source:"block-output", blockID, name } }`；字面量 `{ type:"literal", content, rawMeta }`（rawMeta.type：1=string, 2=integer, 3=boolean, 4=float, 6=object）。
- **llm 节点**：llmParam 14 项（temperature/maxTokens/topP/responseFormat/modleName/modelType/generationDiversity/supportThinking/enableThinking/apiType/prompt/enableChatHistory/chatHistoryRound/systemPrompt）+ settingOnError（switch + dataOnErr + processType 3 + backupLLmParam）+ 内置 outputs（reasoning_content / errorBody / isSuccess）。⚠️ 注意源码里 **modleName 是拼写错误**——平台字段就叫这个，别"修正"它！
- **code 节点**：language 3=Python / 1=JS；schema 字段格式铁律——object → schema 必须是数组（空数组=无子字段），list → schema 是类型对象，其他类型不传 schema（否则平台 dtoMetaToViewMeta 挂）。
- **condition 节点**：branches 条件 logic=2(AND) + operator=11(布尔为真)；left 引用**必须指向上游节点输出**（不是写死 start）。
- **text 节点**：concat 模式三件套必须齐全——concatResult + arrayItemConcatChar + allArrayItemConcatChars（缺了平台保存后拼接行为异常）。
- **merge 节点**：mergeGroups 分组聚合。
- **database_query 节点**：无 connection 时跳过节点（平台禁止空 databaseInfoID）+ 过滤相关边。
- **http 节点**：apiInfo/body{bodyType:"EMPTY"}/headers[]/params[]/auth{BEARER_AUTH}/setting{timeout,retryTimes}；URL 变量引用 {{city}} 必须转成完整引用 `{{block_output_<blockID>.<outputName>}}`（平台不认简写）；输出固定 body/statusCode/headers。
- **end 节点**：terminatePlan=returnVariables + inputParameters 引用上游第一个输出。
- 顶层包裹 `versions: { loop: "v2" }`；边 ID 大写（sourceNodeID/sourcePortID）；_temp.bounds 每个节点必须有。

#### ③ apps/api/src/coze/types.ts

- CozeApiResponse / CreateWorkflowData / EditLockData / CanvasData / TestRunData / ValidateTreeItem / GetProcessData 等接口类型。

#### ④ apps/api/src/coze/mcp-server.ts

- 把 CozeClient 暴露为标准 MCP 工具（stdio），7 个工具：create/save/test_run/list/update_meta/get_schema/convert_schema。
- 独立于 NestJS 运行：`pnpm --filter @coze-workflow/api mcp`。
- 用途：给 Qoder/Claude/Codex 等外部客户端通过协议调用平台能力。
- 环境变量查找兼容 4 种 cwd 模式。

#### ⑤ apps/api/src/llm/deepseek.client.ts（LLM 封装，280 行）

**看什么**：DeepSeek 官网结构化输出的完整踩坑史。

- `chatStructured<T>(schema, systemPrompt, userPrompt)`：withStructuredOutput(schema, { method: "jsonMode" })。
- **为什么只能 jsonMode**（官网实测）：functionCalling → 思考模型 400 "Thinking mode does not support this tool_choice"；jsonSchema → 400 "response_format type unavailable"；jsonMode（response_format json_object）→ 200 支持。
- **modelKwargs: { thinking: { type: "disabled" } }**：关思考，让预算全给 JSON 输出（reasoning 与正文共享 completion tokens）。
- 重试：默认 1 次（共最多 2 次调用）；describeError 启发式判断"疑似截断"（JSON 未闭合）vs "zod 校验失败"（JSON 完整但内容不符）。
- **resolveCaller()**：从调用栈解析调用方文件:行号（必须在 await 前同步调用，await 后调用栈丢失）——日志定位"被谁调用"。
- 字段约束依赖 systemPrompt 描述 + 输出端 zod 校验（jsonMode 不注入 schema）。

#### ⑥ apps/api/src/workflow-engine/planner.ts（两段式规划，443 行）—— ⭐ 重点

**看什么**：如何从架构上消除 LLM 输出截断。

- **Stage 1**：chatStructured(PlanSkeletonSchema, PLAN_SKELETON_PROMPT) 生成轻量骨架（元信息 + steps 内嵌 contracts，输出 1-2K token）。
- **Stage 2**：逐节点并行生成 nodeConfig，限并发 3 防 429；每次只输出单节点配置（约 200 token）；失败降级 {}。
- 合并：contracts 从骨架 steps 平铺，nodeConfig 按类型分组聚合。
- **mapToWorkflowPlan 映射规则**：
  - sanitizeWorkflowName：非法字符转下划线 → 去重下划线 → 去前导非字母 → 截断 50 → 空兜底 workflow（平台硬约束）。
  - steps：start → 业务步骤 → end；**LLM 显式输出 steps 时顺序权威（dependencies 用 steps index，-1=依赖 start）**，无 steps 时兜底布尔标志路径（旧逻辑）。
  - 保险：start 排第一、end 排最后（覆盖 LLM 输出异常顺序）。
  - contracts 与 steps 按 index 一一对应（nextContract 顺序取）。
  - needClarification=true 时返回 _clarification 字段，让 Agent 走 clarify_question。
- 关键：LLM 只输出语义（节点类型序列 + 依赖 + 数据契约），结构组装交给 generator。

#### ⑦ apps/api/src/workflow-engine/generator.ts（节点组装，682 行）—— ⭐ 重点

**看什么**：确定性生成的两遍遍历设计。

- **topoSortSteps**：按 dependencies 拓扑排序（LLM 输出的 order 可能错误，代码保证 start→...→end）。
- **第 1 遍**：createNodeForStep 创建所有节点骨架，记录 code 节点引用 + orderToId。
- **生成 edges**：按 dependencies 连线。
- **buildInputMapping**：自动生成所有 llm/code/text/http/database_query 节点的 inputMapping（数据流接线不靠 LLM）——start 多输入全映射；其他节点输出 → "input" 参数。
- **第 2 遍**：用真实 inputNames + logicDescription 调 CodeGenerator 生成代码节点 Python 代码（失败降级兜底模板）。
- **createLLMEdges**：LLM 节点必须有 default + branch_error 两条出边（平台约定，否则 validate_tree 报端口未连接）。
- **createConditionEdges**：条件节点每个分支一条边（端口 true / true_1 / true_2...）+ else 边（false → end）；删除旧的依赖树边。
- **节点生成规则**：contract 优先（LLM 数据契约）→ nodeConfig 兜底 → 代码式模板生成 prompt（不靠 LLM 写全文）；音频任务选 audio=true 模型；无 nodeConfig 的 condition 按描述语义生成"条件满足/不满足"两分支。
- 数据库节点无 connectionId 时跳过（不生成）。

#### ⑧ apps/api/src/workflow-engine/types.ts（zod schema，543 行）

**看什么**：LLM 输出契约的三个 schema。

- **LLMPlanOutputSchema**：一次性输出的完整 schema（保留备查，不再使用）。
- **PlanSkeletonSchema**：Stage 1 骨架。核心字段放宽 optional + superRefine 条件必需（澄清路径只要求 needClarification + clarificationQuestions）；contracts **内嵌在 steps 里**（保证跨节点变量名全局一致）；clarificationQuestions 兼容字符串/对象两种输出。
- **NodeConfigSchema**：Stage 2 单节点配置，字段全 optional，LLM 按节点类型只输出相关字段；inputs 兼容字符串数组/对象数组。
- 每个字段都有 .describe()——jsonMode 下字段约束靠描述 + 输出端 zod 校验。

#### ⑨ apps/api/src/workflow-engine/code-generator.ts

- 根据 logicDescription 生成平台规范 Python 代码：`async def main(args: Args) -> Output:` 入口 + `params = args.params` 取输入 + `ret: Output = {...}` 返回 + `isinstance(x, str): json.loads(x)` 输入防御。
- referenceData 必须原样写入代码常量（禁止编造/替换/删减）。
- 失败降级：buildFallbackCode（echo input → output 的可运行模板，不是 TODO 注释——保证保存后能执行）。

#### ⑩ apps/api/src/workflow-engine/platform-validator.ts

- save 前平台兼容性校验：start/end 唯一、code/llm 必须有 outputs（平台会 panic）、LLM model 在平台模型列表内（25 个硬编码子集）、condition 无 TODO target、database connection 非空、边引用节点存在。
- 与 packages/workflow-schema 的 validateWorkflow 互补（那个查结构，这个查平台约束）。

#### ⑪ apps/api/src/prompts/

- **plan-prompt.ts**：PLAN_PROMPT（一次性输出，保留备查不引用）+ PLAN_SKELETON_PROMPT（Stage 1，JSON 骨架示例 + 字段说明 + "不要输出 nodeConfig"）+ NODE_CONFIG_PROMPT（Stage 2，占位符 {SKELETON}/{nodeType}/{description}/{inputs}/{outputs}）。
- **repair-prompt.ts**：旧链路 repairer 用的 LLM 兜底修复 prompt。

### 3.6 旧链路（legacy/）

| 文件 | 职责 | 阅读重点 |
|---|---|---|
| graph.ts | StateGraph 固定流水线 plan→sketch→generate→validate→(条件)repair | 对比新旧编排；repairCount 上限 3；节点函数 try/catch 不抛异常写 state.errors |
| workflow.service.ts | /workflow/* REST 服务 | **mock 降级哲学**：LLM/平台调用失败返回 mock 结果，接口不挂前端不白屏 |
| workflow-repairer.ts | 规则驱动修复优先 + LLM 兜底 | 补 start/end、去重 ID、移除死边；复杂错误调 LLM（RepairOutputSchema） |
| workflow.controller.ts | 旧 REST 路由 | /workflow/plan /sketch /generate /validate /create /save /test-run /run |

### 3.7 共享包

**packages/shared/src/types/index.ts**
- WorkflowPlan / PlanStep（含 contract 数据契约 + nodeConfig 标 @deprecated）/ WorkflowNodeType（9 种）/ WorkflowSketch / ValidationResult / ApiResponse 等。
- 前端后端共用，改类型要重建 dist（postinstall 已自动 build）。

**packages/workflow-schema/src/types/index.ts**
- CozeWorkflow / CozeNode 联合类型（9 种节点，每种带注释说明平台要求）/ CozeEdge。
- 注释本身就是文档：LLM 节点 outputs 缺失会导致 SetOutputTypesForNodeSchema panic；HTTP 节点固定输出 body/statusCode/headers 等。

**packages/workflow-schema/src/templates/index.ts（351 行）**
- createStartNode / createLLMNode / createCodeNode / createConditionNode / createHttpNode / createDatabaseQueryNode / createTextNode / createMergeNode / createEndNode 工厂。
- generateId() 生成节点 ID。LLM 节点默认 model Doubao-Seed-2.0-Lite。

**packages/workflow-schema/src/validator/index.ts（172 行）**
- validateWorkflow：结构校验（nodes/edges 非空、start/end 存在、ID 唯一、边引用存在、代码节点出边 sourcePort 警告）。
- validateWorkflowJson：字符串入口（JSON 可解析 + _temp 警告 + 深入结构校验）。

### 3.8 前端（apps/web/）

#### ① src/App.tsx（586 行）—— ⭐ 重点

**看什么**：useChat 集成 + data 事件分发 + resume 手写 fetch 双路径。

- **useChat 配置三件套**：
  - `experimental_prepareRequestBody`：把 useChat 默认的 messages 数组改写为后端期望的 { sessionId, message }（取最后一条 user 消息）。
  - 自定义 `fetch`：把后端 Data Stream（0:/d:/e:）实时转换为 AI SDK 标准协议（transformToDataProtocolStream），useChat 才能解析。
  - body: { sessionId }。
- **data 事件处理**（handleDataEvent）：
  - text_delta → 增量追加 assistant 消息（currentAssistantIdRef 分段管理）。
  - reasoning_delta → 单独"思考气泡"消息（data.type="reasoning"），正式输出开始时封存。
  - tool_start / tool_end → 工具链面板（isToolOutputFailed 判断失败：JSON 开头=成功，错误前缀=失败，**不能用 includes("失败")**——业务 JSON 可能正常包含"失败"字样）。
  - interrupt → 提问卡片（固化到消息流 data.type="question"）+ 输入框切回复模式。
  - done / error → 收尾。
- **打断机制**：busy 时发送新消息 → interruptCurrent()（stop() 中断 useChat 流 + resumeAbortRef.abort() 中断 resume 请求）→ sendNewMessage 重置所有状态（processedDataCount 归零 + setData(undefined)）。
- **resume 双路径**：方案 A 手写 fetch + parseDataStream（不用 useChat 的 resume，因为要带 fileIds + 手动分段）。
- 工具链 key 用 crypto.randomUUID()（不能用自增序号：打断重放旧事件会撞 key）。
- 右侧面板：ToolCallPanel / WorkflowCanvas（草图）/ JsonPreview（工作流 JSON + 校验）/ 保存按钮（校验通过才显示）。

#### ② src/api/data-stream.ts（267 行）

- **parseDataStream**：手写 fetch 流解析，TextDecoder 增量解码按行切分（兼容 chunk 跨行），0: → onText、d: → onEvent。
- **transformToDataProtocolStream**：0: 文本 → `2:[{type:"text_delta"}]`（转 data 事件手动分段）；d: 事件 → `2:[{event}]`；d:error → `3:"message"`；e: 丢弃。
- **isToolOutputFailed**：{开头=成功；"规划失败/生成失败/保存失败/批量验证失败/读取失败/试运行失败/工作流更新失败"前缀=失败；空输出不算失败。

#### ③ src/api/workflow.ts

- workflowApi.create(workflow)：调 /workflow/create 保存（旧链路 REST，带 mock 降级）。

#### ④ 组件

| 组件 | 职责 |
|---|---|
| Header.tsx | 状态指示（running/idle） |
| chat-input.tsx | 输入框双模式（normal/reply）；文件上传按钮（表单 + fileIds） |
| chat-message-list.tsx | 消息渲染：普通文本 / reasoning 思考气泡 / question 提问卡片 |
| tool-call-panel.tsx | 右侧工具调用链（running/done/error 状态） |
| WorkflowCanvas.tsx | 工作流草图展示（简易版，非 ReactFlow） |
| JsonPreview.tsx | 工作流 JSON 预览 + 校验结果 |

### 3.9 其他目录

**docs/**
- architecture.md / mvp-plan.md / interview-notes.md：早期设计文档。
- coze-platform/：**最有价值的平台事实库**——platform-facts.md（25 模型 + 3 数据库 + 44 节点类型）、coze-node-fields-guide.md（节点字段参考 + 值引用语法 + rawMeta 类型对照）、coze-llm-node-sample.json / coze-clipboard-node-sample.json / health-workflow-103-nosnack-sample.json（平台真实样本）、coze-source-analysis.md（对照 coze-studio 源码的分析）。
- qoder-tasks/：**Qoder 任务历史**（sprint-a/b/c、截断修复、两段式规划评审等）——想看"某个问题怎么解决的"来这里翻。
- deepseek-thinking-model-token-budget-discussion.md：思考模型 token 预算分析。
- remote-workflow.md / development-log-2026-08-12.md。

**scripts/**
- clean-tsbuildinfo.mjs：清理误提交的 tsbuildinfo 缓存（Windows 拉代码后 text 字段报错的修复）。
- diagnose-coze-auth.ts：Coze 认证诊断脚本。

**test-data/**
- singing-testset.xlsx：训练营歌曲测试集（batch_validate 的 cases 数据源）。
- song-lyrics.md：歌词库（referenceData 示例）。

**空壳目录（不用读）**：apps/api/src/schema/、apps/api/src/validator/——早期预留 TODO，实际校验在 packages/workflow-schema 和 workflow-engine/platform-validator.ts。

---

## 四、端到端数据流

### 4.1 主流程（需求 → 部署 → 验证）

```
用户输入需求
  → POST /api/agent/chat（SSE）
  → controller → service.handleChat
  → sessionStore 获取/创建会话（新会话 = 新 graph + 新 MemorySaver）
  → graph.streamEvents(messages, { thread_id })
  → createReactAgent 内部 ReAct 循环：
       LLM 思考（reasoning_content 流式输出）
       → 调 get_platform_facts（可选）
       → 调 clarify_question（缺信息时 interrupt 暂停 → 前端提问卡片 → resume 继续）
       → 调 plan_workflow → planner 两段式（骨架 → 逐节点 config）→ WorkflowPlan
       → 调 generate_workflow → generator 拓扑排序 + 自动接线 + CodeGenerator 生成代码 → CozeWorkflow + validation
       → 调 save_to_coze → validateWorkflow → checkPlatformCompatibility → convertToPlatformSchema
         → createWorkflow（拿 workflowId）→ validateTree → saveWorkflow（乐观锁）
       → 调 batch_validate → testRun + getProcess 轮询 → accuracy + 归因
       → 若 accuracy < 100%：update_workflow（LLM 解析修改指令 → 改节点）→ 重新 save（带原 workflowId）→ batch_validate
       → 迭代上限 3 轮，达上限停止汇报
  → 事件流写回 SSE（0:/d:/e:）
  → 前端 useChat 解析渲染（文本 / 思考气泡 / 工具链 / 提问卡片 / 右侧面板）
```

### 4.2 interrupt/resume 时序

```
LLM 调用 clarify_question
  → 工具内 interrupt({question, context}) 暂停图
  → streamEvents 结束，service 检查 graph.getState() → state.tasks[].interrupts[].value
  → 发 d:{type:"interrupt"} → 前端渲染提问卡片 + replyMode
  → 用户回答 → POST /api/agent/chat/resume { sessionId, answer, fileIds? }
  → service.handleResume → new Command({ resume: answer }) → graph.streamEvents(command)
  → 图从断点继续，clarify_question 返回 "用户回答: xxx"
```

### 4.3 保存工作流的乐观锁时序

```
save_to_coze
  → ensureLock（锁过期自动 acquire，15 分钟 TTL）
  → getSchema（拿最新 submit_commit_id）
  → save（提交 schema + submit_commit_id）
  → 若 777777759（commit 过期）：清锁 + 等 2s + 重试（最多 3 次）
```

### 4.4 前端流转换

```
后端原始流：0:"文本"\nd:{事件}\ne:{finish}\n
  → transformToDataProtocolStream（useChat 路径）：
       0: → 2:[{type:"text_delta",content}]
       d:error → 3:"错误消息"
       d:其它 → 2:[{事件}]
       e: → 丢弃
  → useChat 内部解析 → messages 数组 + data 数组
  → App 的 useEffect 增量消费 data 数组（processedDataCount 去重）
```

---

## 五、功能清单

### 5.1 已实现 ✅

| 功能 | 位置 | 状态 |
|---|---|---|
| 需求 → 工作流规划（两段式，防截断） | planner.ts + types.ts + plan-prompt.ts | ✅ |
| 规划 → 可部署工作流 JSON（确定性组装） | generator.ts + code-generator.ts | ✅ |
| 项目格式 → 平台格式转换（9 种节点） | schema-converter.ts | ✅ |
| 部署到私有 Coze（创建/更新/改名/删除） | coze.client.ts | ✅ |
| 保存前双重校验（结构 + 平台兼容 + validate_tree） | validator + platform-validator + coze.client | ✅ |
| 试运行 + 轮询执行结果 | test-run.tool + coze.client.getProcess | ✅ |
| 批量验证（accuracy + 归因分组） | batch-validate.tool | ✅ |
| 迭代修复（LLM 解析修改指令 → 改节点 → 重存） | update-workflow.tool + iteration-counter | ✅（上限 3 轮） |
| 需求澄清（interrupt/resume） | clarify.tool + react-agent.service | ✅ |
| 多轮对话（会话隔离 + 记忆） | session.store + MemorySaver | ✅（内存态） |
| 文件上传 + 读取（xlsx/csv/md/txt） | controller.upload + read-file.tool | ✅ |
| SSE 流式（文本 + 思考过程 + 工具事件） | react-agent.service + data-stream.ts | ✅ |
| 打断恢复（脏 checkpoint 重建） | graphDirty 机制 | ✅ |
| 平台事实动态查询（模型/数据库） | platform-facts.tool + listModels/listDatabases | ✅ |
| MCP 通道（外部客户端调用平台） | mcp-server.ts | ✅ |
| 旧链路 REST + mock 降级 | legacy/ | ✅（保留） |
| 前端对话 UI + 工具链面板 + 草图/JSON 预览 | apps/web | ✅ |

### 5.2 未实现 / 排队 ⏳

- 前端 Sprint C：Vercel AI SDK 标准改造 + 文件上传 UX（排队中）。
- 答案表解析闭环（Sprint B 剩余部分）。
- 会话持久化（目前重启即清）。
- 并发试运行（目前串行防限流）。
- 更精细的失败恢复（如锁过期提醒机制 TODO）。
- 单元测试 / 集成测试（lint/test 是 echo 占位）。

---

## 六、坑清单（血泪史分类速查）

### 6.1 平台坑（Coze 私有平台）

1. **代码节点出边不写 sourcePortID**——带端口的出边会被当 BranchSchema，代码节点不实现 BranchBuilder → 报错。铁律：code 出边无端口；llm 必须 default + branch_error 成对；condition 用 true/true_1/.../false。
2. **COZE_SESSION_KEY 填纯 session_key（214 字符）**，不是完整 cookie（322）。每日过期需重抓，已留 TODO。
3. **save 是乐观锁**：每次 save 推进 commit，旧 commit 再提交报 777777759。必须 save 前重新 getSchema 拿最新 submit_commit_id。
4. **icon_uri 必须传默认图标**（default_icon/default_workflow_icon.png），空字符串导致创建的资源不完整无法打开。
5. **flow_mode=0（工作流）**，2=智能体（打开报"无法查看智能体"）。
6. **工作流名称约束**：字母开头 + 字母数字下划线 + ≤50（sanitizeWorkflowName 代码兜底）。
7. **平台 Go 后端对不完整 schema 直接 panic**（不报友好错误）——所以本地 validator + platform-validator + validate_tree 前置校验很重要。
8. **code/llm 节点必须声明 outputs**，否则 SetOutputTypesForNodeSchema panic。
9. **databaseInfoID 不能为空**——无 res_id 时整个节点跳过 + 过滤相关边。
10. **LLM 节点 modleName 是平台拼写错误**，别"修正"。
11. **模型能力标记在 model_ability 嵌套对象**（不在顶层），?? false 兜底会让 audio 全变 false → AI 误以为无音频模型卡澄清。静默失败最坑。
12. **validate_tree 是保存前校验接口**（不是 execute_detail）；delete 清空壳防平台垃圾。
13. **URL 变量引用 {{city}} 不认**，必须 `{{block_output_<blockID>.<outputName>}}` 完整引用。
14. **text concat 三件套缺一不可**（concatResult + arrayItemConcatChar + allArrayItemConcatChars），缺失拼接行为异常。

### 6.2 LLM 坑（DeepSeek）

1. **思考模型 reasoning 与正文共享 completion tokens**：默认 4K 上限会把含工具参数调用的输出截断 → 工具解析失败 → 反复重试死循环。解法：maxTokens 8192 + 显式 `thinking: {type:"disabled"}`。
2. **结构化输出只能 jsonMode**（response_format json_object）：functionCalling 思考模型 400；jsonSchema 官网 400。
3. **maxRetries 默认 6 次**会把单次失败放大成 6 次静默重试（每次等满超时）→ 前端一直转圈。设 maxRetries: 1。
4. **长 JSON 输出截断**：一次性输出完整规划必截断 → 两段式（骨架 1-2K + 逐节点 config 200 token）从架构上消除。
5. **代码节点数据幻觉**：referenceData 不传，LLM 生成代码时凭空编造歌词/歌曲 → generate_workflow 必须传 referenceData；update_workflow 重写代码也必须带 referenceData，否则拒绝。
6. **jsonMode 不注入 schema**：字段约束靠 prompt 描述 + 输出端 zod 校验。
7. **"Failed to parse. Text: ..." 的截断判断**：JSON.parse 失败（未闭合）才是截断；zod 失败说明 JSON 完整但内容不符（描述有分类启发式）。
8. **认证失败别瞎改工作流**：save 返回 authentication failed 是凭证问题（COZE_SESSION_KEY 过期），不是工作流问题——系统提示词明确要求直接告知用户。

### 6.3 框架坑（LangGraph / LangChain）

1. **MemorySaver 不支持跨实例恢复**：每个会话独立 graph + 独立 checkpointer；不能全局共享一个 graph。
2. **interrupt 值在 state.tasks[].interrupts[].value**（不是 state.values.__interrupt__）。
3. **客户端断开（打断）检测**：不能只靠 for await 里查 res.destroyed（LLM 思考期间迭代器阻塞，检测延迟）——用 res.on("close") 立即打脏标记；还要 stream.cancel() 防止后台执行跑完抛未捕获异常崩溃。
4. **打断残留（脏 checkpoint）**：上次流被打断，checkpoint 留半截状态 → 下次 chat 重建 graph 清脏，对话记忆由 session.messages 保留。
5. **recursionLimit 默认 25 步不够**：ReAct 循环多次工具调用容易撞上限 → 40。
6. **createReactAgent ^1.4.9 直接返回编译后图**，无需 .compile()。
7. **tool_end 的 output 是 ToolMessage JSON 序列化**（{lc, type, kwargs:{content}}），要解析取 kwargs.content。
8. **zod 4 的 z.record() 单参形式类型推断有歧义**：写 z.record(z.string(), z.unknown())。
9. **工具顺序影响 LLM 选择偏好**：clarify 放第一、read_file 第二。

### 6.4 前端坑

1. **不能用 includes("失败") 判断工具失败**——业务 JSON 可能正常包含"失败"（如"识别失败输出未知歌曲"）。用 {开头 + 错误前缀。
2. **useChat 默认发 messages 数组**，后端要 { sessionId, message } → experimental_prepareRequestBody 改写。
3. **useChat 解析不了后端自定义协议** → 自定义 fetch 用 transformToDataProtocolStream 实时转换。
4. **工具链 key 不能用自增序号**：打断重放旧事件会撞 key → crypto.randomUUID()。
5. **data 数组增量消费**：processedDataCount 去重，打断发送新消息时归零 + setData(undefined)。
6. **thinking 段落分段**：currentReasoningIdRef / currentAssistantIdRef 管理，正式输出/工具调用开始时封存思考段落。

### 6.5 工程坑

1. **dotenv 路径**：tsx src 模式 / dist 模式 / pnpm --filter cwd 三种层级不同 → main.ts 和 mcp-server.ts 各写兼容逻辑。
2. **shared/workflow-schema 改类型要重建 dist**：postinstall 自动 turbo build（--force 跳过缓存）；Windows 拉代码后 text 字段报错 = dist 未重建（clean-tsbuildinfo.mjs 清理缓存）。
3. **busboy latin1 解码中文文件名乱码**：fixFilenameEncoding 转回 UTF-8（含 U+FFFD 保留原值）。
4. **CSV 中文乱码**：readFileSync 默认 latin1 读 → 必须先 utf-8 读再交给 SheetJS（+ 剥 BOM）。
5. **日志脱敏铁律**：session_key/api_key 只留前 8 位 + 长度，防止认证信息完整泄露。
6. **LLM 调用失败不抛 500**：工具 try/catch 返回错误字符串，让 LLM 自己决定下一步（旧链路 mock 降级同理）。

---

## 七、代码 Roadmap

### 7.1 演进路线（从 git log 逆推）

| 阶段 | 内容 | 关键 commit |
|---|---|---|
| 1. 骨架 | monorepo + 类型 + 预留目录 | 8/11 |
| 2. NestJS 迁移 + 平台接入 | CozeClient 真实 API + schema-converter | 8/12 |
| 3. 节点结构排雷 | 对照平台样本修 llm/http/text/start | 8/13 |
| 4. Sprint A（新链路） | createReactAgent + 工具 + interrupt + SSE + 前端 | 8/13 |
| 5. Sprint B（验证闭环） | batch_validate + update_workflow + 迭代上限 | 8/13-14 |
| 6. 节点结构大修 | 对照源码 + 平台样本补全（llmParam 14 项、validate_tree、deleteWorkflow、planner 显式 steps） | 8/14 |
| 7. 截断治理 | maxTokens 8192 → 关思考 → planner 两段式 | 8/14-15 |
| 8. 进行中 | 分步生成收尾（contracts 留骨架）、Sprint C 前端 | 8/15 |

### 7.2 下一步（按优先级）

1. **Sprint C**：前端 Vercel AI SDK 标准改造 + 文件上传 UX（后端 SSE 协议会改，读代码时注意 react-agent.service.ts 的事件序列化和 controller 接口近期会变）。
2. **答案表解析闭环**（Sprint B 剩余）：read_file 表格数据 → 自动构造 batch_validate cases。
3. **多轮持久化**：MemorySaver 换持久化 checkpointer（如 PostgresSaver）。
4. **并发试运行**：串行 → 限并发（防限流的前提下提速）。
5. **测试补全**：lint/test 目前是占位，补真实单测（validator/converter 是纯函数，最值得测）。
6. **锁过期提醒**：COZE_SESSION_KEY 每日过期提醒机制（TODO）。

---

## 八、学习要点 / 面试考点

1. **为什么从 StateGraph 升级到 createReactAgent？** 固定流水线 vs LLM 自主决策；灵活性、对话能力、状态管理对比。
2. **interrupt/resume 原理**：interrupt() 暂停图 → checkpointer 保存状态 → Command({resume}) 恢复 → 工具返回用户回答。前提：必须有 checkpointer。
3. **为什么 save 前必须重新 canvas？** 乐观锁：save 推进 commit，旧 commit 报 777777759。
4. **LLM 结构化输出的三种模式**：functionCalling（工具调用）/ jsonSchema（json_schema）/ jsonMode（json_object）——不同平台支持度不同，DeepSeek 官网只支持 jsonMode。
5. **怎么防止 LLM 输出截断**：① 调大 maxTokens；② 关思考（reasoning 与正文共享预算）；③ 拆小输出（两段式）；④ 结构化 schema 约束。
6. **确定性生成哲学**：LLM 只输出语义（节点序列 + 数据契约），结构组装（拓扑排序、接线、端口、代码生成）由代码完成——质量可控、可测试。
7. **工具设计要点**：薄封装 + 统一错误字符串返回（不抛异常让 LLM 决定）+ 模块级单例（无状态可共享）+ 硬约束用代码计数（不靠 LLM 自觉）。
8. **SSE 流式协议设计**：文本增量 / 结构化事件 / 结束标记分离，前端按行解析增量渲染；思考过程单独通道展示。
9. **外部系统集成防御式写法**：超时 + 重试 + 乐观锁 + 日志脱敏 + 降级 mock。
10. **前端双路径**：useChat（常规对话）+ 手写 fetch（resume，需要带 fileIds + 手动分段控制）。

---

## 附：最快上手路径

想最快跑起来看效果：

```bash
cd ~/workspace/ai-tools-demo/src/agent-coze-workflow
pnpm install        # postinstall 自动 build 所有包
cp .env.example .env  # 填 DEEPSEEK_API_KEY + COZE_SESSION_KEY + COZE_SPACE_ID
pnpm dev            # api:3000 + web:5173
```

浏览器打开 http://localhost:5173，输入"用户输入一句话，LLM 回答"这类简单需求，观察工具链面板一步步执行。

想最快读代码：react-agent.service.ts → coze.client.ts → schema-converter.ts → generator.ts → planner.ts → App.tsx（按本文 3.3 → 3.5 → 3.8 的顺序）。
