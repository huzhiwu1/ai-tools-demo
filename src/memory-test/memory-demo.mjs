import "dotenv/config";
import chalk from "chalk";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { InMemoryChatMessageHistory } from "@langchain/core/chat_history";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { Document } from "@langchain/core/documents";
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";

// 这个脚本只做一件事：用 4 种“记忆策略”跑同一段对话，让你对比差异。
//
// 每一轮对话，Agent 都按这个顺序工作：
// 1) memory.load：把“要带给模型的上下文”取出来
// 2) llm.invoke：把【人设 + 记忆 + 当前问题】发给模型
// 3) memory.save：把【本轮问答】存进记忆

function createLLM() {
  // 这是“对话模型”（负责生成回答）
  const apiKey = process.env.API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey || !process.env.MODEL_NAME) {
    throw new Error(
      "缺少环境变量：请设置 API_KEY(或 OPENAI_API_KEY) 和 MODEL_NAME",
    );
  }

  const llm = new ChatOpenAI({
    model: process.env.MODEL_NAME,
    apiKey,
    temperature: 0,
    configuration:
      process.env.OPENAI_BASE_URL || process.env.BASE_URL ?
        { baseURL: process.env.OPENAI_BASE_URL || process.env.BASE_URL }
      : undefined,
  });
  return llm;
}

function createEmbeddings() {
  // 这是“向量模型”（负责把文本变成向量，给检索记忆用）
  const apiKey = process.env.API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey || !process.env.EMBEDDINGS_MODEL_NAME) {
    throw new Error(
      "缺少环境变量：请设置 API_KEY(或 OPENAI_API_KEY) 和 EMBEDDINGS_MODEL_NAME",
    );
  }

  const embeddings = new OpenAIEmbeddings({
    model: process.env.EMBEDDINGS_MODEL_NAME,
    apiKey,
    configuration:
      process.env.OPENAI_BASE_URL || process.env.BASE_URL ?
        { baseURL: process.env.OPENAI_BASE_URL || process.env.BASE_URL }
      : undefined,
  });
  return embeddings;
}

function previewMessages(messages) {
  if (!messages.length) return "（空）";
  return messages
    .slice(0, 3)
    .map((m, i) => {
      const type = m.type || "message";
      const content = String(m.content || "").replaceAll("\n", " ");
      return `${i + 1}. ${type}: ${content.slice(0, 60)}${content.length > 60 ? "..." : ""}`;
    })
    .join("\n");
}

async function runTurn({ llm, persona, memory, userText }) {
  // ====== 关键流程 #1：从 memory 里取“要带给模型的上下文” ======
  // 不同 Memory 策略，差异主要就在这一步：
  // - Buffer：把所有历史消息都拿出来
  // - Window：只拿最近 N 轮
  // - Summary：拿“摘要 + 最近 N 轮”
  // - Retrieval：用当前问题检索出相关片段
  //
  // 关键点（可扩展）：
  // - 上下文太长会烧 token：Window/Summary 就是为了解决这个
  // - 上下文里如果混入“无关信息”，模型容易跑偏：Retrieval 就是为了“按需取用”
  // - 上下文里如果出现“过时信息”，模型会按旧约束回答：需要“更新/覆盖/删除记忆”的策略
  const memoryMessages = await memory.load({ userText });
  console.log(chalk.gray("\n[memory.load] 取到的上下文："));
  console.log(chalk.gray(previewMessages(memoryMessages)));

  const userMessage = new HumanMessage(userText);

  // ====== 关键流程 #2：把【人设 + 记忆 + 当前问题】发给模型 ======
  // 关键点（可扩展）：
  // - persona（人设）通常放最前面，起“全局规则”的作用
  // - memoryMessages 是“你希望模型记住/参考的内容”，它们不是模型自动拥有的
  // - userMessage 是本轮问题，一般放最后，避免被上文淹没
  const aiMessage = await llm.invoke([persona, ...memoryMessages, userMessage]);

  // ====== 关键流程 #3：把本轮问答写回 memory ======
  // 关键点（可扩展）：
  // - 并不是所有内容都应该写入记忆：例如一次性的寒暄、无意义噪音
  // - 生产里会做“写入门槛”：比如只写用户偏好/约束/长期目标
  // - 也会做“脱敏”：不要把隐私/密钥写入长期记忆
  await memory.save({ userMessage, aiMessage });

  return { userMessage, aiMessage };
}

