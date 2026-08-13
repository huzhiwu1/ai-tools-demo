# Qoder 任务：架构重构 —— 模块组织优化（纯重构，不改业务逻辑）

> 项目：`/Users/huzhiwu/workspace/ai-tools-demo/src/agent-coze-workflow`
> 技术栈：NestJS 11 + pnpm workspace
> **目标：解决模块命名混乱（agent/ vs agents/）、职责边界模糊、旧链路残留问题。纯文件移动 + import 路径更新，不改变任何业务逻辑、不改变接口行为。**

---

## 一、当前架构与问题

```
apps/api/src/
├── agent/            ← 新链路 ReAct（保留，不动）
│   ├── react-agent.module.ts / service.ts / controller.ts
│   ├── session.store.ts
│   └── tools/（8 个工具 + coze-client.ts 单例 + index.ts）
├── agents/           ← ❌ 混乱根源：混着"被新链路复用的能力"和"旧链路"
│   ├── graph.ts                （旧链路编排）
│   ├── workflow-planner.ts     （被新链路 plan.tool 复用 ✅）
│   ├── workflow-generator.ts   （被新链路 generate.tool 复用 ✅）
│   ├── workflow-repairer.ts    （旧链路）
│   ├── agents.module.ts        （旧链路 DI 注册）
│   ├── types.ts                （planner 的输出 schema，被 planner 引用）
│   └── index.ts                （死代码，见清理任务）
├── llm/              ← DeepSeek 客户端（保留，不动）
│   └── deepseek.client.ts
├── mcp/              ← ❌ 名字不准：不是标准 MCP，是 Coze 平台接入
│   ├── mcp.module.ts / cozeClient.ts / schema-converter.ts / mcp-server.ts / types.ts
├── workflow/         ← ❌ 旧 HTTP 接口（前端已不用，属旧链路）
│   ├── workflow.module.ts / service.ts / controller.ts
├── prompts/          ← prompt 常量（被 planner 和 repairer 共用，保留顶层）
│   ├── index.ts / system-prompt.ts / plan-prompt.ts / sketch-prompt.ts / generate-prompt.ts / repair-prompt.ts
├── schema/ + validator/ ← 死代码（清理任务已出，本次重构忽略）
├── app.module.ts / app.controller.ts / app.service.ts / main.ts
```

**问题**：agent/ 与 agents/ 只差一个 s；agents/ 里新旧混装；mcp/ 名不副实；workflow/ 是死接口占位。

---

## 二、目标架构

```
apps/api/src/
├── app.module.ts
├── agent/                    ← ReAct Agent 编排（不动）
│   └── ...（原样保留）
├── coze/                     ← 原 mcp/ 改名（Coze 平台接入）
│   ├── coze.module.ts        ← 原 mcp.module.ts（类名 McpModule → CozeModule）
│   ├── coze.client.ts        ← 原 cozeClient.ts
│   ├── schema-converter.ts   ← 原样移动
│   ├── mcp-server.ts         ← 原样移动（独立 stdio server，依赖本目录 client）
│   └── types.ts              ← 原样移动
├── workflow-engine/          ← 原 agents/ 里被新链路复用的能力（拆出）
│   ├── planner.ts            ← 原 workflow-planner.ts
│   ├── generator.ts          ← 原 workflow-generator.ts
│   └── types.ts              ← 原 agents/types.ts（planner 依赖的 LLMPlanOutputSchema）
├── llm/                      ← DeepSeek 客户端（不动）
│   └── deepseek.client.ts
├── prompts/                  ← prompt 常量（不动，被 workflow-engine 和 legacy 共用）
│   └── ...（原样保留）
├── legacy/                   ← 原 agents/ 旧链路 + 原 workflow/ 合并归档
│   ├── graph.ts              ← 原 agents/graph.ts
│   ├── workflow-repairer.ts  ← 原 agents/workflow-repairer.ts
│   ├── workflow.controller.ts← 原 workflow/workflow.controller.ts
│   ├── workflow.service.ts   ← 原 workflow/workflow.service.ts
│   └── workflow.module.ts    ← 合并后的旧链路模块（原 agents.module + 原 workflow.module 合并，类名 LegacyModule）
└── main.ts
```

