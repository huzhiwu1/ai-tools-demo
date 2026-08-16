# AI Agent 知识点系列文章

> 一套面向开发者的 AI Agent 入门与进阶知识文章，结合本项目（Coze 工作流自动生成 Agent，LangChain + LangGraph）的真实实现讲解，避免只讲概念不落地。

## 文章列表

| # | 文章 | 核心知识点 |
| - | ---- | ---------- |
| 1 | [什么是 AI Agent](01-what-is-ai-agent.md) | Agent 的定义、组成要素、与 LLM/工作流的区别 |
| 2 | [ReAct 循环：Agent 的心脏](02-react-loop.md) | 思考-行动-观察循环、终止条件、LangGraph 实现 |
| 3 | [工具调用：Agent 的双手](03-tool-calling.md) | Function Calling 原理、工具设计、参数句柄化 |
| 4 | [记忆与状态管理](04-memory-and-state.md) | 短期/长期/工作记忆、checkpointer、会话恢复 |
| 5 | [规划：从"走一步看一步"到"先想后做"](05-planning.md) | 计划与执行分离、两段式规划、澄清机制 |
| 6 | [MCP：Agent 工具生态的标准化协议](06-mcp.md) | MCP 架构、Server/Client/Host、项目实践 |
| 7 | [Agent 可靠性工程](07-reliability.md) | 失败模式、分层防御、验证闭环、可观测性 |
| 8 | [Agent 框架选型与效果评估](08-framework-and-eval.md) | LangGraph 图模型、评估指标、上线运营 |

## 阅读建议

- 想快速建立全局认知：先读 1、2、3
- 想理解本项目代码：配合 [ReAct 思考链路全景图](../react-agent-thinking-chain.md) 读 2、4、5
- 想设计自己的 Agent 系统：重点读 3、6、7
- 每篇末尾都有「核心要点」和「延伸思考」，可作为面试或讨论素材

## 对应代码位置

文章里引用的代码都来自本仓库，关键文件：

| 主题 | 代码 |
| ---- | ---- |
| ReAct 循环 / 会话 | `apps/api/src/agent/react-agent.service.ts` |
| 工具注册 | `apps/api/src/agent/tools/index.ts` |
| 澄清中断 | `apps/api/src/agent/tools/clarify.tool.ts` |
| 规划提示词 | `apps/api/src/prompts/plan-prompt.ts` |
| MCP Server | `apps/api/src/coze/mcp-server.ts` |
| 工作流操作 | `apps/api/src/agent/operations/` |
