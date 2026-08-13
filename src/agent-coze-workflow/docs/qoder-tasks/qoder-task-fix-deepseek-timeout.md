# Qoder Task: 修复 DeepSeekClient 超时过短导致规划/代码生成失败

## 背景

agent-coze-workflow 的 AI Agent 使用 DeepSeekClient（基于 LangChain ChatOpenAI）做三类 LLM 调用：

1. `plan_workflow` 工具 → `WorkflowPlanner.plan()`：把用户需求规划成工作流（steps + contracts + startInputs + nodeConfig 结构化 JSON）
2. `generate_workflow` 工具 → `CodeGenerator.generateCode()`：为代码节点生成 Python 代码
3. `update_workflow` 工具 → `parseInstruction()`：把自然语言修改指令解析为结构化指令

## 问题

模型已切换到 **dachensky 网关的 deepseek-v4-flash**（思考模型，返回 reasoning_content）。但 `DeepSeekClient` 的超时配置仍是 **10 秒**，思考模型生成复杂 JSON 经常超时：

- 实测日志：简单规划任务耗时 **16434ms**（16.4 秒）> 10 秒配置，已超时 60%
- 复杂任务（多节点 + 参考数据匹配）思考更久，必挂
- 超时 → `chatStructured` 抛异常 → `plan.tool.ts` catch 返回 `规划失败: timeout...` → LLM 放弃规划，行为不可控

## 改动文件

- `apps/api/src/llm/deepseek.client.ts`（唯一需要改的文件）

## 现状代码（关键部分）

```typescript
// apps/api/src/llm/deepseek.client.ts 构造器内（约 58-66 行）
this.modelName = modelName;
this.model = new ChatOpenAI({
  apiKey,
  configuration: { baseURL },
  model: modelName,
  temperature: 0.2,
  maxRetries: 1,
  timeout: 10_000,   // ← 10 秒，太短
});
```

## 修改要求

1. **超时提高到 60 秒**（`timeout: 60_000`），思考模型规划/代码生成需要足够时间
2. **支持构造函数按用途覆盖**：`DeepSeekConfig` 增加可选 `timeout?: number` 字段，构造时 `config?.timeout ?? 60_000`——这样以后某个调用方需要更长/更短超时可以单独传，不用改默认
3. 其他字段（apiKey/baseUrl/model/temperature/maxRetries）不动
4. 同步更新文件头注释里对超时的描述（现在是 `timeout: 10000`，改成 `timeout: 60000`，并注明"思考模型需要更长时间"）

## 验收标准

1. `pnpm --filter @coze-workflow/api typecheck` 通过
2. 直接跑一次规划验证（不启动完整服务）：
   ```bash
   cd src/agent-coze-workflow
   cat > apps/api/test-plan.ts <<'EOF'
   import { config } from "dotenv";
   config({ path: require("path").join(__dirname, "../../.env") });
   import { WorkflowPlanner } from "./src/workflow-engine/planner";
   import { DeepSeekClient } from "./src/llm/deepseek.client";
   async function main() {
     console.log("model:", process.env.LLM_MODEL);
     const planner = new WorkflowPlanner(new DeepSeekClient());
     const start = Date.now();
     const plan = await planner.plan({ description: "接收用户输入一个音频链接，用大模型识别歌词，再用代码节点和参考歌词库匹配判断是哪首歌" });
     console.log("耗时(ms):", Date.now() - start);
     console.log("steps:", plan.steps.map(s => s.nodeType).join(" → "));
   }
   main().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
   EOF
   pnpm --filter @coze-workflow/api exec tsx test-plan.ts
   ```
   预期：规划成功（不超时），打印 steps 顺序，删除该测试文件
3. 无其他文件改动（不要顺手改 plan-prompt / schema-converter / 前端）

## 注意

- 只改 `deepseek.client.ts` 一个文件
- 测试脚本跑完记得删除 `apps/api/test-plan.ts`
- 不要提交 `.env`（含密钥）
