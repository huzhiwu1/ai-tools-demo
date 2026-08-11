# 架构设计文档

## 整体架构

```
用户输入（自然语言）
        │
        ▼
┌───────────────────────────────────────┐
│              React 前端               │
│  InputPanel │ WorkflowCanvas │ …      │
└───────────────┬───────────────────────┘
                │ HTTP / SSE
                ▼
┌───────────────────────────────────────┐
│           Express API 服务            │
│  /health │ /api/v1/workflow │ …       │
└───────────────┬───────────────────────┘
                │
                ▼
┌───────────────────────────────────────┐
│            Agent 编排层               │
│                                       │
│  WorkflowPlanner                      │
│       │                               │
│       ▼                               │
│  WorkflowGenerator                    │
│       │                               │
│       ▼                               │
│  WorkflowRepairer                     │
│                                       │
│  技术栈: LangChain + LangGraph        │
└───────────────┬───────────────────────┘
                │
                ▼
┌───────────────────────────────────────┐
│            MCP Client 层              │
│  CozeClient: create / run / get       │
└───────────────┬───────────────────────┘
                │
                ▼
┌───────────────────────────────────────┐
│           Coze 平台 API               │
└───────────────────────────────────────┘
```

## 核心模块职责

### Agent 层（apps/api/src/agents/）

- **WorkflowPlanner**：分析用户需求，生成工作流规划草稿（WorkflowDraft）
- **WorkflowGenerator**：将草稿转化为 Coze 工作流 JSON（CozeWorkflow）
- **WorkflowRepairer**：根据错误信息修复已有工作流

### MCP 层（apps/api/src/mcp/）

- **CozeClient**：封装 Coze 平台 API 调用
- 统一处理认证、超时、错误重试
- 后续可通过 MCP 协议暴露为 Agent 工具

### Schema 层（packages/workflow-schema/）

- 定义 Coze 工作流的完整类型（CozeWorkflow, CozeNode, CozeEdge）
- 提供预置工作流模板（减少 LLM 幻觉）
- 提供本地校验器（减少无效 API 调用）

### Prompt 层（apps/api/src/prompts/）

- 集中管理所有 Prompt 模板
- 与业务逻辑分离，便于独立调整和 A/B 测试

## 数据流

```
UserRequirement
    │
    ▼
WorkflowPlanner.plan()
    │ 使用 planPrompt
    │ 调用 LLM
    ▼
WorkflowDraft（抽象草稿）
    │
    ▼
WorkflowGenerator.generate()
    │ 使用 generatePrompt
    │ 结合 workflow-schema 模板
    │ 调用 LLM 填充细节
    ▼
CozeWorkflow（完整 JSON）
    │
    ▼
validateWorkflow()（本地校验）
    │
    ├── 失败 → WorkflowRepairer.repair() → 重新生成
    │
    ▼ 通过
CozeClient.createWorkflow()（调用 Coze API）
    │
    ▼
Coze 工作流 ID（返回给用户）
```

## 技术选型说明

| 选择            | 原因                             |
| --------------- | -------------------------------- |
| pnpm workspaces | 轻量 monorepo，不需要额外工具    |
| Express + tsx   | 简单可靠，tsx 支持直接运行 TS    |
| Vite + React    | 快速开发体验，HMR 即时生效       |
| 不用 turborepo  | 保持简单，当前规模不需要增量构建 |