**设计说明**：
- `workflow-engine/`：planner/generator 是"工作流构建能力"，被新链路工具直接 new（不走 DI），所以不需要 Nest 模块，纯类文件
- `legacy/`：旧链路整块归档，保留 `/workflow/*` HTTP 接口行为不变（前端虽不用，但保留教学价值 + 不破坏 API）
- `coze/`：Coze 平台接入，比 mcp/ 名字准确（mcp-server.ts 是"把 CozeClient 暴露成 MCP 工具"的独立入口，仍依赖本目录，保留）
- `prompts/` 和 `llm/` 保留顶层：被新旧多处共用，移动收益低、改动面大

---

## 三、文件移动清单（照此执行）

### 1. mcp/ → coze/（改名 + 移动）

| 原文件 | 新文件 | 类/导出名变化 |
|---|---|---|
| `mcp/mcp.module.ts` | `coze/coze.module.ts` | `McpModule` → `CozeModule` |
| `mcp/cozeClient.ts` | `coze/coze.client.ts` | 无（类名 CozeClient 不变） |
| `mcp/schema-converter.ts` | `coze/schema-converter.ts` | 无 |
| `mcp/mcp-server.ts` | `coze/mcp-server.ts` | 无 |
| `mcp/types.ts` | `coze/types.ts` | 无 |

**import 更新（这些文件引用了 mcp/）：**
- `agent/tools/save.tool.ts`：`../../mcp/schema-converter` → `../../coze/schema-converter`
- `agent/tools/coze-client.ts`：`../../mcp/cozeClient` → `../../coze/coze.client`
- `app.module.ts`：`./mcp/mcp.module` → `./coze/coze.module`；`McpModule` → `CozeModule`
- `legacy/workflow.module.ts`（见下）：`../mcp/mcp.module` → `../coze/coze.module`
- `legacy/workflow.service.ts`：`../mcp/cozeClient` → `../coze/coze.client`；`../mcp/schema-converter` → `../coze/schema-converter`

### 2. agents/ 拆分为 workflow-engine/ + legacy/

**移入 workflow-engine/（被新链路复用）：**
| 原文件 | 新文件 |
|---|---|
| `agents/workflow-planner.ts` | `workflow-engine/planner.ts` |
| `agents/workflow-generator.ts` | `workflow-engine/generator.ts` |
| `agents/types.ts` | `workflow-engine/types.ts` |

**import 更新：**
- `workflow-engine/planner.ts`：`./types` → `./types`（同目录不变）；`../prompts/plan-prompt` → `../../prompts/plan-prompt`；`../llm/deepseek.client` → `../llm/deepseek.client`（不变）
- `workflow-engine/generator.ts`：内部 import 不变（只依赖 shared/workflow-schema 包）
- `agent/tools/plan.tool.ts`：`../../agents/workflow-planner` → `../../workflow-engine/planner`
- `agent/tools/generate.tool.ts`：`../../agents/workflow-generator` → `../../workflow-engine/generator`

**移入 legacy/（旧链路）：**
| 原文件 | 新文件 |
|---|---|
| `agents/graph.ts` | `legacy/graph.ts` |
| `agents/workflow-repairer.ts` | `legacy/workflow-repairer.ts` |
| `workflow/workflow.controller.ts` | `legacy/workflow.controller.ts` |
| `workflow/workflow.service.ts` | `legacy/workflow.service.ts` |
| `workflow/workflow.module.ts` | `legacy/workflow.module.ts` |
| `agents/agents.module.ts` | （内容合并进 legacy/workflow.module.ts 后删除） |

**legacy/workflow.module.ts 合并逻辑（重点）：**
原 agents.module.ts 的 providers（DeepSeekClient / WorkflowPlanner / WorkflowGenerator / WorkflowRepairer / WORKFLOW_GRAPH）**全部并入** legacy/workflow.module.ts，模块类改名为 `LegacyModule`：

```ts
// legacy/workflow.module.ts
import { Module } from "@nestjs/common";
import { DeepSeekClient } from "../llm/deepseek.client";
import { WorkflowPlanner } from "../workflow-engine/planner";
import { WorkflowGenerator } from "../workflow-engine/generator";
import { WorkflowRepairer } from "./workflow-repairer";
import { createWorkflowGraph } from "./graph";
import { WorkflowController } from "./workflow.controller";
import { WorkflowService } from "./workflow.service";
import { CozeModule } from "../coze/coze.module";

@Module({
  imports: [CozeModule],
  controllers: [WorkflowController],
  providers: [
    { provide: DeepSeekClient, useFactory: () => new DeepSeekClient() },
    {
      provide: WorkflowPlanner,
      useFactory: (c: DeepSeekClient) => new WorkflowPlanner(c),
      inject: [DeepSeekClient],
    },
    { provide: WorkflowGenerator, useFactory: () => new WorkflowGenerator() },
    {
      provide: WorkflowRepairer,
      useFactory: (c: DeepSeekClient) => new WorkflowRepairer(c),
      inject: [DeepSeekClient],
    },
    {
      provide: "WORKFLOW_GRAPH",
      useFactory: (p: WorkflowPlanner, g: WorkflowGenerator, r: WorkflowRepairer) =>
        createWorkflowGraph(p, g, r),
      inject: [WorkflowPlanner, WorkflowGenerator, WorkflowRepairer],
    },
  ],
  exports: [
    DeepSeekClient,
    WorkflowPlanner,
    WorkflowGenerator,
    WorkflowRepairer,
    "WORKFLOW_GRAPH",
  ],
})
export class LegacyModule {}
```

