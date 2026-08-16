# MCP：Agent 工具生态的标准化协议

## 背景：工具集成的"巴别塔"

没有 MCP 之前，每个 Agent 框架都有自己的工具接入方式：

- LangChain 有 `@tool` 装饰器
- OpenAI 有 Function Calling 的 JSON schema
- 每个 Agent 平台各写各的客户端

结果是同一套 Coze 工作流操作，要为 LangGraph 写一遍、为 Claude 写一遍、为 Codex 写一遍。**MCP（Model Context Protocol，模型上下文协议）就是为了解决这个重复而生的开放标准。**

MCP 由 Anthropic 于 2024 年底提出，目标是：**把"工具、资源、提示词"用统一协议暴露，任何支持 MCP 的客户端都能直接使用。**

## MCP 的架构

```
┌──────────┐   MCP 协议   ┌──────────┐   HTTP/API   ┌──────────┐
│  Host    │ ───────────► │  Server  │ ───────────► │  Service │
│ (客户端) │  JSON-RPC     │ (工具容器)│               │ (Coze)   │
└──────────┘              └──────────┘               └──────────┘
   LangGraph / Claude / Codex ...
```

三个角色：

| 角色 | 职责 | 例子 |
| ---- | ---- | ---- |
| Host | 运行 LLM 和 Agent，消费 MCP 能力 | Claude Desktop、Codex、LangGraph Agent |
| Server | 暴露工具/资源/提示词，翻译协议 | 本项目的 `coze-workflow-mcp` |
| Transport | 通信通道 | stdio（本地进程）、HTTP/SSE（远程） |

Server 暴露三类能力：

1. **Tools**：可执行的操作（创建、保存、试运行）
2. **Resources**：可读取的数据（工作流 schema、文档）
3. **Prompts**：可复用的提示词模板

## 本项目中的 MCP Server

`apps/api/src/coze/mcp-server.ts` 把 CozeClient 的工作流操作包装成标准 MCP 工具：

```ts
const server = new McpServer({
  name: "coze-workflow-mcp",
  version: "1.0.0",
});

server.registerTool(
  "coze_create_workflow",
  {
    description: "在 Coze 平台创建空白工作流骨架，返回 workflow_id",
    inputSchema: { name: z.string(), desc: z.string() },
  },
  async ({ name, desc }) => coze.createWorkflow(name, desc),
);
```

注释里写得很清楚：

> 将 CozeClient 的工作流操作暴露为标准 MCP 工具，供 MCP 客户端（LangGraph agent、Qoder、Claude、Codex 等）通过协议调用，而不是直接 HTTP 调用。

也就是说：**平台能力只实现一遍（CozeClient），但通过 MCP 可以被所有 AI 客户端复用。** 这是"一次实现，处处可用"的价值。

## MCP 与普通工具封装的区别

| 维度 | 普通 HTTP 封装 | MCP Server |
| ---- | ------------- | ---------- |
| 协议 | 各框架自定 | 统一 JSON-RPC 标准 |
| 客户端 | 只能自己用 | 任何 MCP 客户端可用 |
| 能力发现 | 手动写文档 | 客户端可自动列举工具 |
| 输入校验 | 各写各的 | schema 内建（Zod） |
| 复用范围 | 单项目 | 跨 Agent 平台、跨工具 |

注意：**MCP 不是替代 HTTP API，而是给 HTTP API 套了一层"AI 友好的标准外壳"。** 项目里 MCP server 底层依然是 CozeClient 调 Coze API。

## MCP 带来的实际收益

### 1. 工具即插即用

同一个 `coze-workflow-mcp`，可以同时被项目内的 LangGraph Agent 和项目外的 Qoder / Claude / Codex 连接。写 Agent 的人不再需要懂 Coze 的接口细节。

### 2. 能力自描述

MCP 工具自带 description + schema，LLM 可以直接"看到"有哪些工具、怎么调用。这就是 Agent 的"手"能够被"大脑"指挥的协议基础。

### 3. 本地优先、安全可控

stdio transport 下，MCP server 是本地子进程，凭证（`COZE_SESSION_KEY`）留在服务端环境变量里，不暴露给远端客户端。

## 什么时候该上 MCP

适用：

- 你的能力要被**多个 AI 客户端**复用
- 你希望工具接入方式**标准化**，不绑定某个框架
- 你在做企业级 Agent 基础设施（把内部系统统一暴露给 AI）

不适用：

- 只有单个框架、单个 Agent 在用——直接封装工具即可，多一层协议多一层复杂度
- 需要极低延迟、超高吞吐——协议开销值得评估

## 核心要点

- MCP 是"AI 工具接入"的标准化协议，解决每个框架各写一套的问题
- 三角色：Host（用能力）、Server（给能力）、Transport（传消息）
- 一次实现（CozeClient）→ 处处使用（LangGraph / Claude / Codex）
- MCP 是给 HTTP API 套标准外壳，不是替代品
- 单客户端场景直接封装工具，多客户端场景才值得上 MCP

## 延伸思考

- MCP 和 Function Calling 是什么关系？（提示：Function Calling 是"模型输出结构"，MCP 是"工具如何暴露"，两者互补）
- 如果要把公司内部 10 个系统暴露给 AI，MCP server 应该按系统拆还是聚合一个？各有什么权衡？
