// ============================================
// 第四站：GraphRAG 完整实现
// ============================================
//
// 【核心知识点】
// GraphRAG = Graph（图数据库）+ RAG（检索增强生成）
//
// 传统 RAG：用户提问 → 向量检索 → 把检索结果喂给 LLM → 生成回答
// GraphRAG：用户提问 → LLM 生成 Cypher → 查询图数据库 → 把结果喂给 LLM → 生成回答
//
// 区别：
//   传统 RAG 检索的是「文本片段」（非结构化）
//   GraphRAG 检索的是「图关系数据」（结构化）
//
// 【知识扩展：为什么需要 GraphRAG？】
//
//   传统 RAG 的问题：
//   - 向量检索只能找「语义相似」的文本
//   - 无法回答「A 和 B 之间有什么关系」「通过 C 能找到哪些 D」这类关系型问题
//
//   GraphRAG 的优势：
//   - 利用图数据库的关系结构，精准回答关联性问题
//   - LLM 理解问题后生成查询语言（Cypher），比手写查询更灵活
//   - 图查询结果天然具有结构，LLM 更容易理解
//
//   打个比方：
//   - 传统 RAG 像在图书馆找书：关键词搜索 → 找到相关段落
//   - GraphRAG 像问一个百科全书：你问问题 → 它查关系网络 → 综合回答
//
// 【本文件的架构】
//
//   用户问题
//     ↓
//   节点1: generateCypher  —— LLM 根据图谱 Schema 生成 Cypher 查询
//     ↓
//   节点2: executeGraph   —— 执行 Cypher 查询 Neo4j
//     ↓
//   节点3: generateAnswer  —— LLM 根据查询结果生成自然语言回答
//     ↓
//   输出最终答案
//
//   使用 LangGraph 的 StateGraph 编排这三个节点
//
// 【前提】
// 1. 先运行 02-build-food-graph.mjs 构建图谱数据
// 2. 配置好 .env 文件中的 OPENAI_API_KEY、OPENAI_BASE_URL、MODEL_NAME
//
// 【运行命令】
// node src/neo4j-graphrag/04-graphrag.mjs
// ============================================

import 'dotenv/config'
import { Neo4jGraph } from '@langchain/community/graphs/neo4j_graph'
import { ChatOpenAI } from '@langchain/openai'
import { StateGraph, END, START } from '@langchain/langgraph'
import { HumanMessage } from '@langchain/core/messages'

// ============================================
// 第一步：连接 Neo4j 图数据库
// ============================================
// 【知识扩展：Neo4jGraph vs neo4j-driver】
//
// neo4j-driver（前几站用的）：
//   - Neo4j 官方驱动，底层操作，灵活但代码多
//   - 适合：直接写 Cypher、精细控制
//
// Neo4jGraph（LangChain 社区封装）：
//   - LangChain 封装的高层接口
//   - 提供 getSchema() 方法，自动获取图谱结构描述
//   - 适合：GraphRAG 场景，因为我们需要告诉 LLM 图谱长什么样
//
// 【小白注意】
// process.env.XXX 读取 .env 文件中的环境变量
// 需要先 import 'dotenv/config' 来自动加载

const graph = new Neo4jGraph({
    url: process.env.NEO4J_URI || 'bolt://localhost:7687',
    username: process.env.NEO4J_USER || 'neo4j',
    password: process.env.NEO4J_PASSWORD || '12345678',
})

// ============================================
// 第二步：初始化 LLM
// ============================================
// 【知识扩展：ChatOpenAI】
//
// ChatOpenAI 是 LangChain 封装的 OpenAI 聊天模型客户端
// 它不仅支持 OpenAI，还支持任何兼容 OpenAI API 格式的服务
// （如阿里百炼/通义千问、Moonshot/Kimi、智谱 GLM 等）
//
// 关键参数：
// - model: 模型名称（如 gpt-4、qwen-plus）
// - temperature: 温度参数，0 = 最确定性，1 = 最随机
//   GraphRAG 中生成 Cypher 需要精确输出，所以设为 0
// - configuration.baseURL: API 地址，默认是 OpenAI 官方
//   使用其他服务时需要改为你自己的 API 地址

const llm = new ChatOpenAI({
    model: process.env.MODEL_NAME || 'qwen-plus',
    temperature: 0,
    configuration: {
        baseURL: process.env.OPENAI_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: process.env.OPENAI_API_KEY || process.env.API_KEY,
    }
})

