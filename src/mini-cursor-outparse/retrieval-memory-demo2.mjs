// ============================================
// retrieval-memory-demo2.mjs
// ============================================
//
// 职责：演示检索记忆 Agent（带完整调试日志和错误检查）
//
// 【检索记忆失败的 3 大常见原因】（血泪经验，务必阅读）
//
// 原因 1：save() 没有 await → 数据根本没写入 Milvus
//   - retrievalMemory.save() 是异步的（要调 Embedding API + 写 Milvus）
//   - 如果 HybridMemory.save() 没声明 async，调用处没 await
//   - 程序会在数据还没写入时就继续执行下一轮，甚至直接退出
//   - 结果：Milvus 里永远是空的，search 永远返回 []
//   - 修复：save() 声明 async + await Promise.all([...]) + 调用处 await
//
// 原因 2：Collection 残留脏数据 → schema/维度不匹配
//   - 第一次运行创建了 Collection（dim=1024）
//   - 如果第一次运行有 bug（如向量维度不对），insert 失败但 Collection 已存在
//   - 第二次运行时 hasCollection=true，直接复用旧 Collection
//   - 但旧 Collection 里可能：没有数据、数据维度错误、字段类型不对
//   - 修复：每次测试前 dropCollection() 清理旧数据，确保干净环境
//
// 原因 3：res.entity 访问错误 → 字段在 entity 对象里
//   - Milvus SDK 的 search 返回结构：results[0].entity.content
//   - 不是 results[0].content！直接访问会得到 undefined
//   - 结果：map 出来的内容全是 undefined，SystemMessage 内容为空
//   - 修复：const entity = res.entity || res; entity.content
//
// 原因 4（额外）：向量维度不匹配 → insert 静默失败
//   - OpenAIEmbeddings 默认用 text-embedding-ada-002（1536维）
//   - 如果 model 参数没生效，会 fallback 到默认模型
//   - Collection dim=1024，insert 1536维向量 → 维度不匹配 → 失败
//   - 但 insert 可能不抛异常，而是返回 error_code != 'Success'
//   - 修复：检查 insertResult.status.error_code 和 insertResult.insertCnt
//
// 原因 5（额外）：检索 query 太抽象 → Embedding 找不到匹配
//   - query: "根据我之前告诉你的所有个人信息" → 元话语，语义空洞
//   - 文档: "我叫李明，住杭州" → 具体信息
//   - Embedding 模型无法把"元话语"和"具体信息"关联起来
//   - 修复：query 里包含具体关键词，如"我叫什么名字？我在哪个城市？"
// ============================================

import "dotenv/config"
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { MilvusClient, DataType, IndexType, MetricType } from "@zilliz/milvus2-sdk-node"
import chalk from "chalk"
const model = new ChatOpenAI({
    modelName: process.env.MODEL_NAME,
    apiKey: process.env.API_KEY,
    temperature: 0,
    configuration: {
        baseURL: process.env.BASE_URL
    }
})

const VECTOR_DIM = 1024;

const embedding = new OpenAIEmbeddings({
    apiKey: process.env.API_KEY,
    model: process.env.EMBEDDINGS_MODEL_NAME,
    configuration: {
        baseURL: process.env.BASE_URL
    },
    dimensions: VECTOR_DIM,

})

class RetrievalMemory {
    constructor(embeddings, collectionName = 'retrieval_memory', k = 3) {
        this.initialized = false
        this.client = null
        this.collectionName = collectionName
        this.embeddings = embeddings
        this.k = k
    }
    // 初始化milvus
    async init() {
        if (this.initialized) return
        this.client = new MilvusClient({
            address: process.env.MILVUS_ADDRESS,
        })
        const { value: hasCollection } = await this.client.hasCollection({
            collection_name: this.collectionName
        })
        if (!hasCollection) {
            await this.client.createCollection({
                collection_name: this.collectionName,
                fields: [
                    {
                        name: "id",
                        description: "unique id",
                        data_type: DataType.Int64,
                        is_primary_key: true,
                        autoID: true
                    },
                    {
                        name: "vector",
                        description: "vector field",
                        data_type: DataType.FloatVector,
                        dim: VECTOR_DIM
                    },
                    {
                        name: "content",
                        description: "content field",
                        data_type: DataType.VarChar,
                        max_length: 15000
                    },
                    {
                        name: 'role',
                        description: 'role field',
                        data_type: DataType.VarChar,
                        max_length: 50
                    },
                    {
                        name: 'turn',
                        description: 'turn field',
                        data_type: DataType.Int64,
                    }]
            })
            await this.client.createIndex({
                collection_name: this.collectionName,
                field_name: "vector",
                index_type: IndexType.IVF_FLAT,
                metric_type: MetricType.COSINE,
                params: {
                    nlist: 128
                }
            })
            await this.client.loadCollection({
                collection_name: this.collectionName
            })

        } else {
            await this.client.loadCollection({
                collection_name: this.collectionName
            })
        }
        this.initialized = true
    }

