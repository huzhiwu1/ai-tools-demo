# Coze 工作流自动生成 Agent

> 基于 LangChain + LangGraph 的 AI Agent 项目，通过自然语言描述自动生成 Coze 平台工作流。

## 项目目标

1. 接收用户自然语言需求
2. 由 LLM 规划工作流草图
3. 生成 Coze 工作流节点 JSON
4. 通过 MCP 调用内部 Coze 接口创建 / 保存 / 试运行工作流
5. 后续扩展成可修复已有工作流的 Agent

## 技术栈

| 层级     | 技术                          |
| -------- | ----------------------------- |
| 语言     | TypeScript                    |
| 前端     | React 18 + Vite               |
| 后端     | Express + tsx                 |
| AI 编排  | LangChain + LangGraph（预留） |
| 包管理   | pnpm workspaces               |
| 类型校验 | Zod（预留）                   |

## 目录结构

```
agent-coze-workflow/
├── apps/
│   ├── web/                  # React 前端应用
│   │   ├── src/
│   │   │   ├── components/   # UI 组件（Header, InputPanel, WorkflowCanvas...）
│   │   │   ├── pages/        # 页面（预留）
│   │   │   ├── hooks/        # 自定义 hooks（预留）
│   │   │   ├── styles/       # 全局样式
│   │   │   └── App.tsx       # 根组件
│   │   ├── index.html
│   │   └── vite.config.ts
│   └── api/                  # Express 后端 API
│       ├── src/
│       │   ├── routes/       # 路由（健康检查 & 业务 API）
│       │   ├── services/     # 业务服务层（预留）
│       │   ├── agents/       # LangChain/LangGraph Agent（预留）
│       │   ├── mcp/          # MCP Client（Coze 平台调用封装）
│       │   ├── schema/       # 工作流 Schema 定义（预留）
│       │   ├── validator/    # 工作流校验器（预留）
│       │   ├── prompts/      # Prompt 模板（系统提示词、规划、生成、修复）
│       │   └── index.ts      # 服务入口
│       └── package.json
├── packages/
│   ├── shared/               # 共享类型和工具
│   │   ├── src/
│   │   │   ├── types/        # 通用类型定义
│   │   │   ├── constants/    # 全局常量
│   │   │   └── utils/        # 工具函数
│   │   └── package.json
│   └── workflow-schema/      # 工作流 Schema 包
│       ├── src/
│       │   ├── types/        # Coze 工作流节点类型定义
│       │   ├── templates/    # 预置工作流模板
│       │   └── validator/    # 本地校验器
│       └── package.json
├── docs/                     # 文档
│   ├── architecture.md       # 架构设计文档
│   ├── mvp-plan.md           # MVP 开发计划
│   └── interview-notes.md    # 需求访谈记录
├── .env.example              # 环境变量模板
├── pnpm-workspace.yaml       # pnpm workspace 配置
├── tsconfig.base.json        # 基础 TypeScript 配置
└── README.md
```

## 设计思想

本项目不是普通 CRUD 应用，而是承载 AI Agent 编排的工程骨架。核心分离原则：

| 分离维度               | 说明                                                       |
| ---------------------- | ---------------------------------------------------------- |
| Agent 与工具层分离     | Agent 负责编排 LLM 调用，工具层封装 Coze API               |
| Prompt 与业务逻辑分离  | Prompt 集中管理在 `prompts/` 目录，便于调整和 A/B 测试     |
| Schema 与执行分离      | 工作流类型定义在 `workflow-schema` 包，执行逻辑在 Agent 层 |
| 校验与生成分离         | Generator 负责生成，Validator 负责校验                     |
| 前端展示与后端编排分离 | 前端只做 UI 展示，Agent 编排在后端                         |

## 如何启动

### 前置要求

- Node.js >= 18.0.0
- pnpm >= 8.0.0

### 安装依赖

```bash
cd agent-coze-workflow
pnpm install
```

### 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 填入你的 API Key
```

### 启动开发服务

```bash
# 同时启动前后端
pnpm dev

# 或分别启动
pnpm dev:api   # 后端 http://localhost:3000
pnpm dev:web   # 前端 http://localhost:5173
```

### 验证

- 后端健康检查：`curl http://localhost:3000/health`
- 前端页面：浏览器打开 `http://localhost:5173`

## 当前完成状态

### 已完成

- [x] 项目骨架搭建（monorepo + pnpm workspaces）
- [x] TypeScript 配置（tsconfig.base.json + 各包配置）
- [x] 共享类型包（@coze-workflow/shared）
- [x] 工作流 Schema 包（@coze-workflow/workflow-schema）
- [x] 后端 Express 服务 + 健康检查接口
- [x] 前端 React 三栏布局骨架
- [x] Agent 层预留（workflow-planner, workflow-generator, workflow-repairer）
- [x] MCP 层预留（cozeClient + types）
- [x] Schema/Validator 层预留
- [x] Prompt 模板预留（system, plan, generate, repair）
- [x] 基础脚本（dev, build, test, lint, typecheck）

### 待完成

- [ ] 集成 LangChain ChatOpenAI
- [ ] 实现 WorkflowPlanner（ReAct 循环）
- [ ] 实现 WorkflowGenerator（模板 + LLM 填充）
- [ ] 实现 WorkflowRepairer（修复循环）
- [ ] 实现 MCP 真实 Coze API 调用
- [ ] 前端接入后端 API
- [ ] 前端工作流画布（ReactFlow）
- [ ] Zod schema 校验
- [ ] 流式输出 SSE
- [ ] 单元测试 + 集成测试
- [ ] 错误处理与重试

## 下一步计划

1. **集成 LLM**：引入 LangChain，实现 WorkflowPlanner
2. **实现生成**：通过模板 + LLM 实现 WorkflowGenerator
3. **接入 Coze**：实现 MCP 层真实 API 调用
4. **前端联调**：前后端对接，实现端到端流程
5. **修复闭环**：实现 WorkflowRepairer，支持自动修复

## 常用脚本

| 命令             | 说明                   |
| ---------------- | ---------------------- |
| `pnpm dev`       | 同时启动前后端开发服务 |
| `pnpm dev:api`   | 仅启动后端             |
| `pnpm dev:web`   | 仅启动前端             |
| `pnpm build`     | 构建所有包             |
| `pnpm test`      | 运行测试               |
| `pnpm lint`      | 代码检查               |
| `pnpm typecheck` | TypeScript 类型检查    |
