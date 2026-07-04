// ============================================
// 第五站：增强版 GraphRAG（生产级实践）
// ============================================
//
// 【核心知识点】
// 在第四站的基础上，增加三个生产级增强功能：
//   1. 自动获取图谱 Schema（不再手动写 Schema 到 Prompt 中）
//   2. Cypher 执行失败时自动重试（LLM 会修正错误）
//   3. 完整的日志与可观测性
//
// 【知识扩展：第四站的问题】
//
// 第四站中，我们把图谱 Schema 硬编码到了 Prompt 里：
//   "节点类型：Product, Ingredient, Type, Method, People..."
//
// 问题：
//   1. 如果图谱结构变了（新增节点/关系），需要手动更新 Prompt
//   2. 如果不知道图谱里有什么，就无法写好 Prompt
//   3. 手动维护 Schema 容易出错
//
// 解决方案：
//   Neo4jGraph.getSchema() 方法可以自动获取图谱的完整结构描述！
//   它返回类似这样的文本：
//   "Node properties are the following:
//    Product {name: STRING}, Ingredient {name: STRING}, ...
//    Relationship properties are the following:
//    ...
//    The relationships are the following:
//    (:Product)-[:属于]->(:Type), (:Product)-[:包含]->(:Ingredient), ..."
//
//   把这个自动获取的 Schema 塞进 Prompt，LLM 就能知道图谱结构了！
//
// 【前提】
// 1. 先运行 02-build-food-graph.mjs 构建图谱数据
// 2. 配置好 .env 文件
//
// 【运行命令】
// node src/neo4j-graphrag/05-graphrag-enhanced.mjs
// ============================================

import 'dotenv/config'
import { Neo4jGraph } from '@langchain/community/graphs/neo4j_graph'
import { ChatOpenAI } from '@langchain/openai'
import { StateGraph, END, START } from '@langchain/langgraph'
import { HumanMessage } from '@langchain/core/messages'

// ============================================
// 连接 Neo4j
// ============================================
const graph = new Neo4jGraph({
    url: process.env.NEO4J_URI || 'bolt://localhost:7687',
    username: process.env.NEO4J_USER || 'neo4j',
    password: process.env.NEO4J_PASSWORD || '12345678',
})

// ============================================
// 初始化 LLM
// ============================================
const llm = new ChatOpenAI({
    model: process.env.MODEL_NAME || 'qwen-plus',
    temperature: 0,
    configuration: {
        baseURL: process.env.OPENAI_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: process.env.OPENAI_API_KEY || process.env.API_KEY,
    }
})

// ============================================
// 增强功能 1：自动获取图谱 Schema
// ============================================
// 【核心知识点】
// Neo4jGraph.getSchema() 会自动查询 Neo4j 的元数据，
// 返回图谱的结构描述（节点类型、属性、关系类型等）
//
// 【知识扩展：getSchema() 的实现原理】
// 它内部执行了以下 Cypher：
//   CALL db.schema.visualization()  —— 获取 Schema 可视化
//   或者
//   CALL db.stats.NODE_PROPERTIES()  —— 获取节点属性统计
//   CALL db.stats.RELATIONSHIP_PROPERTIES()
//
// 这是 Neo4j 的内置过程（built-in procedure），
// 可以查询数据库的元数据信息

let graphSchema = ''
try {
    graphSchema = await graph.getSchema()
    console.log('✅ 成功获取图谱 Schema：')
    console.log(graphSchema)
    console.log('---')
} catch (e) {
    console.log('⚠️ 获取 Schema 失败（可能图谱为空）：', e.message)
}

// ============================================
// 定义 LangGraph 状态（增强版）
// ============================================
// 相比第四站，新增了：
// - retryCount: 记录重试次数
// - error: 记录最近一次错误信息

const state = {
    messages: {
        value: (left, right) =>
            left.concat(Array.isArray(right) ? right : [right]),
        default: () => [],
    },
    cypher: null,
    context: null,
    answer: null,
    retryCount: 0,        // 🆕 重试计数器
    maxRetries: 2,        // 🆕 最大重试次数
    error: null,          // 🆕 错误信息（用于重试时告诉 LLM 上次哪里错了）
}

function userQuery(state) {
    const last = state.messages[state.messages.length - 1]
    return last.content
}

// ============================================
// 增强功能 2：带日志的节点函数
// ============================================
// 【知识扩展：可观测性】
//
// 在生产环境中，Agent 的每一步都应该有日志记录：
// - 输入：什么触发了这个节点
// - 输出：节点产生了什么结果
// - 耗时：节点花了多长时间
// - 错误：如果失败了，错误信息是什么
//
// 这些日志对于调试 LLM 应用至关重要
// 因为 LLM 的输出不确定，不记录日志很难复现问题