// ============================================
// 第三步：定义 LangGraph 状态
// ============================================
// 【核心知识点】
//
// LangGraph 的 StateGraph 是工作流编排的核心：
// - state 定义了工作流中流动的数据结构
// - 每个节点函数接收 state，返回部分 state 更新
// - 返回值会和现有 state 合并（类似 React 的 setState）
//
// 【知识扩展：messages 的 reducer 函数】
//
// messages 字段用了一个 reducer 函数：
//   value: (left, right) => left.concat(...)
//
// 这意味着：新消息不会替换旧消息，而是追加到数组末尾
// 这是 LangGraph 的重要模式——状态累积
//
// 对比：
//   普通字段（如 cypher）：每次更新会覆盖旧值
//   reducer 字段（如 messages）：每次更新会追加
//
// 【小白注意】
// 为什么要累积消息？
// 因为后续节点可能需要看到之前所有的交互历史
// 比如第三站生成答案时，可能需要看到第一站生成的 Cypher

const state = {
    messages: {
        // reducer 函数：新消息追加到旧消息后面
        value: (left, right) =>
            left.concat(Array.isArray(right) ? right : [right]),
        default: () => [],
    },
    cypher: null,    // 第一站输出：LLM 生成的 Cypher 查询语句
    context: null,   // 第二站输出：Neo4j 查询结果（图数据）
    answer: null,    // 第三站输出：LLM 生成的最终自然语言回答
}

// 辅助函数：从消息数组中取出最新的用户问题
function userQuery(state) {
    const last = state.messages[state.messages.length - 1]
    return last.content
}

// ============================================
// 第四步：节点 1 —— LLM 生成 Cypher
// ============================================
//
// 这是 GraphRAG 最核心的步骤！
// LLM 需要理解：
//   1. 图谱的 Schema（有哪些节点、关系、属性）
//   2. 用户的问题
//   3. 然后生成正确的 Cypher 查询语句
//
// 【知识扩展：Prompt Engineering 在 GraphRAG 中的作用】
//
// 给 LLM 的 Prompt 必须包含：
//   1. 图谱 Schema：告诉 LLM 数据库里有什么
//   2. 关系示例：用 ASCII 图示出节点之间的关系方向
//   3. 输出约束：明确要求只输出 Cypher，不要 markdown
//   4. 匹配规则：只 MATCH，不要 CREATE/DELETE
//
// 为什么这么详细？
// 因为 LLM 不了解你的数据库结构，
// 如果不告诉它 Schema，它会瞎编节点标签和关系类型

async function generateCypher(state) {
    const prompt = `
    你是一个 Neo4j Cypher 查询专家。
    请根据用户的自然语言问题，生成对应的 Cypher 查询语句。

    图谱的节点和关系如下：

    节点类型：
    - Product: 菜品
    - Ingredient: 食材
    - Type: 菜品类型
    - Method: 烹饪方法
    - People: 推荐人群

    关系方向（非常重要！箭头方向必须一致）：
    - (Product)-[:属于]->(Type)
    - (Product)-[:包含]->(Ingredient)
    - (Product)-[:推荐]->(People)
    - (Ingredient)-[:做法]->(Method)

    规则：
    1. 只生成 MATCH + RETURN 查询，不要生成 CREATE、DELETE、SET
    2. 根据问题判断需要 MATCH 哪些节点和关系
    3. 只输出纯 Cypher 语句，不要输出 markdown 代码块或其他文字

    用户问题：${userQuery(state)}
  `

    const res = await llm.invoke([new HumanMessage(prompt)])

    console.log('  🤖 LLM 生成的 Cypher：')
    console.log(`     ${res.content}`)

    // 返回 cypher 字段，会合并到 state 中
    return { cypher: res.content }
}

// ============================================
// 第五步：节点 2 —— 执行 Cypher 查询 Neo4j
// ============================================
//
// 【核心知识点】
// 将 LLM 生成的 Cypher 语句发送给 Neo4j 执行，获取图数据
//
// 这一步是「传统代码」，不涉及 LLM
// 但它连接了两个 LLM 节点（上游生成 Cypher，下游生成答案）
//
// 【知识扩展：为什么需要 try/catch？】
// LLM 生成的 Cypher 可能有语法错误！
// 比如：节点标签拼写错误、关系方向反了、缺少 RETURN
// 必须捕获异常，给 LLM 一个「查不到数据」的信号

async function executeGraphQuery(state) {
    try {
        console.log('  🔍 执行 Cypher 查询 Neo4j...')
        const res = await graph.query(state.cypher)
        console.log(`  📊 查询到 ${res.length} 条记录`)
        return { context: JSON.stringify(res) }
    } catch (e) {
        console.log(`  ❌ Cypher 执行失败: ${e.message}`)
        return { context: '查询失败，图谱中没有找到相关数据' }
    }
}

// ============================================
// 第六步：节点 3 —— LLM 根据图数据生成答案
// ============================================
//
// 【核心知识点】
// 这一步和传统 RAG 的「生成」步骤一样：
// 把检索到的上下文（context）和用户问题一起发给 LLM，
// 让它生成自然语言回答
//
// 区别在于：context 的内容来源不同
//   传统 RAG：context = 向量检索到的文本片段
//   GraphRAG：context = Cypher 查询到的 JSON 数据

