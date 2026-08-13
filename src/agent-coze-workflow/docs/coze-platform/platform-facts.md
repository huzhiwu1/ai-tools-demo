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

## 三、资源库类型对照（library_resource_list 的 res_type_filter）

- 1 = 插件（8 个）
- 2 = 工作流（15 个）
- 4 = 文本（5 个）
- 6 = 提示词（8 个）
- 7 = **数据库**（3 个）
- 10 = agent（2 个）