function logStep(stepName, input, output, durationMs) {
    console.log(`  📋 [${stepName}]`)
    console.log(`     输入: ${typeof input === 'string' ? input.substring(0, 80) : JSON.stringify(input).substring(0, 80)}`)
    console.log(`     输出: ${typeof output === 'string' ? output.substring(0, 120) : JSON.stringify(output).substring(0, 120)}`)
    console.log(`     耗时: ${durationMs}ms`)
}

// ============================================
// 节点 1：LLM 生成 Cypher（增强版，支持重试修正）
// ============================================
async function generateCypher(state) {
    const startTime = Date.now()

    // 【增强点】如果上次执行失败，把错误信息也告诉 LLM
    // 让它在本次生成时修正错误
    let errorFeedback = ''
    if (state.error && state.retryCount > 0) {
        errorFeedback = `
      ⚠️ 上一次生成的 Cypher 执行失败了：
      Cypher: ${state.cypher}
      错误: ${state.error}
      请修正这个错误，重新生成正确的 Cypher。
    `
    }

    const prompt = `
    你是一个 Neo4j Cypher 查询专家。
    请根据用户的自然语言问题，生成对应的 Cypher 查询语句。

    以下是当前图谱的完整 Schema（自动生成，不需要手动维护）：

    ${graphSchema}

    规则：
    1. 只生成 MATCH + RETURN 查询，绝对不要 CREATE、DELETE、SET、MERGE
    2. 注意关系的方向，必须和 Schema 中描述的一致
    3. 只输出纯 Cypher 语句，不要输出 markdown 代码块（不要用 \`\`\`）
    4. 不要输出任何解释文字，只输出 Cypher
    ${errorFeedback}

    用户问题：${userQuery(state)}
  `

    const res = await llm.invoke([new HumanMessage(prompt)])

    // 清理 LLM 可能返回的 markdown 包裹
    // 【小白注意】
    // LLM 经常不听话，会输出 ```cypher ... ``` 包裹
    // 我们需要手动去掉这些包裹，提取纯 Cypher
    let cypher = res.content.trim()
    if (cypher.startsWith('```')) {
        cypher = cypher.replace(/^```(?:cypher)?\n?/, '').replace(/\n?```$/, '')
    }

    const duration = Date.now() - startTime
    logStep('generateCypher', userQuery(state), cypher, duration)

    return { cypher }
}

// ============================================
// 节点 2：执行 Cypher（增强版，记录错误信息）
// ============================================
async function executeGraphQuery(state) {
    const startTime = Date.now()

    try {
        const res = await graph.query(state.cypher)
        const context = JSON.stringify(res)
        const duration = Date.now() - startTime
        logStep('executeGraph', state.cypher, `${res.length} 条记录`, duration)
        // 查询成功，重置错误和重试计数
        return { context, error: null, retryCount: 0 }
    } catch (e) {
        const duration = Date.now() - startTime
        logStep('executeGraph', state.cypher, `失败: ${e.message}`, duration)
        // 查询失败，记录错误信息（供重试时使用）
        return {
            context: null,
            error: e.message,
            retryCount: state.retryCount + 1,
        }
    }
}

// ============================================
// 节点 3：LLM 生成答案
// ============================================
async function generateAnswer(state) {
    const startTime = Date.now()

    // 如果查询失败且没有更多重试机会，告知用户
    if (!state.context) {
        const duration = Date.now() - startTime
        const answer = '抱歉，我暂时无法回答这个问题。图谱中可能没有相关数据，或者查询语句有误，请尝试换个问法。'
        logStep('generateAnswer', '无数据', answer, duration)
        return { answer }
    }

    const prompt = `
    你是一个美食知识助手，请根据以下图谱数据回答用户的问题。

    规则：
    1. 答案要简洁明了
    2. 只根据图谱数据回答，不要捏造不存在的信息
    3. 如果数据不足以回答问题，如实告知

    图谱数据：${state.context}

    用户问题：${userQuery(state)}
  `

    const res = await llm.invoke([new HumanMessage(prompt)])
    const duration = Date.now() - startTime
    logStep('generateAnswer', userQuery(state), res.content, duration)

    return { answer: res.content }
}

// ============================================
// 条件路由：查询失败时是否重试
// ============================================
// 【核心知识点】
// LangGraph 支持条件边（Conditional Edge）：
// 根据 state 的当前值，决定下一步走哪个节点
//
// 这里实现的是：
//   - 如果查询成功 → 走 generateAnswer
//   - 如果查询失败且重试次数未超 → 走 generateCypher（重新生成）
//   - 如果查询失败且重试次数已超 → 走 generateAnswer（告知失败）
//
// 【知识扩展：条件路由 vs if/else】
// 普通 if/else 是在节点内部跳转
// 条件路由是在图层面跳转，更灵活，可以跳到任意节点
// 这就是「Agent 循环」的基础——LLM 可以反复尝试直到成功

