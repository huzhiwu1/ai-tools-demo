// ============================================
// 03-react-agent.mjs
// ============================================
// 职责：用 LCEL 拼一个最小可运行的 ReAct Agent
//        ——基于源代码 runnable-test/src/cases/mcp-test.mjs 改写
//        为了让小白能直接跑通，把 MCP 远程工具换成两个本地小工具，
//        但 agentStepChain 的结构（Passthrough.assign + Branch + 工具执行器）
//        与原版完全一致，看懂它就看懂了原版。
//
// 关键流程（这就是 ReAct Agent 的"心跳"）：
// 1. 把工具用 zod 描述清楚后 bindTools 给模型
// 2. 用 LCEL 拼一个"单步链"agentStepChain：调 LLM → 判断有没有 tool_calls
//    - 没有：本轮就是最终答案，标记 done = true
//    - 有  ：执行工具 → 把 ToolMessage 写回 messages，让 LLM 下一轮继续推理
// 3. 在外层用 for 循环反复 invoke 这条单步链，直到 done 或 maxSteps 到顶
//
// 知识扩展（小白能懂）：
//   什么是 ReAct？
//   - Re(asoning) + Act(ion)：先思考，再行动，然后观察结果，循环往复
//   - Agent 不是"一次问答"，而是"一段对话循环"：
//        Thought → Action(tool_call) → Observation(tool_result) → Thought → ... → Final Answer
//
//   为什么单步用 LCEL，循环用 for？
//   - LCEL 适合"声明一段确定的数据流"（一次模型调用 + 工具执行）
//   - "循环多少次"是动态的，由 LLM 决定，所以最外层用普通 for 循环更直观
//   - 这是一个非常实用的模式：内层 LCEL + 外层控制循环
//
//   为什么必须设置 maxSteps？
//   - LLM 可能陷入"调工具 → 看结果 → 又调工具"的死循环
//   - 必须给一个上限，到顶就强制返回，防止把 token 烧光
//   - 见项目规则 ai-agent.md 第 4.2 节："Agent 循环必须设置最大步数限制"
//
//   原版与本教学版的区别
//   - 原版：MultiServerMCPClient 拉远程 MCP 工具（高德地图 + Chrome DevTools）
//   - 本版：用 zod + DynamicStructuredTool 写两个本地工具（计算器 + 模拟天气）
//   - agentStepChain 几乎一模一样，便于对照学习
// ============================================

import "dotenv/config"
import chalk from "chalk"
import { z } from "zod"
import { ChatOpenAI } from "@langchain/openai"
import { DynamicStructuredTool } from "@langchain/core/tools"
import { HumanMessage, ToolMessage } from "@langchain/core/messages"
import {
    ChatPromptTemplate,
    MessagesPlaceholder,
} from "@langchain/core/prompts"
import {
    RunnableSequence,
    RunnableLambda,
    RunnableBranch,
    RunnablePassthrough,
} from "@langchain/core/runnables"

// ============================================
// 1. 定义两个本地工具（替代原版的 MCP 工具）
// ============================================
// 重点1：每个 zod 字段必须 .describe()，否则 LLM 看不懂参数含义（项目规则 9.1）
// 重点2：tool 的 description 直接决定 LLM 选不选你 → 写得越清楚越好（项目规则 7.2）
const calcTool = new DynamicStructuredTool({
    name: "calculator",
    description: "执行简单的四则运算。当用户问数学计算（加减乘除）时使用这个工具。",
    schema: z.object({
        expression: z
            .string()
            .describe("一个合法的 JavaScript 算术表达式，例如 '1+2*3' 或 '(10-2)/4'"),
    }),
    func: async ({ expression }) => {
        try {
            // 教学场景用 Function 简单求值；生产环境务必用安全的表达式求值库
            // eslint-disable-next-line no-new-func
            const result = Function(`"use strict"; return (${expression})`)()
            return `计算结果：${expression} = ${result}`
        } catch {
            return `表达式无法计算：${expression}`
        }
    },
})

const weatherTool = new DynamicStructuredTool({
    name: "get_weather",
    description: "查询某个城市的当前天气。当用户问天气、温度、下雨等问题时使用这个工具。",
    schema: z.object({
        city: z.string().describe("要查询天气的中文城市名，例如 '北京' '上海'"),
    }),
    func: async ({ city }) => {
        // 教学场景：返回写死的假数据。真实场景换成 fetch 一个天气 API
        const fake = {
            北京: "北京：晴，22°C，东北风 2 级",
            上海: "上海：多云，26°C，东风 3 级",
            广州: "广州：雷阵雨，30°C，南风 4 级",
        }
        return fake[city] ?? `${city}：暂无该城市天气数据`
    },
})