class BufferMemory {
  constructor() {
    this.name = "1) Buffer：全量对话（最像你原始代码）";
    this.history = new InMemoryChatMessageHistory();
  }

  async load() {
    // Buffer 的“读记忆”：把所有历史消息原样取出
    //
    // 关键点（可扩展）：
    // - 优点：实现最简单，效果直观
    // - 缺点：对话越长越贵（token 越来越多），也更容易混入无关内容
    // - 常见改进：加“窗口”或“摘要”，或者在写入时做筛选
    return await this.history.getMessages();
  }

  async save({ userMessage, aiMessage }) {
    // Buffer 的“写记忆”：每轮追加 2 条消息（用户 + 助手）
    //
    // 关键点（可扩展）：
    // - 这里是“原样追加”，意味着你会把模型的每次回答也记住
    // - 如果模型偶尔胡说八道，也可能被记进历史，影响后续（可用 Summary/Retrieval 减轻）
    await this.history.addMessage(userMessage);
    await this.history.addMessage(aiMessage);
  }
}

class WindowMemory {
  constructor({ maxTurns = 2 } = {}) {
    this.name = `2) Window：最近 ${maxTurns} 轮`;
    this.maxTurns = maxTurns;
    this.messages = [];
  }

  async load() {
    // Window 的“读记忆”：只拿最近 maxTurns 轮（1 轮 = 用户 + 助手 = 2 条）
    //
    // 关键点（可扩展）：
    // - 它解决的是“对话太长”的问题：固定上限，成本可控
    // - 代价是：更早的信息可能被忘掉（比如用户早早说过“我不吃辣”）
    // - 常见改进：Window + Summary（把长期信息写进摘要）
    return this.messages.slice(-this.maxTurns * 2);
  }

  async save({ userMessage, aiMessage }) {
    // Window 的“写记忆”：追加后再裁剪，保证最多只留 maxTurns 轮
    //
    // 关键点（可扩展）：
    // - 裁剪发生在写入后，所以永远保持最近的 N 轮
    // - maxTurns 建议从 2~6 试起，越大越“记得多”，越小越省 token
    this.messages.push(userMessage, aiMessage);
    this.messages = this.messages.slice(-this.maxTurns * 2);
  }
}

class SummaryMemory {
  constructor({ llm, keepRecentTurns = 2 } = {}) {
    this.name = `3) Summary：摘要 + 最近 ${keepRecentTurns} 轮`;
    this.llm = llm;
    this.keepRecentTurns = keepRecentTurns;
    this.summary = "";
    this.recent = [];
  }

  async load() {
    // Summary 的“读记忆”分两块：
    // - summary：长期记忆（压缩后的摘要）
    // - recent：短期记忆（保留最近细节，避免摘要丢信息）
    //
    // 关键点（可扩展）：
    // - summary 用 SystemMessage 放进去，相当于“稳定背景信息”
    // - recent 用来保留“刚发生的细节”，因为摘要不一定能覆盖所有细节
    // - 这就是“长期记忆 + 工作记忆”的组合
    const summaryMsg =
      this.summary ?
        [new SystemMessage(`这是对话摘要（长期记忆）：\n${this.summary}`)]
      : [];

    const recentMsg = this.recent.slice(-this.keepRecentTurns * 2);
    return [...summaryMsg, ...recentMsg];
  }

  async save({ userMessage, aiMessage }) {
    // 先把“最近对话”存起来（短期记忆）
    this.recent.push(userMessage, aiMessage);
    this.recent = this.recent.slice(-this.keepRecentTurns * 2);

    // 再让模型“更新摘要”（长期记忆）
    //
    // 关键点（可扩展）：
    // - 摘要是“二次生成”，可能会写错/写漏（叫做漂移）
    // - 解决思路：
    //   - 摘要提示词要强调：只写稳定信息（偏好/约束/目标/已决定事项）
    //   - 同时保留 recent（防止摘要漏掉刚才细节）
    // - 另一种做法：只把用户信息做摘要，不把助手的发挥写进去（更稳）
    const prompt = [
      new SystemMessage(
        [
          "你是“记忆摘要器”。请把对话浓缩成后续有用的记忆：",
          "- 只保留稳定信息：偏好/约束/目标/已决定事项",
          "- 不要逐句复述",
          "- 最多 5 行",
          "只输出摘要本身。",
        ].join("\n"),
      ),
      new HumanMessage(
        [
          `旧摘要：${this.summary || "（空）"}`,
          "",
          `新增对话：`,
          `用户：${userMessage.content}`,
          `助手：${aiMessage.content}`,
        ].join("\n"),
      ),
    ];

    const res = await this.llm.invoke(prompt);
    this.summary = String(res.content || "").trim();
    console.log(chalk.gray("\n[summary] 更新后的摘要："));
    console.log(chalk.gray(this.summary || "（空）"));
  }
}