async function generateAnswer(state) {
    const prompt = `
    你是一个美食知识助手，请根据以下图谱数据回答用户的问题。

    规则：
    - 答案要简洁明了，不要捏造图谱中没有的信息（如价格、卡路里等）。

    图谱数据：${state.context}

    用户问题：${userQuery(state)}
  `

    const res = await llm.invoke([new HumanMessage(prompt)])

    console.log('  💬 生成答案中...')

    return { answer: res.content }
}

// ============================================
// 第七步：组装 LangGraph 工作流
// ============================================
//
// 【核心知识点】
// LangGraph 的 StateGraph 将多个节点编排成一条工作流：
//
//   START → generateCypher → executeGraph → generateAnswer → END
//
// 每个节点是一个 async 函数，接收 state 并返回部分 state 更新
// addEdge 定义节点之间的流向
//
// 【知识扩展：StateGraph vs 普通函数调用】
//
// 你可能会问：为什么不直接按顺序调用三个函数？
//   await generateCypher(state)
//   await executeGraphQuery(state)
//   await generateAnswer(state)
//
// 答案是：StateGraph 的优势在于：
//   1. 状态管理：自动合并每个节点的输出到共享 state
//   2. 可视化：可以导出 Mermaid 流程图
//   3. 可扩展：后续可以加条件分支（如查询失败→重试）
//   4. 流式输出：支持 .stream() 逐节点输出
//
// 对于简单的线性流程，区别不大
// 但对于复杂的 Agent 工作流（条件分支、循环、并行），StateGraph 优势明显

const workflow = new StateGraph({ channels: state })
    .addNode('generateCypher', generateCypher)
    .addNode('executeGraph', executeGraphQuery)
    .addNode('generateAnswer', generateAnswer)
    .addEdge(START, 'generateCypher')
    .addEdge('generateCypher', 'executeGraph')
    .addEdge('executeGraph', 'generateAnswer')
    .addEdge('generateAnswer', END)

const app = workflow.compile()

// 打印工作流的 Mermaid 流程图
async function printWorkflowMermaid() {
    const drawable = await app.getGraphAsync()
    const mermaid = drawable.drawMermaid({ withStyles: true })
    console.log('')
    console.log('--- LangGraph 工作流 (Mermaid) ---')
    console.log(mermaid)
    console.log('----------------------------------')
}

// ============================================
// 第八步：运行 GraphRAG
// ============================================
async function runGraphRAG(question) {
    console.log('')
    console.log(`❓ 用户问题：${question}`)
    console.log('---')

    const res = await app.invoke({
        messages: [new HumanMessage(question)],
    })

    console.log('')
    console.log('=== 最终结果 ===')
    console.log('生成的 Cypher：', res.cypher)
    console.log('查询到的数据：', res.context)
    console.log('最终回答：', res.answer)
    console.log('===============')
    console.log('')
}

// ============================================
// 主流程
// ============================================
; (async () => {
    console.log('')
    console.log('╔══════════════════════════════════════════╗')
    console.log('║    第四站：GraphRAG 完整实现              ║')
    console.log('╚══════════════════════════════════════════╝')

    try {
        // 打印工作流图
        await printWorkflowMermaid()

        // 并行测试 3 个问题
        // 【知识扩展：Promise.all 并行执行】
        // 三个问题互不依赖，可以同时发送，提高效率
        await Promise.all([
            runGraphRAG('红烧肉的食材和做法是什么？'),
            runGraphRAG('宫保鸡丁的推荐人群有哪些？'),
            runGraphRAG('热菜类有哪些菜品，食材和做法分别是什么？'),
        ])

        console.log('╔══════════════════════════════════════════╗')
        console.log('║  ✅ 小结                                 ║')
        console.log('╠══════════════════════════════════════════╣')
        console.log('║  GraphRAG 三步走：                         ║')
        console.log('║  1. LLM 生成 Cypher（理解问题+图谱Schema）║')
        console.log('║  2. 执行 Cypher 查 Neo4j（获取图数据）    ║')
        console.log('║  3. LLM 生成答案（综合数据+问题）          ║')
        console.log('║                                          ║')
        console.log('║  LangGraph 工作流：                        ║')
        console.log('║  START → Cypher → Execute → Answer → END ║')
        console.log('║                                          ║')
        console.log('║  下一站：05-graphrag-enhanced.mjs         ║')
        console.log('║  → 增强版：错误重试 + Schema自动获取      ║')
        console.log('╚══════════════════════════════════════════╝')
    } catch (error) {
        console.error('❌ 出错了:', error.message)
        if (error.message.includes('Unable to connect') || error.message.includes('ECONNREFUSED')) {
            console.log('💡 提示：请先启动 Neo4j → docker compose up -d')
        }
        if (error.message.includes('API key')) {
            console.log('💡 提示：请检查 .env 中的 OPENAI_API_KEY 是否正确')
        }
    }
})()