const tools = [calcTool, weatherTool]

// ============================================
// 2. 模型 + bindTools
// ============================================
// bindTools 把工具 schema 翻译成 OpenAI function calling 格式喂给模型
// 之后模型在需要时会返回 tool_calls 字段，告诉我们"调哪个工具、用什么参数"
const model = new ChatOpenAI({
    modelName: process.env.MODEL_NAME,
    apiKey: process.env.API_KEY,
    temperature: 0,
    configuration: { baseURL: process.env.BASE_URL },
})
const modelWithTools = model.bindTools(tools)

// ============================================
// 3. 系统提示词 + 消息占位符
// ============================================
// MessagesPlaceholder("messages") 表示"运行时这里会被一段历史消息列表替换"
// 这是 Agent 多轮对话的关键：每一轮都把累积的 messages 传进来
const prompt = ChatPromptTemplate.fromMessages([
    [
        "system",
        `你是一个会调用工具的智能助手。
可用工具：
1. calculator: 做数学计算
2. get_weather: 查询城市天气

规则：
- 需要计算或查天气时，优先调用工具，不要自己瞎猜
- 工具返回结果后，结合结果用一句话回答用户
- 不需要工具就能回答的问题，直接回答`,
    ],
    new MessagesPlaceholder("messages"),
])

// LCEL 链：把 prompt 塞给模型 → 拿到 AIMessage（可能带 tool_calls）
const llmChain = prompt.pipe(modelWithTools)

// ============================================
// 4. 工具执行器 Runnable —— 对应原版的 toolExecutor
// ============================================
// 输入: { response: AIMessage, tools: Tool[] }
// 输出: ToolMessage[]（每个 tool_call 对应一条结果）
const toolExecutor = new RunnableLambda({
    func: async (state) => {
        const { response, tools } = state
        const toolResults = []

        // 遍历模型本轮要调用的所有工具
        for (const toolCall of response.tool_calls ?? []) {
            const found = tools.find((t) => t.name === toolCall.name)
            if (!found) {
                console.log(chalk.red(`找不到工具：${toolCall.name}`))
                continue
            }

            console.log(chalk.bgBlue(
                `🔧 调用工具 ${toolCall.name}  参数: ${JSON.stringify(toolCall.args)}`
            ))
            const out = await found.invoke(toolCall.args)
            const contentStr = typeof out === "string" ? out : JSON.stringify(out)
            console.log(chalk.cyan(`   ↪ 结果: ${contentStr}`))

            // ToolMessage 必须带 tool_call_id，否则 LLM 不知道这条结果对应哪次调用
            toolResults.push(
                new ToolMessage({
                    content: contentStr,
                    tool_call_id: toolCall.id,
                })
            )
        }
        return toolResults
    },
})

// ============================================
// 5. 「单步」链 agentStepChain —— ReAct 一轮的全部逻辑
// ============================================
// 输入 state: { messages, tools, done, final }
// 这条链做的事：
//   step1) 调 LLM，把结果挂到 state.response
//   step2) 用 Branch 看 response 里有没有 tool_calls
//          a) 没有 → 把 response 追加到 messages，标记 done=true，把 final 设为最终回答
//          b) 有   → 执行工具 → 把 ToolMessage 们追加到 messages，done=false（外层会再调一次）
const agentStepChain = RunnableSequence.from([
    // ---- step1: 调用 LLM，并把结果通过 .assign 挂到 state.response ----
    // RunnablePassthrough.assign 的精髓：原 state 不丢，多一个 response 字段
    RunnablePassthrough.assign({
        response: llmChain,   // 这个 Runnable 的输出 → 写到 state.response
    }),

    // ---- step2: 根据有没有 tool_calls 走不同分支 ----
    RunnableBranch.from([
        // ---- 分支A：没有 tool_calls，本轮就是最终答案 ----
        [
            (state) =>
                !state.response?.tool_calls ||
                state.response.tool_calls.length === 0,
            new RunnableLambda({
                func: async (state) => ({
                    ...state,
                    messages: [...state.messages, state.response],
                    done: true,
                    final: state.response.content,
                }),
            }),
        ],

        // ---- 默认分支：有 tool_calls，执行工具后继续 ----
        RunnableSequence.from([
            // 5.1 把 AIMessage（含 tool_calls）追加进 messages
            new RunnableLambda({
                func: async (state) => {
                    console.log(chalk.bgYellow(
                        `🤔 LLM 决定调用 ${state.response.tool_calls.length} 个工具`
                    ))
                    return {
                        ...state,
                        messages: [...state.messages, state.response],
                    }
                },
            }),
            // 5.2 用 toolExecutor 执行所有工具，结果挂到 state.toolMessages
            //     注意：assign 会保留原 state 全部字段，只新增 toolMessages
            RunnablePassthrough.assign({
                toolMessages: toolExecutor,
            }),
            // 5.3 把 ToolMessage 们追加进 messages，标记 done=false
            new RunnableLambda({
                func: async (state) => ({
                    ...state,
                    messages: [...state.messages, ...(state.toolMessages ?? [])],
                    done: false,
                }),
            }),
        ]),
    ]),
])

