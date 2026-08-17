# Coze 数据库（知识库）API 实测记录（2026-08-17）

> 来源：平台前端抓包 curl 实测 + skill 端到端验证。所有接口 `POST`，请求头：
> `Cookie: session_key=<JWT>` + `Agw-Js-Conv: str` + `x-requested-with: XMLHttpRequest`
> 返回 `code:0` 成功；**部分接口返回字段在顶层（非 data 下）**。

## 1. 空间列表（创建前先选空间）

`POST /api/playground_api/space/list`，body `{}`

返回（顶层 `data.bot_space_list[]`）：
- `id` 空间 ID、`name` 名称、`role_name`（所有者/开发者）、`space_type`
- 示例：Personal Space（7616302273806729216，所有者）、公共空间（7595549890164293632，开发者）、兴趣岛ma（7560621359533916160，开发者）

⚠️ 创建流程必须先让用户选空间（skill 命令：`coze spaces`）。

## 2. 创建数据库

`POST /api/memory/database/add`，body：
```json
{
  "creator_id": "7616302273802534912",
  "space_id": "7560621359533916160",
  "icon_uri": "default_icon/default_database_icon.png",
  "table_name": "hzw_1",
  "table_desc": "测试",
  "field_list": [
    {"name": "url", "desc": "音频标签", "type": 1, "must_required": true}
  ],
  "prompt_disabled": false
}
```
- ⚠️ `table_name`：只允许小写字母开头的小写字母/数字/下划线（报错：数据库名称只允许小写字母、数字和下划线，并以小写字母开头）
- ⚠️ `creator_id` 必须用真实 `user_id_str`（`POST /api/passport/account/info/v2/` 返回），**不是** session_key JWT payload 里的 id（否则 `106000001 unauthorized access: creator id is invalid`）
- 返回在**顶层** `database_info`：`id`（database_id）、`datamodel_table_id`、`actual_table_name`（如 `table_7675020928794771456`）

## 3. 上传文件

`POST /api/bot/upload_file`，body：
```json
{
  "file_head": {"file_type": "xlsx", "biz_type": 2},
  "data": "<base64>"
}
```
返回 `data.upload_url`（完整 CDN URL）→ 提取 **`BIZ_BOT_DATASET/...xlsx`** 路径作为后续 `tos_uri`（正则 `/(BIZ_BOT_DATASET\/[^?&]+)/`）。

## 4. 获取表结构（预览）

`POST /api/memory/table_schema/get`，body：
```json
{
  "table_sheet": {"sheet_id": "0", "header_line_idx": "0", "start_line_idx": "1"},
  "table_data_type": 1,
  "database_id": "7675018928304685056",
  "source_file": {"tos_uri": "BIZ_BOT_DATASET/xxx.xlsx"}
}
```
`table_data_type`: 1=结构，2=数据预览。返回字段待完善（实测 data 为空对象也可继续导入）。

## 5. 校验 schema

`POST /api/memory/table_schema/validate`，body：
```json
{
  "database_id": "...",
  "source_file": {"tos_uri": "..."},
  "table_sheet": {"sheet_id": "0", "header_line_idx": "0", "start_line_idx": "1"},
  "table_type": 1
}
```

## 6. 导入数据

`POST /api/memory/table_file/submit`，body：
```json
{
  "database_id": "...",
  "file_uri": "BIZ_BOT_DATASET/xxx.xlsx",
  "table_type": 1,
  "table_sheet": {"sheet_id": "0", "header_line_idx": "0", "start_line_idx": "1"}
}
```

## 7. 导入进度

`POST /api/memory/table_file/get_progress`，body `{"database_id":"...","table_type":1}`
返回 `data.progress`（100=完成）、`data.status_descript`。

## 8. 数据库列表

`POST /api/memory/database/list`，body `{"space_id":"...","table_type":2}`
⚠️ 返回在**顶层** `database_info_list[]`（不是 data 下）；缺 `table_type` 报 400。

## 实测踩坑汇总

| 坑 | 说明 |
|---|---|
| creator_id 用错 | 必须 user_id_str（account/info/v2），不是 JWT id |
| 返回层级不统一 | database/add → 顶层 `database_info`；database/list → 顶层 `database_info_list`；其他 → `data` |
| table_name 规则 | 小写字母开头，仅小写字母数字下划线 |
| upload_url 提取 | tos_uri = URL 里 `BIZ_BOT_DATASET/...` 路径 |
| table_type 必填 | database/list 必须带 table_type:2 |

## 代码

- `apps/api/src/coze/database-client.ts`：DatabaseClient 封装（与 CozeClient 同构）
- skill 侧：`~/.openclaw/workspace/skills/coze-workflow-skill/scripts/coze-cli.mjs` 的 `db-*` / `spaces` 命令

## 9. 发布工作流（type9 子工作流调用前置）

`POST /api/workflow_api/publish`，body：
```json
{"workflow_id":"...","space_id":"...","has_collaborator":false,"force":true,"workflow_version":"v0.0.1","version_description":"发布"}
```
- ⚠️ **子工作流（type9）必须发布后才能被调用**（未发布报 720702004 not found；workflowVersion 留空或 "latest" 均无效）
- 发布后 workflowVersion 填真实版本号（如 "v0.0.1"）
