// ============================================
// retrieval-memory-demo.mjs
// ============================================
//
// 职责：直观演示"检索记忆 vs 无检索记忆"的差异
//
// 设计思路：
//   很多教程说检索记忆好，但没有一个能让你"亲眼看到差异"的例子。
//   这个脚本用同一套对话，分别跑两个 Agent：
//     - Agent A（无检索）：只有 2 轮短期记忆 → 早期信息被丢弃
//     - Agent B（有检索）：2 轮短期记忆 + Milvus 检索 → 早期信息被找回
//
// 对话设计（专门考验长期记忆）：
//   第 1-3 轮：用户设置重要个人信息（名字、工作、偏好、过敏源）
//   第 4-8 轮：闲聊和任务（消耗短期记忆窗口）
//   第 9-10 轮：问需要引用早期信息的问题 → 此时差异出现！
//
// 预期效果：
//   Agent A："不好意思，我不记得你之前说过什么..."
//   Agent B："根据你之前提到的，你叫李明，在阿里做前端，对花生过敏..."
//
// 关键技术：
//   两个 Agent 的短期记忆窗口都设为 2 轮（故意很小）
//   这样第 4 轮之后，第 1-3 轮的信息就已经被挤出短期记忆
//   Agent B 靠 Milvus 检索把早期信息"捞回来"
// ============================================

import 'dotenv/config';
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import { MilvusClient } from '@zilliz/milvus2-sdk-node';
import chalk from 'chalk';

// 配置
const MODEL_CONFIG = {
    modelName: process.env.MODEL_NAME,
    apiKey: process.env.API_KEY,
    temperature: 0,
    configuration: { baseURL: process.env.BASE_URL },
};

const EMBEDDING_CONFIG = {
    model: process.env.EMBEDDINGS_MODEL_NAME,
    apiKey: process.env.API_KEY,
    configuration: { baseURL: process.env.BASE_URL },
};

const MILVUS_ADDRESS = process.env.MILVUS_ADDRESS || '127.0.0.1:19530';
const COLLECTION_NAME = 'retrieval_demo_memory';
const VECTOR_DIM = 1024;

// ============================================
// RetrievalMemory（复用 retrieval-agent.mjs 的核心逻辑）
// ============================================

class RetrievalMemory {
    constructor({ embeddings, collectionName = COLLECTION_NAME, k = 3 }) {
        this.embeddings = embeddings;
        this.collectionName = collectionName;
        this.k = k;
        this.client = null;
        this.initialized = false;
    }

    async init() {
        if (this.initialized) return;
        this.client = new MilvusClient({ address: MILVUS_ADDRESS });
        const { value: hasCollection } = await this.client.hasCollection({
            collection_name: this.collectionName,
        });

        if (!hasCollection) {
            await this.client.createCollection({
                collection_name: this.collectionName,
                fields: [
                    { name: 'id', data_type: 'Int64', is_primary_key: true, autoID: true },
                    { name: 'vector', data_type: 'FloatVector', dim: VECTOR_DIM },
                    { name: 'content', data_type: 'VarChar', max_length: 4096 },
                    { name: 'role', data_type: 'VarChar', max_length: 20 },
                    { name: 'turn', data_type: 'Int64' },
                ],
            });
            await this.client.createIndex({
                collection_name: this.collectionName,
                field_name: 'vector',
                index_type: 'IVF_FLAT',
                metric_type: 'COSINE',
                params: { nlist: 128 },
            });
            await this.client.loadCollection({ collection_name: this.collectionName });
        } else {
            await this.client.loadCollection({ collection_name: this.collectionName });
        }
        this.initialized = true;
    }

    async save({ role, content, turn }) {
        if (!this.initialized) await this.init();
        const vectors = await this.embeddings.embedDocuments([content]);
        await this.client.insert({
            collection_name: this.collectionName,
            data: [{ vector: vectors[0], content, role, turn }],
        });
        await this.client.flush({ collection_names: [this.collectionName] });
    }