    async save({ role, content, turn }) {
        await this.init()
        const embeddingVector = await this.embeddings.embedDocuments([content])

        // 关键调试：检查向量维度是否与 Collection 一致
        // 如果维度不匹配（如 1536 vs 1024），insert 会静默失败
        if (embeddingVector[0].length !== VECTOR_DIM) {
            console.error(chalk.red(`[ERROR] 向量维度不匹配！期望 ${VECTOR_DIM}，实际 ${embeddingVector[0].length}`))
            console.error(chalk.red(`请检查 EMBEDDINGS_MODEL_NAME 是否配置正确（text-embedding-v3 应为 1024 维）`))
            return
        }

        const insertResult = await this.client.insert({
            collection_name: this.collectionName,
            data: [{ vector: embeddingVector[0], content, role, turn }]
        })

        // 关键调试：检查 insert 是否成功
        if (insertResult.status.error_code !== 'Success') {
            console.error(chalk.red(`[ERROR] Milvus insert 失败: ${insertResult.status.reason}`))
            return
        }
        console.log(chalk.gray(`[Milvus] insert 成功，写入 ${insertResult.insert_cnt || '?'} 条数据`))

        await this.client.flush({
            collection_names: [this.collectionName]
        })
        console.log(chalk.gray(`[Milvus] flush 完成`))
    }
    async load(query) {
        await this.init()
        const embeddingVector = await this.embeddings.embedQuery(query)

        const searchResult = await this.client.search({
            collection_name: this.collectionName,
            vector: embeddingVector,
            limit: this.k,
            output_fields: ['content', 'role', 'turn'],
        })

        // 关键调试：打印完整的 search 返回结构
        console.log(chalk.gray(`[Milvus] search 返回状态: ${searchResult.status?.error_code || 'unknown'}`))

        const results = searchResult.results || []
        if (results.length === 0) {
            console.log(chalk.gray(`[Milvus] search 未找到匹配结果`))
            return []
        }

        console.log(chalk.gray(`[Milvus] search 找到 ${results.length} 条结果`))

        // 关键修复：Milvus SDK 返回的字段在 res.entity 中，不是直接在 res 上
        return results.map(res => {
            const entity = res.entity || res  // 兼容不同 SDK 版本
            const prefix = entity.role === 'user' ? "用户" : "助手"
            return `${prefix} (第${entity.turn}轮)： ${entity.content}`
        })
    }

    async drop() {
        if (!this.client) return;
        await this.client.dropCollection({
            collection_name: this.collectionName
        })
        // 关键：删除后重置初始化状态，否则下次 init() 会跳过创建
        this.initialized = false
        this.client = null
    }

}


class ShortTermMemory {
    constructor({ maxTurns = 2 }) {
        this.maxTurns = maxTurns
        this.messages = []
        this.turn = 0
    }
    load() {
        return this.messages.slice(-this.maxTurns * 2)
    }
    save({ userMessage, aiMessage }) {
        this.turn += 1
        this.messages.push(userMessage, aiMessage)
        if (this.messages.length > this.maxTurns * 2) {
            this.messages = this.messages.slice(-this.maxTurns * 2)
        }
    }
}