**import 更新：**
- `legacy/workflow.service.ts`：`../agents/workflow-planner` → `../workflow-engine/planner`；`../agents/graph` → `./graph`；`../mcp/cozeClient` → `../coze/coze.client`；`../mcp/schema-converter` → `../coze/schema-converter`
- `legacy/graph.ts`：`./workflow-repairer` → `./workflow-repairer`（同目录不变）
- `legacy/workflow-repairer.ts`：`../prompts/repair-prompt` → `../../prompts/repair-prompt`；`../llm/deepseek.client` → `../llm/deepseek.client`（不变）
- `app.module.ts`：`./agents/agents.module` + `./workflow/workflow.module` → `./legacy/workflow.module`；`AgentsModule` → `LegacyModule`（imports 里只留一个 LegacyModule 替代原来的 WorkflowModule + AgentsModule）

### 3. 删除

- `agents/` 目录（拆分后清空删除）
- `workflow/` 目录（移空删除）
- `mcp/` 目录（改名后清空删除）

### 4. 其他文件不动

- `agent/` 全部、`llm/`、`prompts/`、`app.controller.ts`、`app.service.ts`、`main.ts`

---

## 四、实施顺序

1. 建 `coze/`，移动 mcp/ 5 个文件，改类名/import（改一处 typecheck 一次，先收口）
2. 建 `workflow-engine/`，移动 planner/generator/types，更新 import
3. 建 `legacy/`，移动 graph/repairer/workflow 三件套，合并 module 为 LegacyModule
4. 更新 `app.module.ts`（CozeModule + LegacyModule，去掉 McpModule/AgentsModule/WorkflowModule）
5. 删除空目录 agents/ workflow/ mcp/
6. 全量 typecheck + build + 冒烟

---

## 五、验收标准

1. `pnpm typecheck` 全绿；`pnpm build` 全绿
2. `apps/api/src/` 下不再有 `agents/`、`mcp/`、`workflow/` 目录
3. 接口行为不变（冒烟测试）：
   - `GET /health` 正常
   - `POST /workflow/run` 仍可用（旧链路，返回 plan/sketch/workflow/validation）
   - `POST /api/agent/chat` 仍正常（新链路 SSE Data Stream）
   - `POST /api/agent/upload` 仍正常
4. 启动日志无报错、无循环依赖警告

---

## 六、红线

- ❌ 不改变任何业务逻辑（planner/generator/repairer/cozeClient 的实现代码一个字符不改，只动 import 和文件路径）
- ❌ 不改变 HTTP 路由（/workflow/* 和 /api/agent/* 路径保持原样）
- ❌ 不加新依赖、不删功能
- ❌ 不动 agent/（新链路）、llm/、prompts/ 的内容
- ✅ 类名只改这两处：`McpModule` → `CozeModule`、`AgentsModule` 合并进 `LegacyModule`（其余类名不动）
- ✅ 每移动一组文件就跑一次 `pnpm --filter @coze-workflow/api typecheck`，避免最后一次性排错

---

## 七、参考：完整引用关系（Qoder 自查用）

- `prompts/plan-prompt` ← workflow-engine/planner
- `prompts/repair-prompt` ← legacy/workflow-repairer
- `llm/deepseek.client` ← workflow-engine/planner、legacy/workflow-repairer、legacy/module、agent/tools/plan.tool
- `coze/coze.client` ← agent/tools/coze-client、agent/tools/save.tool（间接）、legacy/workflow.service
- `coze/schema-converter` ← agent/tools/save.tool、legacy/workflow.service
- `workflow-engine/planner` ← agent/tools/plan.tool、legacy/workflow.service
- `workflow-engine/generator` ← agent/tools/generate.tool、legacy/module
- `legacy/graph` ← legacy/module、legacy/workflow.service
