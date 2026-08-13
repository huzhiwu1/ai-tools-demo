# Coze 平台事实数据（2026-08-13 实测）

> 来源：`/api/bot/get_model_list`（模型）+ `/api/plugin_api/library_resource_list`（资源库）
> 用途：PLAN_PROMPT / 工具描述中作为"平台真实约束"，防止 LLM 用不存在的模型或无效数据源。

## 一、可用模型列表（25 个）

**⚠️ 关键约束：生成 LLM 节点时，modelType + modleName 必须来自下表，禁止臆造。**

| model_name | model_type | 音频理解 | 图片理解 | 视频理解 | 多模态 | 备注 |
|---|---|---|---|---|---|---|
| Doubao-Seed-2.0-Lite | 201 | ✅ | ✅ | ✅ | ✅ | **推荐默认**（全能力+function_call） |
| Doubao-Seed-2.0-mini | 202 | ✅ | ✅ | ✅ | ✅ | 全能力，轻量 |
| Doubao-Seed-1.6 | 70 | ✅ | ✅ | ✅ | ✅ | 全能力 |
| gemini-3.1-pro-preview | 142 | ✅ | ✅ | ✅ | ✅ | 全能力 |
| Qiniu-Gemini-3.1-Pro-Preview | 203 | ✅ | ✅ | ✅ | ✅ | 全能力 |
| Qwen3.5-Omni-Plus | 230 | ✅ | ✅ | ✅ | ✅ | 全能力，Omni 全能 |
| Doubao-Seed-2.1-turbo | 271 | ❌ | ✅ | ✅ | ✅ | 无音频 |
| Doubao-Seed-2.1-pro | 270 | ❌ | ✅ | ✅ | ✅ | 无音频 |
| Doubao-Seed-2.0-Pro | 200 | ❌ | ✅ | ✅ | ✅ | 无音频 |
| Doubao-Seed-1.8 | 180 | ❌ | ✅ | ✅ | ✅ | 无音频 |
| doubao-seed-1.6-vision | 160 | ❌ | ✅ | ✅ | ✅ | 视觉专用 |
| qwen3-vl-plus | 170 | ❌ | ✅ | ✅ | ✅ | 视觉专用 |
| Qwen3.7-Plus | 260 | ❌ | ✅ | ✅ | ✅ | 无音频 |
| Qwen3.6-Plus | 220 | ❌ | ✅ | ✅ | ✅ | 无音频 |
| Qwen3.5-Plus-2026-2-15 | 210 | ❌ | ✅ | ✅ | ✅ | 无音频 |
| Deepseek-V4-Flash-VolcEngine | 280 | ❌ | ❌ | ❌ | ❌ | 纯文本 |
| Deepseek-V4-Pro-VolcEngine | 25 | ❌ | ❌ | ❌ | ❌ | 纯文本 |
| Deepseek-V3-VolcEngine | 20 | ❌ | ❌ | ❌ | ❌ | 纯文本 |
| GLM-5 | 250 | ❌ | ❌ | ❌ | ❌ | 纯文本 |
| qwen-max | 130 | ❌ | ❌ | ❌ | ❌ | 纯文本 |
| qwen-flash | 120 | ❌ | ❌ | ❌ | ❌ | 纯文本 |
| qwen-plus | 110 | ❌ | ❌ | ❌ | ❌ | 纯文本 |
| Qwen3-32B | 90 | ❌ | ❌ | ❌ | ❌ | 纯文本 |
| Doubao-1.5-Pro-32k | 40 | ❌ | ❌ | ❌ | ❌ | 纯文本 |
| Doubao-1.5-Lite | 30 | ❌ | ❌ | ❌ | ❌ | 纯文本 |

**选择规则（LLM 生成节点时）：**
- **需要识别音频/视频内容 → 必须选 `audio_understanding: true` 的模型**（Doubao-Seed-2.0-Lite / Doubao-Seed-2.0-mini / Doubao-Seed-1.6 / gemini-3.1-pro-preview / Qiniu-Gemini-3.1-Pro-Preview / Qwen3.5-Omni-Plus）
- 纯文本任务 → 任意模型均可，优先 Doubao-Seed-2.0-Lite
- **默认值**：Doubao-Seed-2.0-Lite（modelType=201）

**LLM 节点参数约定（llmParam 14 项）**：modelType=上面的数字、modleName=上面的 model_name，其余见 `docs/coze-platform/coze-llm-node-sample.json`。

## 二、可用数据库列表（res_type=7）

**⚠️ 关键约束：生成 database 节点时，databaseInfoID 必须来自下表。没有匹配的数据源 → 不要生成 database 节点。**