class HybridMemory {
    constructor({ retrievalMemory, shortTermMemory }) {
        this.retrievalMemory = retrievalMemory
        this.shortTermMemory = shortTermMemory
    }
    async save({ userMessage, aiMessage }) {
        // 先更新短期记忆的 turn 计数
        this.shortTermMemory.save({ userMessage, aiMessage })
        const turn = this.shortTermMemory.turn

        // 再写入检索记忆（await 确保 Milvus 写入完成）
        await Promise.all([
            this.retrievalMemory.save({ role: 'user', content: String(userMessage.content), turn }),
            this.retrievalMemory.save({ role: 'assistant', content: String(aiMessage.content), turn }),
        ])
    }
    async load(userText) {
        const contextMessages = []
        const shortTermMessages = this.shortTermMemory.load()
        const retrievalMessages = await this.retrievalMemory.load(userText)
        contextMessages.push(...shortTermMessages)
        if (retrievalMessages.length > 0) {
            contextMessages.push(new SystemMessage(`【你的长期记忆】以下是你之前和用户对话中的重要信息，回答时请结合这些记忆：\n\n${retrievalMessages.join('\n\n')}`))
        }
        return contextMessages
    }
}


const testConversation = [
    // === 第一阶段：设置重要个人信息（将被后续遗忘）===
    '我叫李明，28岁，在杭州阿里巴巴做前端开发。我喜欢React，不喜欢Vue。',
    '我平时周末喜欢去西湖跑步，也会去浙江省图书馆看书。',
    '我对花生严重过敏，吃不了任何含花生的食物，包括花生油。',

    // === 第二阶段：闲聊和任务（消耗短期记忆窗口）===
    '今天天气不错，你觉得呢？',
    '帮我写一个简单的React组件，显示当前时间，每秒更新。',
    '再写一个CSS文件，让时间显示居中、字体用24px、颜色用深蓝色。',
    '给我推荐一本适合前端开发者读的进阶书籍。',
    '我想周末去西湖边野餐，需要准备什么？',

    // === 第三阶段：考验长期记忆（关键！）===
    // 注意：query 要包含具体关键词，Embedding 才能匹配到相关内容
    '我叫什么名字？我在哪个城市工作？我的技术栈偏好是什么？',
    '我想在杭州请朋友吃饭，推荐一家适合我的餐厅，要确保没有花生。',
];

async function runAgent(conversation) {
    const systemPrompt = new SystemMessage(
        `你是用户的个人助理。请认真记住用户告诉你的所有个人信息、偏好和约束，在后续对话中主动运用。`,
    );

    const retrievalMemory = new RetrievalMemory(embedding)
    // 关键：先清理旧 Collection，避免之前失败的运行残留脏数据
    // 如果 Collection 已存在但 schema/数据有问题，会导致检索永远失败
    await retrievalMemory.init()
    await retrievalMemory.drop()
    console.log(chalk.gray('[Milvus] 已清理旧 Collection，准备重新创建'))

    const hybridMemory = new HybridMemory({
        retrievalMemory: retrievalMemory,
        shortTermMemory: new ShortTermMemory({ maxTurns: 2 }),
    });

    console.log(chalk.blue('\n' + '='.repeat(70)));


    for (let i = 0; i < conversation.length; i++) {
        const userText = conversation[i];
        console.log(chalk.yellow(`\n[第 ${i + 1} 轮] 用户: ${userText}`));
        const contextMessages = await hybridMemory.load(userText);
        const hasRetrieval = contextMessages.some((message) => message instanceof SystemMessage);
        const shortTermCount = hybridMemory.shortTermMemory.messages.length;
        console.log(chalk.gray(`[Memory] 短期: ${shortTermCount}条 | 检索: ${hasRetrieval ? '✅ 已加载' : '❌ 无'}`));

        // 调试：打印检索到的具体内容（如果有）
        if (hasRetrieval) {
            const retrievalMsg = contextMessages.find((m) => m instanceof SystemMessage);
            console.log(chalk.gray(`[Memory] 检索内容预览: ${retrievalMsg.content.slice(0, 80)}...`));
        }

        const userMessage = new HumanMessage(userText);

        const messages = [systemPrompt, ...contextMessages, userMessage]
        const aiMessage = await model.invoke(messages);
        console.log(chalk.green(`\n[第 ${i + 1} 轮] 助手: ${aiMessage.content}`));
        await hybridMemory.save({ userMessage, aiMessage });
    }
    await retrievalMemory.drop()

}

runAgent(testConversation)