    async load(query) {
        if (!this.initialized) await this.init();
        const queryVector = await this.embeddings.embedQuery(query);
        const result = await this.client.search({
            collection_name: this.collectionName,
            vector: queryVector,
            limit: this.k,
            output_fields: ['content', 'role', 'turn'],
        });
        if (!result.results || result.results.length === 0) return [];
        return result.results.map((hit) => {
            const prefix = hit.role === 'user' ? '用户' : '助手';
            return `${prefix}（第${hit.turn}轮）：${hit.content}`;
        });
    }

    async drop() {
        if (!this.client) return;
        await this.client.dropCollection({ collection_name: this.collectionName });
    }
}

// ============================================
// ShortTermMemory：滑动窗口（故意设得很小，演示遗忘）
// ============================================

class ShortTermMemory {
    constructor({ maxTurns = 2 } = {}) {
        this.maxTurns = maxTurns;
        this.messages = [];
        this.turn = 0;
    }

    load() {
        return this.messages.slice(-this.maxTurns * 2);
    }

    save({ userMessage, aiMessage }) {
        this.turn += 1;
        this.messages.push(userMessage, aiMessage);
        if (this.messages.length > this.maxTurns * 2) {
            this.messages = this.messages.slice(-this.maxTurns * 2);
        }
    }
}

// ============================================
// HybridMemory：组合短期 + 检索
// ============================================

class HybridMemory {
    constructor({ retrievalMemory, shortTermMemory, enableRetrieval = true }) {
        this.retrievalMemory = retrievalMemory;
        this.shortTermMemory = shortTermMemory;
        this.enableRetrieval = enableRetrieval;
    }

    async load({ userText }) {
        const shortTermMessages = this.shortTermMemory.load();
        const contextMessages = [...shortTermMessages];

        if (this.enableRetrieval) {
            const retrievalHits = await this.retrievalMemory.load(userText);
            if (retrievalHits.length > 0) {
                contextMessages.push(
                    new SystemMessage(
                        `【你的长期记忆】以下是你之前和用户对话中的重要信息，回答时请结合这些记忆：\n\n${retrievalHits.join('\n\n')}`,
                    ),
                );
            }
        }

        return contextMessages;
    }

    async save({ userMessage, aiMessage }) {
        this.shortTermMemory.save({ userMessage, aiMessage });
        if (this.enableRetrieval) {
            const turn = this.shortTermMemory.turn;
            await Promise.all([
                this.retrievalMemory.save({ role: 'user', content: String(userMessage.content), turn }),
                this.retrievalMemory.save({ role: 'assistant', content: String(aiMessage.content), turn }),
            ]);
        }
    }
}

// ============================================
// 纯对话 Agent（无工具调用，专注展示记忆能力）
// ============================================

async function runChatAgent({ name, hybridMemory, conversation }) {
    const model = new ChatOpenAI(MODEL_CONFIG);
    const systemPrompt = new SystemMessage(
        `你是用户的个人助理。请认真记住用户告诉你的所有个人信息、偏好和约束，在后续对话中主动运用。`,
    );

    console.log(chalk.blue('\n' + '='.repeat(70)));
    console.log(chalk.blue(`🤖 ${name}`));
    console.log(chalk.blue('='.repeat(70)));

    const responses = [];

    for (let i = 0; i < conversation.length; i++) {
        const userText = conversation[i];
        console.log(chalk.yellow(`\n[第 ${i + 1} 轮] 用户: ${userText}`));

        const userMessage = new HumanMessage(userText);

        // 加载记忆上下文
        const memoryMessages = await hybridMemory.load({ userText });
        const hasRetrieval = memoryMessages.some(
            (m) => m.type === 'system' && m.content.includes('长期记忆'),
        );

        // 打印记忆状态
        const shortTermCount = hybridMemory.shortTermMemory.messages.length;
        console.log(chalk.gray(`[Memory] 短期: ${shortTermCount}条 | 检索: ${hasRetrieval ? '✅ 已加载' : '❌ 无'}`));

        // 调用 LLM
        const messages = [systemPrompt, ...memoryMessages, userMessage];
        const aiMessage = await model.invoke(messages);

        console.log(chalk.green(`[第 ${i + 1} 轮] 助手: ${aiMessage.content}`));
        responses.push(aiMessage.content);

        // 保存到记忆
        await hybridMemory.save({ userMessage, aiMessage });
    }

    return responses;
}