function shouldRetry(state) {
    // 查询成功（没有错误）→ 直接生成答案
    if (!state.error) {
        return 'generateAnswer'
    }
    // 查询失败，检查是否还有重试机会
    if (state.retryCount <= state.maxRetries) {
        console.log(`  🔄 Cypher 执行失败，第 ${state.retryCount} 次重试...`)
        return 'generateCypher'  // 重新生成 Cypher
    }
    // 重试次数用完了，带着错误信息去生成答案
    console.log(`  ❌ 重试 ${state.maxRetries} 次仍失败，生成兜底回答`)
    return 'generateAnswer'
}

// ============================================
// 组装增强版工作流
// ============================================
//
// 工作流图：
//   START → generateCypher → executeGraph → [条件判断]
//                                              ↓ 成功        ↓ 失败且可重试
//                                         generateAnswer   generateCypher（循环）
//                                              ↓
//                                             END

const workflow = new StateGraph({ channels: state })
    .addNode('generateCypher', generateCypher)
    .addNode('executeGraph', executeGraphQuery)
    .addNode('generateAnswer', generateAnswer)
    .addEdge(START, 'generateCypher')
    .addEdge('generateCypher', 'executeGraph')
    // 【关键】条件边：根据执行结果决定下一步
    .addConditionalEdges('executeGraph', shouldRetry, {
        generateCypher: 'generateCypher',
        generateAnswer: 'generateAnswer',
    })
    .addEdge('generateAnswer', END)

const app = workflow.compile()

// 打印工作流
async function printWorkflowMermaid() {
    const drawable = await app.getGraphAsync()
    const mermaid = drawable.drawMermaid({ withStyles: true })
    console.log('')
    console.log('--- 增强版工作流 (Mermaid) ---')
    console.log(mermaid)
    console.log('------------------------------')
}

// ============================================
// 运行 GraphRAG（带详细输出）
// ============================================
async function runGraphRAG(question) {
    console.log('')
    console.log(`╔══ ❓ 问题：${question} ══╗`)

    const res = await app.invoke({
        messages: [new HumanMessage(question)],
    })

    console.log('')
    console.log(`  📝 最终回答：${res.answer}`)
    console.log('')
}

// ============================================
// 主流程
// ============================================
; (async () => {
    console.log('')
    console.log('╔══════════════════════════════════════════╗')
    console.log('║    第五站：增强版 GraphRAG               ║')
    console.log('╚══════════════════════════════════════════╝')

    try {
        await printWorkflowMermaid()

        // 测试正常问题
        await runGraphRAG('红烧肉包含哪些食材？它的做法是什么？')

        // 测试多跳关系问题
        await runGraphRAG('哪些菜品推荐给了张三？这些菜用了什么食材？')

        // 测试聚合问题
        await runGraphRAG('热菜类有多少道菜？每道菜的食材分别是什么？')

        console.log('╔══════════════════════════════════════════╗')
        console.log('║  ✅ 增强版小结                            ║')
        console.log('╠══════════════════════════════════════════╣')
        console.log('║  三大增强：                                ║')
        console.log('║  1. getSchema() 自动获取图谱结构          ║')
        console.log('║     → 不用手动维护 Schema 到 Prompt       ║')
        console.log('║  2. 条件路由 + 重试机制                    ║')
        console.log('║     → Cypher 失败时 LLM 自动修正重试      ║')
        console.log('║  3. 结构化日志                             ║')
        console.log('║     → 每步记录输入/输出/耗时              ║')
        console.log('║                                          ║')
        console.log('║  🎉 恭喜完成 Neo4j GraphRAG 全部教程！    ║')
        console.log('║                                          ║')
        console.log('║  进阶方向：                               ║')
        console.log('║  → 添加向量检索实现混合 GraphRAG           ║')
        console.log('║  → 流式输出答案（streaming）               ║')
        console.log('║  → 多轮对话记忆                            ║')
        console.log('╚══════════════════════════════════════════╝')
    } catch (error) {
        console.error('❌ 出错了:', error.message)
        if (error.message.includes('Unable to connect') || error.message.includes('ECONNREFUSED')) {
            console.log('💡 提示：请先启动 Neo4j → docker compose up -d')
        }
        if (error.message.includes('API key') || error.message.includes('401')) {
            console.log('💡 提示：请检查 .env 中的 OPENAI_API_KEY 是否正确')
        }
    }
})()