// ============================================
// 6. 外层 for 循环 —— ReAct 的"心跳"
// ============================================
// 这里就是 Agent 循环本身：感知(messages) → 思考(LLM) → 行动(tool) → 重复
// 必须有 maxIterations 兜底，防止 LLM 死循环（项目规则 4.2）
async function runAgent(query, maxIterations = 8) {
    let state = {
        messages: [new HumanMessage(query)],
        tools,
        done: false,
        final: null,
    }

    for (let i = 0; i < maxIterations; i++) {
        console.log(chalk.bgGreen(`\n────── 第 ${i + 1} 轮 ──────`))
        // 每一轮都跑一遍 LCEL 单步链，state 被不断丰富
        state = await agentStepChain.invoke(state)
        if (state.done) {
            console.log(chalk.bgGreen(`\n✅ Agent 完成，最终回答：\n${state.final}\n`))
            return state.final
        }
    }

    // 到这里说明 maxIterations 用完了还没 done，必须兜底返回
    console.log(chalk.red(`\n⚠️ 达到最大轮次 ${maxIterations}，强制结束`))
    return state.messages.at(-1)?.content ?? "Agent 未给出最终答案"
}

// ============================================
// 7. 跑两个用例 —— 看 Agent 怎么"自己"决定调不调工具
// ============================================
async function main() {
    // 用例1：纯计算 → 期望调用 calculator
    console.log(chalk.bgMagenta("\n========== 用例1：纯计算 =========="))
    await runAgent("帮我算一下 (12 + 8) * 5 等于多少？")

    // 用例2：天气 + 计算混合 → 期望先后调用两个工具
    console.log(chalk.bgMagenta("\n========== 用例2：天气 + 计算 =========="))
    await runAgent("北京今天多少度？把这个温度乘以 2 是多少？")

    // 用例3：不需要工具 → 期望直接回答
    console.log(chalk.bgMagenta("\n========== 用例3：聊天 =========="))
    await runAgent("你好呀，介绍一下你自己")
}

await main()

// ============================================
// 【知识点总结】
// ============================================
console.log(chalk.bgMagenta("\n=== 【知识点总结】==="))
console.log(`
1. ReAct Agent 的标准结构（必须背下来）
   外层 for 循环（控制轮次）
     └─ 内层 LCEL 单步链 agentStepChain
        ├─ Passthrough.assign({ response: llmChain })  // 调 LLM 并挂结果
        └─ Branch
           ├─ 没 tool_calls → 标记 done=true，本轮即终点
           └─ 有 tool_calls → 执行工具 → ToolMessage 写回 messages

2. LCEL 在 Agent 中扮演什么角色？
   - 把"一次模型调用 + 一次工具执行"的"一步"声明清楚
   - 循环这条链就是 Agent 的本体
   - 外层循环负责判断"什么时候停"

3. 三个关键 Runnable 的搭配口诀
   - assign  : 给 state 加字段，永远不丢之前的信息
   - Branch  : 链上的 if/else，处理"要不要继续"
   - Lambda  : 任何业务函数（写 messages、打日志）都用它包

4. 必须遵守的工程纪律（来自 ai-agent.md）
   - maxSteps 兜底：本例 8 轮，原版 30 轮，禁止无上限循环
   - 工具描述要写清：name + description + zod 字段 .describe()
   - 状态要显式：用一个 state 对象集中管理 messages / done / final
   - 工具调用要带 tool_call_id：否则 LLM 接不上"调用 ↔ 结果"

5. 从这个教学版怎么变成生产版？
   - 把本地 calcTool/weatherTool 换成 MultiServerMCPClient.getTools()（参考原版第 26~38 行）
   - 把 process.stdout.write 这种打印改成结构化日志（项目规则 4.3）
   - 在最外层加超时 + 错误重试，工具调用要 try/catch

6. 容易踩的坑
   - 忘了把 AIMessage 追加进 messages → 下一轮 LLM 不知道自己刚才说了啥
   - 忘了 ToolMessage 设 tool_call_id → LLM 困惑，可能再调一次同样的工具
   - 没设 maxIterations → 死循环烧爆 token
   - tool 的 schema 缺 .describe() → LLM 不知道字段含义，参数瞎填
`)