class RetrievalMemory {
  constructor({ vectorStore, k = 3 } = {}) {
    this.name = `4) Retrieval：向量检索（TopK=${k}）`;
    this.vectorStore = vectorStore;
    this.k = k;
    this.turn = 0;
  }

  async load({ userText }) {
    // Retrieval 的“读记忆”：
    // - 把“当前问题”当成 query
    // - 去向量库里找最相关的 k 条“过去片段”
    //
    // 关键点（可扩展）：
    // - 它不是“把所有历史都塞进去”，而是“按需找最相关的”
    // - 适合超长对话、超多记忆的场景（理论上可无限增长）
    // - 代价是：需要 embeddings（向量模型），并且检索可能“找错”或“漏找”
    // - 常见改进：
    //   - 记忆入库时分类型：偏好/事实/任务/闲聊，检索时优先取“偏好/事实”
    //   - 给记忆加过滤条件（metadata filter），例如只检索 kind=preference
    const docs = await this.vectorStore.similaritySearch(
      String(userText),
      this.k,
    );
    if (!docs.length) return [];

    const hits = docs
      .map((d, i) => `记忆片段 ${i + 1}：${d.pageContent}`)
      .join("\n");

    return [
      new SystemMessage(
        `这是检索到的相关记忆（不一定完全准确，用来帮你回忆）：\n${hits}`,
      ),
    ];
  }

  async save({ userMessage, aiMessage }) {
    // Retrieval 的“写记忆”：把每轮对话当成一条 Document 写入向量库
    //
    // 关键点（可扩展）：
    // - 入库内容越干净越好：推荐只写“用户偏好/约束/事实/结论”，少写废话
    // - 文本越长，embedding 越贵；可以把长对话压缩后再入库（类似 Summary 的思路）
    // - metadata 很重要：未来可用于过滤、去重、删除、权限控制
    this.turn += 1;
    await this.vectorStore.addDocuments([
      new Document({
        pageContent: `用户：${userMessage.content}\n助手：${aiMessage.content}`,
        metadata: { turn: this.turn },
      }),
    ]);
  }
}

async function runOneMemory({ llm, persona, memory }) {
  // 用“同一套问题”分别跑不同 memory，方便你直接对比输出差异
  console.log(chalk.blue("\n" + "=".repeat(80)));
  console.log(chalk.blue(memory.name));
  console.log(chalk.blue("=".repeat(80)));

  const questions = [
    "你今天吃的什么？",
    "你刚才提到的那道菜，适合新手吗？",
    "我不太能吃辣，而且想更健康一点，你给我一个改良版做法。",
    "把你记住的我的饮食限制总结成 3 条。",
  ];

  for (const q of questions) {
    const { userMessage, aiMessage } = await runTurn({
      llm,
      persona,
      memory,
      userText: q,
    });

    console.log(chalk.yellow("\n用户: ") + userMessage.content);
    console.log(chalk.green("助手: ") + aiMessage.content);
  }
}

async function main() {
  const llm = createLLM();
  const persona = new SystemMessage(
    "你是一个友好、幽默的做菜助手，喜欢分享美食和烹饪技巧。",
  );

  // 先跑 3 个不需要向量库的策略
  await runOneMemory({ llm, persona, memory: new BufferMemory() });
  await runOneMemory({
    llm,
    persona,
    memory: new WindowMemory({ maxTurns: 2 }),
  });
  await runOneMemory({
    llm,
    persona,
    memory: new SummaryMemory({ llm, keepRecentTurns: 2 }),
  });

  // 最后跑检索记忆：需要 embeddings + vector store
  const embeddings = createEmbeddings();
  const vectorStore = await MemoryVectorStore.fromExistingIndex(embeddings);
  await runOneMemory({
    llm,
    persona,
    memory: new RetrievalMemory({ vectorStore, k: 3 }),
  });
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
