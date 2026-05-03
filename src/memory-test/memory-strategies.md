# AI Agent 记忆管理策略详解

> 本文基于 `memory-demo.mjs` 的四种记忆实现，系统讲解 AI Agent 中"记忆"的设计思路、实现方式与选型建议。

---

## 一、为什么 Agent 需要"记忆"？

大语言模型（LLM）本身是无状态的——每次调用都是独立的，它不会自动记住你上一句说了什么。要让 Agent 具备"连续对话"的能力，必须在外部维护一份**对话历史**，并在每次调用模型时把相关上下文带进去。

这就是"记忆系统"的核心职责：

```
┌─────────────┐     load      ┌─────────────┐
│   Memory    │ ────────────> │  构造 Prompt │
│   (记忆库)   │               │ (人设+历史+新问题)
└─────────────┘               └─────────────┘
       ^                            │
       │           save             │ invoke
       └────────────────────────────┘
                              LLM 返回回答
```

每一次对话轮次都遵循 **load → invoke → save** 三步循环：

1. **load**：从记忆中提取"需要带给模型的上下文"
2. **invoke**：将【人设 + 记忆 + 当前问题】发给 LLM
3. **save**：将本轮问答写回记忆，供下一轮使用

---

## 二、代码中的四种记忆策略

### 2.1 Buffer Memory —— 全量对话历史

**核心思想**：把所有历史消息原样保存，原样取出。

```js
class BufferMemory {
  constructor() {
    this.history = new InMemoryChatMessageHistory();
  }

  async load() {
    // 把所有历史消息全部取出
    return await this.history.getMessages();
  }

  async save({ userMessage, aiMessage }) {
    // 每轮追加 2 条消息（用户提问 + 助手回答）
    await this.history.addMessage(userMessage);
    await this.history.addMessage(aiMessage);
  }
}
```

| 优点                 | 缺点                               |
| -------------------- | ---------------------------------- |
| 实现最简单，效果直观 | 对话越长，token 消耗越多，成本越高 |
| 信息无丢失           | 容易混入无关内容，干扰模型判断     |

**适用场景**：短对话、调试阶段、对成本不敏感的场景。

---

### 2.2 Window Memory —— 滑动窗口

**核心思想**：只保留最近 `N` 轮对话，旧的自动丢弃。

```js
class WindowMemory {
  constructor({ maxTurns = 2 } = {}) {
    this.maxTurns = maxTurns;
    this.messages = [];
  }

  async load() {
    // 只拿最近 maxTurns 轮（1轮 = 用户 + 助手 = 2条）
    return this.messages.slice(-this.maxTurns * 2);
  }

  async save({ userMessage, aiMessage }) {
    this.messages.push(userMessage, aiMessage);
    // 写入后裁剪，保证最多只留 maxTurns 轮
    this.messages = this.messages.slice(-this.maxTurns * 2);
  }
}
```

| 优点                    | 缺点                                           |
| ----------------------- | ---------------------------------------------- |
| 固定上限，成本可控      | 早期信息会被遗忘（比如用户开篇说的"我不吃辣"） |
| 实现简单，无需 LLM 参与 | 无法保留长期偏好/约束                          |

**适用场景**：中等长度对话、对 token 成本敏感、无需长期记忆的场景。  
**参数建议**：`maxTurns` 从 2~6 开始尝试，越大"记得越多"，越小越省 token。

---

### 2.3 Summary Memory —— 摘要 + 近期窗口

**核心思想**：用 LLM 定期把对话浓缩成摘要（长期记忆），同时保留最近几轮原始对话（短期记忆/工作记忆）。

