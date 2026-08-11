# 开发日志 2026-08-12：Coze 工作流 Agent 项目里程碑

> 本文档用于交接：家里 AI（来财）与公司电脑（志武 + Qoder）的远程协作起点。

## 一、今日里程碑

1. **Coze 私有平台 API 全打通**（coze.dev1.dachensky.com，纯 API 自动化）
   - 完整链路：`create → edit_lock(acquire) → canvas → save（循环）→ test_run`
   - 关键发现：`edit_lock` 是首次保存必需（否则报 777777759"不是最新副本"）；每次 save 前必须重新 canvas 拿最新 `submit_commit_id`
   - 认证：cookie `session_key`（PAT 不被接受）；cookie 每日过期需重抓
   - 节点类型映射实测：1=start、2=end、3=大模型、5=代码、8=选择器、43=查询数据、45=HTTP
   - LLM 节点配置结构（llmParam 14 项）从用户复制的节点样本中提取

2. **CozeClient 落地**（`apps/api/src/mcp/cozeClient.ts`）
   - createWorkflow / acquireEditLock / getSchema / saveWorkflow / testRun / updateMeta / listWorkflows
   - 锁管理（TTL 900s 自动重 acquire）+ 777777759 自动重试 + 10s 超时 + 降级 mock

3. **Schema 转换器**（`apps/api/src/mcp/schema-converter.ts`）
   - 项目 CozeWorkflow → 平台内部格式（ID 重映射 100001/900001、type 映射、ref 引用、edges 大写、versions loop v2）
   - 支持 start/end/大模型节点；修复 end 节点 inputs 引用（避免平台 Go 后端 panic）

4. **前端保存按钮**（方案 A）
   - 生成 + 校验通过后点「保存到 Coze」→ 真实创建到平台 → 显示 workflow_id + 平台链接

5. **实测全链路通过**：带大模型节点的工作流 `create → save → test_run` 返回 execute_id ✅

## 二、项目当前能力

```
输入需求 → DeepSeek LLM 规划（真实）→ 草图 → Coze JSON → 本地校验
→ （可选）保存到 Coze 平台 → 试运行
```

## 三、Git 远程协作（已配置）

- 远程：`https://github.com/huzhiwu1/ai-tools-demo.git`（私有）
- 家里 AI 已配置 gh 认证（免密 push）
- 公司电脑配置见 `docs/remote-workflow.md`

## 四、待办（下一步候选）

- [ ] code/condition/http 节点 data 结构实测补全（需复制节点样本）
- [ ] test_run 结果轮询/执行详情接口
- [ ] MCP 包装（方案 B：把 CozeClient 暴露成工具给 LangGraph agent 自主调用）
- [ ] `/workflow/run` 增加 autoSave 选项（生成后自动保存）
- [ ] 前端展示"保存到 Coze"后的平台链接体验优化
- [ ] COZE_SESSION_KEY 过期提醒机制

## 五、环境变量（.env，已 gitignore）

```
DEEPSEEK_API_KEY=       # LLM 规划（必须）
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
DEEPSEEK_MODEL=deepseek-chat
COZE_API_BASE_URL=https://coze.dev1.dachensky.com
COZE_SPACE_ID=7560621359533916160
COZE_SESSION_KEY=       # cookie，每日过期需重抓
```

## 六、关键知识沉淀（面试用）

1. **乐观锁**：save 推进 commit，旧 commit 必被拒 → 每次操作前重新拉取版本号
2. **编辑锁**：edit_lock(acquire) 建立单写者会话（TTL 900s），类比 git checkout
3. **外部系统防御**：平台 Go 后端对不完整 schema 直接 panic（720701013）而不是友好报错 → schema 模板化 + 本地校验的重要性
4. **API 逆向方法**：DevTools 抓 cURL → 读 JS bundle 找接口定义 → 报错信息反推类型约束（space_id 字符串 vs flow_mode 数字）
5. **降级设计**：外部依赖挂掉时返回 mock + warn，接口不 500