| 名称 | res_id (databaseInfoID) | 描述 |
|---|---|---|
| vim_add_new_test | 7647092935296548864 | 玩一下 |
| lhq_test | 7620643189891792896 | lhq_test |
| test_table | 7587978700876939264 | 111 |

**查询方式**（CozeClient 可加方法）：`POST /api/plugin_api/library_resource_list`，body `{user_filter:0, res_type_filter:[7], name:"", publish_status_filter:0, space_id, size:15, owner_ids:[], desc:"", res_id:""}` → `resource_list[].res_id`。

## 三、可用节点类型（node_template_list 全量，2026-08-13 实测）

**⚠️ 生成器 mapNodeType 的权威依据**：节点 type 字符串数字映射必须与下表一致。

| node_type | 名称 | 描述 | 分类 |
|---|---|---|---|
| 1 | 开始 | 工作流起始节点 | 输入&输出 |
| 2 | 结束 | 返回工作流运行结果 | 输入&输出 |
| 3 | 大模型 | 调用大语言模型 | 核心 |
| 4 | 插件 | 访问实时数据和外部操作 | 核心 |
| 5 | 代码 | 处理输入变量生成返回值 | 业务逻辑 |
| 6 | 知识库检索 | 知识库召回 | 知识库&数据 |
| 8 | 选择器 | 多分支条件判断 | 业务逻辑 |
| 9 | 工作流 | 嵌套子任务 | 核心 |
| 12 | SQL自定义 | 自定义 SQL 增删改查 | 数据库 |
| 13 | 输出 | 中间过程消息输出 | 输入&输出 |
| 15 | 文本处理 | 字符串变量格式处理 | 组件 |
| 16 | 图像生成 | 文字/参考图生成图片 | 图像处理 |
| 18 | 问答 | 中间向用户提问 | 组件 |
| 19 | 终止循环 | 跳出循环体 | 业务逻辑 |
| 20 | 设置变量 | 重置循环变量 | 业务逻辑 |
| 21 | 循环 | 循环执行任务 | 业务逻辑 |
| 22 | 意图识别 | 意图匹配 | 业务逻辑 |
| 27 | 知识库写入 | 添加文本知识库 | 知识库&数据 |
| 28 | 批处理 | 批量运行任务 | 业务逻辑 |
| 29 | 继续循环 | 终止当前循环执行下次 | 业务逻辑 |
| 30 | 输入 | 中间过程信息输入 | 输入&输出 |
| 31 | 注释 | 注释 | 组件 |
| 32 | 变量聚合 | 多分支输出聚合 | 业务逻辑 |
| 40 | 变量赋值 | 给变量赋值 | 知识库&数据 |
| 42 | 更新数据 | 修改表数据 | 数据库 |
| 43 | 查询数据 | 查询表数据 | 数据库 |
| 44 | 删除数据 | 删除表数据 | 数据库 |
| 45 | HTTP请求 | 发送 API 请求 | 组件 |
| 46 | 新增数据 | 插入表数据 | 数据库 |
| 58 | JSON序列化 | 变量转 JSON 字符串 | 组件 |
| 59 | JSON反序列化 | JSON 字符串解析为变量 | 组件 |
| 61 | 火山知识库检索 | 火山外部知识库 | 知识库&数据 |
| 1001 | 延迟定时器 | 延迟执行 | 定时器 |
| 1002 | 单次定时器 | 定时执行 | 定时器 |
| 1100 | 企微私聊群发 | 企微私聊触达 | 触达 |
| 1101 | AI外呼 | 外呼触达 | 触达 |
| 1102 | 发送短信 | 短信触达 | 触达 |
| 1103 | 企微群 | 企微群聊触达 | 触达 |
| 1104 | 企微朋友圈 | 朋友圈内容 | 触达 |
| 1105 | 企微朋友圈评论 | 朋友圈评论 | 触达 |
| 1200 | 引用标签 | 引用既有标签 | 标签管理 |
| 1300 | 生成人工任务 | 人工处理任务 | AI运营 |

**当前 schema-converter 映射对照**（已验证一致 ✅）：start=1 / end=2 / llm=3 / code=5 / condition→选择器=8 / text=15 / merge=32 / database_query=43 / http=45。

## 四、资源库类型对照（library_resource_list 的 res_type_filter）

- 1 = 插件（8 个）
- 2 = 工作流（15 个）
- 4 = 文本（5 个）
- 6 = 提示词（8 个）
- 7 = **数据库**（3 个）
- 10 = agent（2 个）
