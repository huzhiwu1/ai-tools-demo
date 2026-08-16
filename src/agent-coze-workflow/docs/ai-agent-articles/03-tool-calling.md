# 工具调用：Agent 的双手

## 工具调用解决了什么问题

LLM 只擅长"生成文本"。让它写个 JSON 可以，但让它真正"把工作流保存到 Coze 平台"就不行了——它没有网络权限、不知道平台接口、也做不到 100% 稳定。

工具调用（Tool Calling / Function Calling）的解决思路很直接：**模型负责决定"调用哪个工具、传什么参数"，代码负责真正执行。**

```
LLM 输出结构化请求: { tool: "save_to_coze", args: { workflowId: "123", ... } }
                        ↓
代码执行真实操作:      Coze API → 返回 workflowId
                        ↓
结果回到对话里:        Observation 供模型继续推理
```

## 一个工具的三个组成部分

本项目用 LangChain 的 `tool()` + Zod 定义工具，见 `apps/api/src/agent/tools/clarify.tool.ts`：

```ts
export const clarifyQuestionTool = tool(
  async ({ question, context }) => {
    const answer = await interrupt({ question, context });
    return `用户回答: ${answer}`;
  },
  {
    name: "clarify_question",
    description:
      "当用户需求信息不完整时调用（例如缺少数据源、格式约定、输出要求、验收标准等）。" +
      "调用后工作流暂停，等待用户回答，收到回答后自动继续。",
    schema: z.object({
      question: z.string().describe("向用户提出的具体问题（一次只问一个最关键的）"),
      context: z.string().optional().describe("补充说明为什么需要这个信息"),
    }),
  },
);
```

每个工具都有三部分：

| 部分 | 作用 | 谁消费 |
| ---- | ---- | ------ |
| `name` | 工具的稳定标识 | LLM 输出用它指定工具 |
| `description` | 告诉 LLM "什么时候该用我" | **LLM 的选择依据** |
| `schema`（Zod） | 参数的结构化定义，约束模型输出 | 校验 + 类型安全 |

执行函数则是真正干活的地方：调 Coze API、读写缓存、暂停等待用户。

## 工具描述是"产品说明书"

模型选择工具，主要靠 description。这是 Agent 工程里投入产出比最高的地方：

- **写清楚触发条件**："当需求信息不完整时调用"——比"澄清工具"强一百倍
- **写清楚副作用**："调用后工作流暂停，等待用户回答"——模型才不会在不需要时误用
- **写清楚失败语义**："保存失败时自动加后缀重试"
- **一次只做一件事**：把"问用户"和"读文件"拆成两个工具，比一个"万能工具"好控制得多

工具顺序也有影响。本项目的 `tools/index.ts` 特意把 `clarify_question` 放在列表最前面，让模型"优先想到澄清"：

```ts
// apps/api/src/agent/tools/index.ts
// clarify_question 放在列表最前面，确保 LLM 优先考虑信息澄清
export { clarifyQuestionTool } from "./clarify.tool";
```

## 参数句柄化：别让模型背大 JSON

工具设计里最容易踩的坑：参数太大。让模型在参数里完整携带一份工作流 JSON（几百行），结果就是：

- 模型输出截断、JSON 语法错误
- 参数和真实状态不一致（模型"记错"了）
- token 浪费严重

本项目的解法是**句柄（handle）模式**：工具把重对象存在服务端，返回一个短 ID，后续工具只传 ID：

```text
plan_workflow        → 返回 planId（不返回完整 plan）
generate_workflow(planId) → 返回 workflowId
update_workflow(workflowId + fixInstruction)  → 不再传大 JSON
save_to_coze(workflowId)   → 保存
```

系统提示词里明确写着：

> update_workflow / save_to_coze 的 workflow JSON 参数现在可选……优先用 workflowId 句柄，不背完整 plan / workflow。

这也是大模型应用的一个通用原则：**把"模型记不住/背不动"的状态搬到代码侧管理，模型只传引用。**

## 工具返回值的艺术

工具返回什么，决定了模型下一步推理的质量：

1. **结构化**：返回 JSON，模型容易读取；不要返回 `[object Object]`
2. **精简**：返回摘要而不是全量数据（如 `list_workflows` 只返回 workflowId/name/desc）
3. **带结论**：不仅给数据，还给"这意味着什么"（如 batch_validate 返回 accuracy + 失败归因）
4. **错误要分类**：凭证错误（`authentication failed`）和业务错误必须区分，让模型"知道不该重试业务"

## 工具调用的失败处理

工具调用失败有三种层级，处理方式完全不同：

| 失败类型 | 例子 | 处理 |
| -------- | ---- | ---- |
| 参数解析失败 | 模型输出的 JSON 不合 schema | 回灌给模型修正（LangGraph 自动做） |
| 工具执行失败 | 平台接口 500 | 作为 Observation 返回，模型决定重试或换方案 |
| 凭证/权限失败 | session key 过期 | **不要重试**，直接告知用户检查配置 |

本项目的系统提示词把凭证错误单独拎出来：

> save_to_coze 返回 "authentication failed" → 这是平台凭证问题，不是工作流问题！不要修改工作流、不要反复保存。

这个设计很关键：Agent 的"执着"是优点也是危险，**必须教会它区分"值得重试的错误"和"重试也没用的错误"。**

## 核心要点

- 工具 = name + description + schema + 执行函数，description 决定模型什么时候选它
- 参数越小越稳：重对象放服务端，模型只传句柄（planId / workflowId）
- 返回值要结构化、精简、带结论，错误要分类
- 工具描述是"产品说明书"，值得反复打磨

## 延伸思考

- 如果两个工具都能"读文件"，模型怎么选？——信息都写在 description 里，冲突时要合并或加约束。
- 工具数量超过 20 个时，模型选择准确率会下降，怎么解？（提示：工具分组、子 Agent、路由工具）