```js
class SummaryMemory {
  constructor({ llm, keepRecentTurns = 2 } = {}) {
    this.llm = llm;              // 需要一个独立的 LLM 来做摘要
    this.summary = "";           // 长期记忆：压缩后的摘要
    this.recent = [];            // 短期记忆：保留最近细节
  }

  async load() {
    const summaryMsg = this.summary
      ? [new SystemMessage(`这是对话摘要（长期记忆）：\n${this.summary}`)]
      : [];
    const recentMsg = this.recent.slice(-this.keepRecentTurns * 2);
    return [...summaryMsg, ...recentMsg];
  }

  async save({ userMessage, aiMessage }) {
    // 1. 更新短期记忆
    this.recent.push(userMessage, aiMessage);
    this.recent = this.recent.slice(-this.keepRecentTurns * 2);

    // 2. 让模型更新长期摘要
    const prompt = [
      new SystemMessage(
        "你是'记忆摘要器'。请把对话浓缩成后续有用的记忆：\n" +
        "- 只保留稳定信息：偏好/约束/目标/已决定事项\n" +
        "- 不要逐句复述，最多 5 行"
      ),
      new HumanMessage(
        `旧摘要：${this.summary}\n新增对话：\n用户：${userMessage.content}\n助手：${aiMessage.content}`
      ),
    ];
    const res = await this.llm.invoke(prompt);
    this.summary = String(res.content).trim();
  }
}
```

| 优点                   | 缺点                                        |
| ---------------------- | ------------------------------------------- |
| 兼顾长期信息与近期细节 | 摘要是"二次生成"，可能写错/写漏（漂移问题） |
| 成本远低于保留全量历史 | 需要额外的 LLM 调用，增加延迟和成本         |

**关键设计**：这就是**长期记忆 + 工作记忆**的组合，和人类记忆机制类似——你能记住昨天晚饭的细节（近期），也能记住自己不吃香菜（长期摘要）。

**摘要提示词技巧**：强调只提取**稳定信息**（偏好、约束、目标、已决定事项），不要逐句复述，避免漂移。

---

### 2.4 Retrieval Memory —— 向量检索记忆

**核心思想**：不把历史消息直接塞进 Prompt，而是把每轮对话变成向量存入向量数据库。需要用的时候，拿当前问题做 query，检索最相关的 `k` 条历史片段。

```js
class RetrievalMemory {
  constructor({ vectorStore, k = 3 } = {}) {
    this.vectorStore = vectorStore;  // 如 MemoryVectorStore / Milvus
    this.k = k;
    this.turn = 0;
  }

  async load({ userText }) {
    // 用当前问题检索最相关的 k 条历史
    const docs = await this.vectorStore.similaritySearch(String(userText), this.k);
    const hits = docs.map((d, i) => `记忆片段 ${i + 1}：${d.pageContent}`).join("\n");
    return [
      new SystemMessage(`这是检索到的相关记忆：\n${hits}`),
    ];
  }

  async save({ userMessage, aiMessage }) {
    this.turn += 1;
    await this.vectorStore.addDocuments([
      new Document({
        pageContent: `用户：${userMessage.content}\n助手：${aiMessage.content}`,
        metadata: { turn: this.turn },
      }),
    ]);
  }
}
```

| 优点                       | 缺点                            |
| -------------------------- | ------------------------------- |
| 理论上记忆可无限增长       | 需要 embedding 模型，增加复杂度 |
| 只取"相关"内容，噪音少     | 检索可能"找错"或"漏找"          |
| 可配合 metadata 做高级过滤 | 入库内容质量直接影响效果        |

**适用场景**：超长对话、海量知识库、需要按需回忆的场景（如客服、个人知识助理）。

**入库优化建议**：

- 内容越干净越好，推荐只写"用户偏好/约束/事实/结论"
- 长对话可先压缩再入库（结合 Summary 思路）
- metadata 很重要：可用于过滤、去重、删除、权限控制

---

## 三、四种策略对比一览

