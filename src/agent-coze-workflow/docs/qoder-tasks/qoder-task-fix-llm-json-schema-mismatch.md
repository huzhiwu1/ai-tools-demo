# Qoder Task: 修复 jsonMode 下 LLM 输出与 zod schema 不匹配（改用手动 json_schema）

## 背景

上一个任务把 DeepSeekClient 超时修好了（10s → 60s）。但暴露独立问题：**deepseek-v4-flash 在 jsonMode 下输出格式不稳定**，实测 3 次规划全部 zod 解析失败（constraints 输出字符串、steps 用 type 代替 nodeType、contracts 用 input/output 代替 inputs/outputs）。

**已做过的排查（结论直接采用，不要重新踩坑）：**

1. ❌ `functionCalling` 方法：网关思考模式不支持 `tool_choice=required/object`（实测 400 InvalidParameter）
2. ❌ `jsonMode`（response_format json_object）：只保证是 JSON，不保证 schema，字段漂移 3/3 全挂
3. ✅ **手动 json_schema**：`toJsonSchema(schema)` 转纯 JSON schema → `invoke(response_format: {type:"json_schema", strict:true})` → 实测成功（8.5s，safeParse 通过，字段完全符合 schema）
4. ⚠️ 注意：不要用 `withStructuredOutput(schema, {method:"jsonSchema"})`——LangChain 对复杂 zod schema 会走 OpenAI SDK 的 zod helper，内部转成 tool_choice，网关同样拒绝（实测 400）。**必须手动传纯 JSON schema 对象**

## 修改文件

- `apps/api/src/llm/deepseek.client.ts`（唯一需要改的文件）

## 修改要求

把 `chatStructured()` 的 withStructuredOutput 逻辑替换为手动 json_schema 流程：

```typescript
async chatStructured<T extends z.ZodTypeAny>(
  schema: T,
  systemPrompt: string,
  userPrompt: string,
  maxRetries = 1,  // 解析失败自动重试次数
): Promise<z.infer<T>> {
  // 1. zod schema → 纯 JSON schema（不传 zod 对象给 OpenAI SDK，绕开 zod helper 的 tool_choice 路径）
  //    import { toJsonSchema } from "@langchain/core/utils/json_schema";
  const asJsonSchema = toJsonSchema(schema) as Record<string, unknown>;

  // 2. 循环重试：最多 maxRetries + 1 次
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await this.model.invoke(
        [
          new SystemMessage(
            systemPrompt +
              "\n必须输出 JSON 对象，不要输出其他内容。constraints/riskHints 必须是字符串数组；steps 节点类型字段名是 nodeType；contracts 输入字段是 inputs、输出是 outputs。",
          ),
          new HumanMessage(userPrompt),
        ],
        {
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "extract",
              description: "结构化输出",
              schema: asJsonSchema,
              strict: true,
            },
          },
        } as unknown as ConstructorParameters<typeof ChatOpenAI>[0] extends never ? never : never,
      );

      // 3. 提取 content → JSON.parse → schema.safeParse
      const content =
        typeof res.content === "string"
          ? res.content
          : JSON.stringify(res.content);
      const parsed = JSON.parse(content.trim());
      const checked = schema.safeParse(parsed);
      if (checked.success) {
        this.logger.log(
          `[DeepSeek] chatStructured ok ${Date.now() - start}ms model=${this.modelName}`,
        );
        return checked.data as z.infer<T>;
      }
      // zod 校验失败：记录原因，继续重试
      this.logger.debug(
        `[DeepSeek] chatStructured zod 校验失败 (attempt ${attempt + 1}): ` +
          JSON.stringify(checked.error.issues.slice(0, 3)),
      );
    } catch (e) {
      this.logger.debug(
        `[DeepSeek] chatStructured 解析失败 (attempt ${attempt + 1}): ${(e as Error).message.slice(0, 200)}`,
      );
    }
  }

  // 4. 重试耗尽：抛错（消息含最后 zod 错误摘要，前 200 字符，给调用方排查线索）
  throw new Error(`chatStructured 结构化输出失败（已重试 ${maxRetries} 次）`);
}
```

关键实现细节：

- `start` 时间戳在方法开头记录（现有代码有，保留）
- 保留现有成功日志格式 `chatStructured ok {ms}ms model=...`
- **不要**在 invoke 的 options 上显式写 `tool_choice`、`tools`（思考模式不支持）
- `strict: true` 必须保留（网关实测 strict 模式字段约束最强）
- `toJsonSchema` 从 `@langchain/core/utils/json_schema` 导入
- invoke 的 options 类型如果 TS 报错，用 `as unknown as any` 兜底（response_format 不是标准 CallOptions 字段，但 OpenAI 兼容端接受）
- `DeepSeekClient` 构造器和其他部分不动

## 验收标准

1. `pnpm --filter @coze-workflow/api typecheck` 通过
2. 连续跑 5 次规划测试（重点验证**稳定性**）：

   ```bash
   cd src/agent-coze-workflow
   cat > apps/api/test-plan.ts <<'EOF'
   import { config } from "dotenv";
   config({ path: require("path").join(__dirname, "../../.env") });
   import { WorkflowPlanner } from "./src/workflow-engine/planner";
   import { DeepSeekClient } from "./src/llm/deepseek.client";
   async function main() {
     const planner = new WorkflowPlanner(new DeepSeekClient());
     const start = Date.now();
     const plan = await planner.plan({ description: "接收用户输入一个音频链接，用大模型识别歌词，再用代码节点和参考歌词库匹配判断是哪首歌" });
     console.log("耗时(ms):", Date.now() - start);
     console.log("steps:", plan.steps.map(s => s.nodeType).join(" → "));
     console.log("OK");
   }
   main().catch(e => { console.error("FAIL:", e.message.slice(0, 300)); process.exit(1); });
   EOF
   for i in 1 2 3 4 5; do
     echo "=== run $i ==="
     pnpm --filter @coze-workflow/api exec tsx test-plan.ts 2>&1 | grep -E "耗时|steps|OK|FAIL"
   done
   ```

   预期：**5 次全部输出 OK**（有 FAIL 即为不过关）。
   ⚠️ 注意：steps 顺序可能是 `code → llm → code`（模型规划问题，与本次格式修复无关），只要格式解析成功输出 OK 即可，**不要顺手改规划逻辑**
3. 测试脚本跑完删除 `apps/api/test-plan.ts`
4. 不提交 `.env`
5. 只改 `deepseek.client.ts` 一个文件（其他文件不碰）

## 参考资料

- 当前 chatStructured 实现：`apps/api/src/llm/deepseek.client.ts` 约 90-115 行
- 已实测可行的请求格式（curl + 手动 invoke 均验证）：
  ```json
  {
    "response_format": {
      "type": "json_schema",
      "json_schema": { "name": "plan", "schema": { /* 纯 JSON schema */ }, "strict": true }
    }
  }
  ```
- 网关：`https://llm.gw.dachensky.com/v1`，模型 `deepseek-v4-flash`（思考模型，返回 reasoning_content）
