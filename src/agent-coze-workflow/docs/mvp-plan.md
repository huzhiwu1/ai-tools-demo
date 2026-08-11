# MVP 开发计划

## Phase 1：项目骨架（已完成）

- [x] 初始化 monorepo 结构
- [x] 配置 TypeScript
- [x] 创建共享类型包
- [x] 创建前端 React 骨架
- [x] 创建后端 Express 骨架
- [x] 预留 Agent / MCP / Schema / Validator / Prompt 目录
- [x] 编写基础文档

## Phase 2：核心 Agent 实现

- [ ] 集成 LangChain ChatOpenAI
- [ ] 实现 WorkflowPlanner（ReAct 循环）
- [ ] 实现 WorkflowGenerator（模板 + LLM 填充）
- [ ] 实现 WorkflowRepairer（修复循环）
- [ ] 使用 Zod 定义结构化输出 schema

## Phase 3：MCP 集成

- [ ] 实现 CozeClient 真实 API 调用
- [ ] 实现工作流创建、试运行接口
- [ ] 添加错误处理和重试机制

## Phase 4：前端联调

- [ ] 前端接入后端 API
- [ ] 实现工作流画布（ReactFlow）
- [ ] 实现流式输出展示（SSE）
- [ ] 实现执行日志实时展示

## Phase 5：完善与优化

- [ ] 添加单元测试
- [ ] 添加集成测试
- [ ] 错误处理完善
- [ ] 性能优化
- [ ] 文档完善