// ============================================
// 测试对话（专门设计来考验长期记忆）
// ============================================

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
    '根据我之前告诉你的所有个人信息，用一段话完整总结一下我是谁、有什么特点。不要遗漏重要信息。',
    '我想在杭州请朋友吃饭，推荐一家适合我的餐厅，要确保没有花生。',
];

// ============================================
// 主函数：对比两个 Agent
// ============================================

async function main() {
    const embeddings = new OpenAIEmbeddings(EMBEDDING_CONFIG);

    // 清理旧数据（确保每次运行都是公平对比）
    const tempMemory = new RetrievalMemory({ embeddings });
    await tempMemory.init();
    await tempMemory.drop();
    console.log(chalk.gray('已清理旧测试数据\n'));

    // Agent A：无检索记忆（只有 2 轮短期记忆）
    const agentA = {
        name: 'Agent A（无检索记忆 - 只有2轮短期记忆）',
        hybridMemory: new HybridMemory({
            retrievalMemory: new RetrievalMemory({ embeddings }),
            shortTermMemory: new ShortTermMemory({ maxTurns: 2 }),
            enableRetrieval: false,
        }),
    };

    // Agent B：有检索记忆（2 轮短期 + Milvus 检索）
    const agentB = {
        name: 'Agent B（有检索记忆 - 2轮短期 + Milvus向量检索）',
        hybridMemory: new HybridMemory({
            retrievalMemory: new RetrievalMemory({ embeddings }),
            shortTermMemory: new ShortTermMemory({ maxTurns: 2 }),
            enableRetrieval: true,
        }),
    };

    // 先跑 Agent A
    const responsesA = await runChatAgent({
        name: agentA.name,
        hybridMemory: agentA.hybridMemory,
        conversation: testConversation,
    });

    // 再跑 Agent B
    const responsesB = await runChatAgent({
        name: agentB.name,
        hybridMemory: agentB.hybridMemory,
        conversation: testConversation,
    });

    // ============================================
    // 对比总结
    // ============================================
    console.log(chalk.magenta('\n' + '='.repeat(70)));
    console.log(chalk.magenta('📊 对比总结'));
    console.log(chalk.magenta('='.repeat(70)));

    const keyTurns = [9, 10]; // 第 9-10 轮是考验长期记忆的关键轮次
    for (const turn of keyTurns) {
        console.log(chalk.magenta(`\n--- 第 ${turn} 轮对比 ---`));
        console.log(chalk.red(`Agent A: ${responsesA[turn - 1].slice(0, 150)}...`));
        console.log(chalk.green(`Agent B: ${responsesB[turn - 1].slice(0, 150)}...`));
    }

    console.log(chalk.magenta('\n' + '='.repeat(70)));
    console.log(chalk.magenta('💡 结论'));
    console.log(chalk.magenta('='.repeat(70)));
    console.log(chalk.white(`
Agent A（无检索记忆）：
  - 第 9-10 轮时，短期记忆只保留了最近 2 轮
  - 第 1-3 轮的个人信息（名字、工作、过敏源）已被遗忘
  - 只能回答"不好意思，我不记得了"或瞎编

Agent B（有检索记忆）：
  - 第 1-3 轮的信息被向量化存入了 Milvus
  - 第 9-10 轮提问时，通过相似度检索找回了早期记忆
  - 能准确引用用户的名字、工作、城市、偏好、过敏源

这就是检索记忆的价值：它让 Agent 拥有了"长期记忆"的能力，
即使对话很长，也不会遗忘重要的用户信息。
  `));
}

main().catch((error) => {
    console.error(chalk.red('\n❌ 运行失败:'), error.message);
    process.exit(1);
});