| 策略          | 核心机制    | 成本趋势 | 信息保真度               | 实现复杂度 | 典型场景           |
| ------------- | ----------- | -------- | ------------------------ | ---------- | ------------------ |
| **Buffer**    | 全量保留    | 线性增长 | 100%                     | 低         | 短对话、调试       |
| **Window**    | 滑动截断    | 固定上限 | 近期高、远期丢失         | 低         | 中等对话、成本敏感 |
| **Summary**   | 摘要 + 窗口 | 缓慢增长 | 稳定信息高、细节可能丢失 | 中         | 长对话、需长期记忆 |
| **Retrieval** | 向量检索    | 检索固定 | 依赖相关性               | 高         | 超长对话、海量记忆 |

---

## 四、进阶概念扩展

### 4.1 记忆的分层架构

生产级 Agent 通常不会只用单一策略，而是组合多层记忆：

```
┌─────────────────────────────────────────────┐
│  Layer 4: 外部知识库 (向量检索 / RAG)          │  ← 检索相关文档/历史
│  Layer 3: 长期记忆 (摘要 / 用户画像 / 偏好库)   │  ← 跨会话持久化
│  Layer 2: 短期记忆 (窗口 / 缓存)               │  ← 当前会话内
│  Layer 1: 工作记忆 (当前轮次 Prompt)           │  ← 即时上下文
└─────────────────────────────────────────────┘
```

### 4.2 记忆的"写入门槛"

不是所有对话内容都值得存入长期记忆：

- **应该写**：用户偏好（"我不吃辣"）、约束条件（"预算 5000"）、已确认事项（"会议定在周三"）、长期目标
- **不该写**：一次性寒暄、无意义噪音、临时性内容、敏感隐私/密钥

生产系统中常做"写入筛选"：先用一个小模型或规则判断这条信息是否值得长期保存。

### 4.3 记忆的更新与遗忘

人脑会遗忘，Agent 的记忆也需要"新陈代谢"：

- **更新**：用户偏好变了（以前不吃辣，现在能吃微辣），需要覆盖旧记忆
- **过期**：临时约束过了有效期，需要自动清理
- **冲突解决**：新旧记忆矛盾时，需要优先级策略（时间近的优先？用户明确确认的优先？）

### 4.4 记忆脱敏

不要把以下信息写入长期记忆或日志：

- API Key、密码、Token
- 用户身份证号、手机号等 PII（个人身份信息）
- 用户未授权分享的隐私内容

### 4.5 其他记忆变体

| 变体                                   | 说明                                                       |
| -------------------------------------- | ---------------------------------------------------------- |
| **Entity Memory**                      | 抽取对话中的实体（人名、地点、概念）单独维护，类似知识图谱 |
| **Conversation Entity Store**          | LangChain 内置，自动识别并更新实体状态                     |
| **Vector Store + Conversation Buffer** | 组合策略：近期用 Buffer，远期用向量检索                    |
| **Time-weighted Retrieval**            | 向量检索时加入时间衰减因子，越新的记忆权重越高             |

---

## 五、选型建议

如果你是初学者，建议按这个路径演进：

1. **起步阶段**：用 **Buffer Memory**，理解记忆的基本 load/save 流程
2. **优化成本**：切换到 **Window Memory**，控制 token 上限
3. **需要长期记忆**：引入 **Summary Memory**，让 Agent 记住用户偏好
4. **海量场景**：升级为 **Retrieval Memory**（配合 Milvus/Pinecone 等向量数据库）
5. **生产环境**：组合多层记忆（工作记忆 + 短期窗口 + 长期摘要 + 向量知识库）

---

## 六、核心代码流程回顾

```js
async function runTurn({ llm, persona, memory, userText }) {
  // 1. 从记忆中提取上下文（不同策略差异主要体现在这里）
  const memoryMessages = await memory.load({ userText });

  const userMessage = new HumanMessage(userText);

  // 2. 人设 + 记忆 + 当前问题 → 发给 LLM
  const aiMessage = await llm.invoke([persona, ...memoryMessages, userMessage]);

  // 3. 把本轮问答写回记忆
  await memory.save({ userMessage, aiMessage });

  return { userMessage, aiMessage };
}
```

理解这三步，就理解了 AI Agent 记忆管理的核心。
