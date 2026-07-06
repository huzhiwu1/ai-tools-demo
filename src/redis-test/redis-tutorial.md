# Redis 渐进式学习教程

> 本教程通过 5 个渐进式练习，带你从零掌握 Redis 核心功能，最终实现基于 Redis 的 AI Agent 记忆系统。

---

## 目录

1. [教程概览](#教程概览)
2. [环境准备](#环境准备)
3. [Task 01: 基础连接与 String 操作](#task-01-基础连接与-string-操作)
4. [Task 02: Hash 哈希与 List 列表](#task-02-hash-哈希与-list-列表)
5. [Task 03: Set、ZSet、Bitmap、Geo](#task-03-setzsetbitmapgeo)
6. [Task 04: 分布式锁与发布订阅](#task-04-分布式锁与发布订阅)
7. [Task 05: AI Agent 记忆系统](#task-05-ai-agent-记忆系统)
8. [Redis 核心数据类型速查表](#redis-核心数据类型速查表)
9. [最佳实践与常见坑](#最佳实践与常见坑)

---

## 教程概览

### 学习路线

```
Task 01 (基础)
  ↓ 掌握 Redis 连接和 String 操作
Task 02 (进阶)
  ↓ 学习 Hash 和 List 两种复杂结构
Task 03 (高级)
  ↓ 掌握 Set、ZSet、Bitmap、Geo 四种高级类型
Task 04 (工程)
  ↓ 分布式锁、Pub/Sub、Pipeline、事务
Task 05 (实战)
  └ 基于 Redis 实现 AI Agent 短期记忆系统
```

### 每个 Task 包含

| 内容     | 说明                     |
| -------- | ------------------------ |
| 学习目标 | 明确本任务要掌握的知识点 |
| 核心概念 | 关键理论和数据结构       |
| 代码示例 | 可直接运行的完整代码     |
| 知识扩展 | 原理讲解和实际应用场景   |
| 练习任务 | 动手实践，加深理解       |

---

## 环境准备

### 1. 安装依赖

```bash
cd src/redis-test
pnpm install
```

### 2. 启动 Redis（Docker）

```bash
# 启动 Redis 服务器 + RedisInsight GUI
docker compose up -d

# 检查 Redis 是否运行
docker compose ps
```

**服务说明：**

| 服务         | 端口 | 说明                         |
| ------------ | ---- | ---------------------------- |
| Redis Server | 6379 | Redis 主服务                 |
| RedisInsight | 5540 | 官方 Web GUI（类似 pgAdmin） |

访问 RedisInsight: http://localhost:5540

### 3. 配置环境变量

```bash
# 复制示例配置
cp .env.example .env

# 编辑 .env 文件，填写 API Key（Task 05 需要）
```

### 4. 验证连接

```bash
# 使用 redis-cli 测试连接
docker exec -it agent_redis redis-cli ping
# 应返回: PONG
```

---

## Task 01: 基础连接与 String 操作

### 学习目标

1. 掌握 ioredis 客户端连接方式
2. 学会 String 类型的增删改查
3. 理解 key 过期时间（TTL）的概念
4. 掌握计数器和分布式锁的基础用法

### 核心概念

**String 字符串** 是 Redis 最基础的数据类型，看似简单但功能强大：

| 特性     | 说明                                     |
| -------- | ---------------------------------------- |
| 值类型   | 字符串（可以是数字、文本、JSON、二进制） |
| 最大容量 | 单个 value 最大 512MB                    |
| 典型场景 | 验证码、Token、计数器、分布式锁、配置项  |

**Key 命名规范：**

```
业务:资源:标识
示例：
  sms:code:13800138000    # 手机验证码
  session:token:adf245kj  # 登录 Token
  counter:article:1024    # 文章阅读量
  lock:order:2001         # 订单处理锁
```

### 运行代码

```bash
node src/exercise-01.mjs
```

### 关键命令速查

| 命令                    | 说明               | 示例                        |
| ----------------------- | ------------------ | --------------------------- |
| `SET key value`         | 设置键值对         | `SET name "张三"`           |
| `GET key`               | 获取值             | `GET name`                  |
| `SET key value EX 秒数` | 设置并指定过期时间 | `SET code "6666" EX 300`    |
| `TTL key`               | 查看剩余存活时间   | `TTL code`                  |
| `INCR key`              | 自增 1（原子操作） | `INCR counter:article:1024` |
| `DECR key`              | 自减 1             | `DECR counter:article:1024` |
| `SETNX key value`       | 不存在才设置       | `SETNX lock "locked"`       |
| `MSET k1 v1 k2 v2`      | 批量设置           | `MSET a 1 b 2 c 3`          |
| `MGET k1 k2`            | 批量获取           | `MGET a b c`                |
| `DEL key`               | 删除 key           | `DEL name`                  |
| `EXISTS key`            | 检查 key 是否存在  | `EXISTS name`               |

### 知识扩展：为什么 String 适合做计数器？

Redis 的 `INCR` / `DECR` 是 **原子操作**，即使 100 个请求同时执行，也不会出现数据竞争：

```
请求A: INCR counter  → 1
请求B: INCR counter  → 2
请求C: INCR counter  → 3
```

如果用数据库实现，需要加锁或使用乐观锁，代码复杂且性能差。

---

## Task 02: Hash 哈希与 List 列表

### 学习目标

1. 掌握 Hash 类型的字段级操作（适合存储结构化数据）
2. 掌握 List 类型的双端操作（适合队列、历史列表）
3. 理解 Hash 与 String 的区别：Hash 可以只修改一个字段，不用整体覆盖
4. 掌握 List 的阻塞式弹出（实现简单消息队列）

### 核心概念

#### Hash 哈希

**类比理解：** Hash 就像一个对象/字典，每个 key 对应多个 field-value 对。

```
user:1001
  ├── name: "李四"
  ├── age: 28
  ├── phone: "13800138000"
  └── city: "上海"
```

**优势：**

- 只修改一个字段，不用整体读写
- 内存占用比多个 String 更小（内部优化）
- 适合存储用户信息、商品资料、购物车

#### List 列表

**类比理解：** List 就像一个数组，支持从两端插入和弹出。

```
lpush → [头] 任务3, 任务2, 任务1 [尾] ← rpush
         ↑                      ↑
        lpop                   rpop
```

**优势：**

- `lpush` + `rpop` = 队列（FIFO 先进先出）
- `lpush` + `lpop` = 栈（LIFO 后进先出）
- 适合消息队列、任务队列、浏览历史

### 运行代码

```bash
node src/exercise-02.mjs
```

### Hash 命令速查

| 命令                     | 说明             |
| ------------------------ | ---------------- |
| `HSET key field value`   | 设置字段值       |
| `HGET key field`         | 获取字段值       |
| `HMSET key f1 v1 f2 v2`  | 批量设置字段     |
| `HGETALL key`            | 获取所有字段和值 |
| `HKEYS key`              | 获取所有字段名   |
| `HVALS key`              | 获取所有字段值   |
| `HLEN key`               | 获取字段数量     |
| `HINCRBY key field 增量` | 字段自增         |
| `HDEL key field`         | 删除字段         |
| `HEXISTS key field`      | 判断字段是否存在 |

### List 命令速查

| 命令              | 说明                |
| ----------------- | ------------------- |
| `LPUSH key value` | 从左侧（头部）插入  |
| `RPUSH key value` | 从右侧（尾部）插入  |
| `LRANGE key 0 -1` | 获取所有元素        |
| `LPOP key`        | 从左侧弹出          |
| `RPOP key`        | 从右侧弹出          |
| `LLEN key`        | 获取长度            |
| `LTRIM key 0 4`   | 裁剪（保留前 5 条） |

---

## Task 03: Set、ZSet、Bitmap、Geo

### 学习目标

1. 掌握 Set 集合的去重和集合运算（交集、并集、差集）
2. 掌握 ZSet 有序集合的排行榜实现
3. 理解 Bitmap 位图的极致内存优化
4. 掌握 Geo 地理位置的存储和距离计算

### 核心概念

#### Set 集合

**特性：** 自动去重、无序、支持集合运算

**典型场景：**

- 每日签到（自动去重重复签到）
- IP 黑名单
- 共同好友（交集）
- 权限标签

#### ZSet 有序集合

**特性：** 每个元素关联一个分数（score），按分数排序

**典型场景：**

- 课程热度排行榜
- 用户积分排名
- 文章热度排序

#### Bitmap 位图

**特性：** 用 bit 位存储布尔值，极致节省内存

**内存对比：**

```
100 万用户签到状态：
  String: 100万 × 1字节 = 1MB
  Bitmap: 100万 ÷ 8 = 125KB（节省 8 倍）
```

#### Geo 地理位置

**特性：** 存储经纬度，支持距离计算和范围搜索

**典型场景：**

- 附近门店搜索
- 两地距离计算
- 附近的人

### 运行代码

```bash
node src/exercise-03.mjs
```

### Set 命令速查

| 命令                  | 说明             |
| --------------------- | ---------------- |
| `SADD key value`      | 添加元素         |
| `SMEMBERS key`        | 获取所有元素     |
| `SISMEMBER key value` | 判断是否在集合中 |
| `SCARD key`           | 获取集合大小     |
| `SINTER key1 key2`    | 交集             |
| `SUNION key1 key2`    | 并集             |
| `SDIFF key1 key2`     | 差集             |
| `SREM key value`      | 删除元素         |

### ZSet 命令速查

| 命令                        | 说明               |
| --------------------------- | ------------------ |
| `ZADD key score member`     | 添加元素（带分数） |
| `ZRANGE key 0 -1`           | 升序查询           |
| `ZREVRANGE key 0 -1`        | 降序查询           |
| `ZSCORE key member`         | 获取分数           |
| `ZRANK key member`          | 获取排名（升序）   |
| `ZREVRANK key member`       | 获取排名（降序）   |
| `ZINCRBY key 增量 member`   | 增加分数           |
| `ZRANGEBYSCORE key min max` | 按分数范围查询     |
| `ZCARD key`                 | 获取元素数量       |
| `ZREM key member`           | 删除元素           |

---

## Task 04: 分布式锁与发布订阅

### 学习目标

1. 掌握分布式锁的实现原理（SETNX + EX）
2. 理解锁超时、重入、释放的最佳实践
3. 掌握 Pub/Sub 发布订阅模式（实时消息推送）
4. 了解 Pipeline 管道优化批量操作

### 核心概念

#### 分布式锁

**为什么需要分布式锁？**

单机锁（如 JavaScript 的 `synchronized`）只能在单进程内生效。当多个服务实例同时运行时，需要分布式锁来保证互斥性。

**Redis 分布式锁原理：**

```
加锁：SET lock:order:1001 "worker-A" NX EX 10
        ↑                              ↑  ↑
      key                          不存在才设置  10秒过期

释放：Lua 脚本（先比较值，再删除）
  if redis.call('get', key) == value then
    return redis.call('del', key)
  else
    return 0
  end
```

**关键要点：**

| 要点           | 说明                                          |
| -------------- | --------------------------------------------- |
| NX             | 保证互斥性（只有一个 Worker 能加锁成功）      |
| EX（过期时间） | 防止死锁（Worker 崩溃后锁自动释放）           |
| 唯一值         | 防止误删别人的锁（每个 Worker 用不同的 UUID） |
| Lua 脚本       | 保证"比较 + 删除"的原子性                     |

#### 发布订阅（Pub/Sub）

**模式：** 发布者发送消息到频道，订阅者实时接收

```
Publisher → [频道: news] → Subscriber A
                       → Subscriber B
                       → Subscriber C
```

**适用场景：**

- 实时通知（系统公告、维护通知）
- 消息推送（订单状态变更）
- 事件驱动（用户注册后触发邮件发送）

#### Pipeline 管道

**问题：** 1000 次 SET 操作 = 1000 次网络往返 = 很慢

**解决：** Pipeline 将多个命令打包，一次网络往返完成

```
普通方式：SET a 1 → OK, SET b 2 → OK, SET c 3 → OK  (3 次往返)
Pipeline：[SET a 1, SET b 2, SET c 3] → [OK, OK, OK]  (1 次往返)
```

**性能提升：** 通常 5-10 倍

### 运行代码

```bash
node src/exercise-04.mjs
```

---

## Task 05: AI Agent 记忆系统

### 学习目标

1. 理解 Agent 短期记忆的存储和检索模式
2. 掌握 Redis 在 AI 对话系统中的应用
3. 学会消息压缩（Summarization）策略
4. 实现可续聊的对话系统

### 核心架构

```
用户输入
   ↓
┌─────────────────────────────────────┐
│  1. 从 Redis 加载历史消息            │
│     Key: agent:short_memory:user:001 │
└─────────────────────────────────────┘
   ↓
┌─────────────────────────────────────┐
│  2. 拼接：历史 + 用户新消息          │
└─────────────────────────────────────┘
   ↓
┌─────────────────────────────────────┐
│  3. 调用 Agent（LLM 推理）           │
└─────────────────────────────────────┘
   ↓
┌─────────────────────────────────────┐
│  4. 保存完整消息到 Redis（带 TTL）    │
└─────────────────────────────────────┘
   ↓
┌─────────────────────────────────────┐
│  5. 如果消息数 >= 8，自动压缩旧消息   │
│     （Summarization Middleware）      │
└─────────────────────────────────────┘
   ↓
返回助手回复
```

### 关键组件

#### RedisMessageStore

负责消息的持久化存储：

| 方法           | 职责                         |
| -------------- | ---------------------------- |
| `loadMessages` | 从 Redis 加载历史消息        |
| `saveMessages` | 将新消息写回 Redis（带 TTL） |
| `clear`        | 清空指定会话的记忆           |
| `ttl`          | 查看记忆剩余存活时间         |

#### Summarization Middleware

当消息数过多时，自动压缩旧消息：

```
原始：[消息1, 消息2, ..., 消息8, 消息9, 消息10]
        ↓ 触发压缩（保留最近 4 条）
压缩后：[摘要, 消息7, 消息8, 消息9, 消息10]
```

**优势：**

- 避免 Token 超限
- 保留关键上下文
- 降低 API 成本

### 运行代码

```bash
# 确保已配置 .env 文件
node src/exercise-05.mjs
```

**交互命令：**

- `exit` / `quit` / `:q` — 退出
- `:clear` — 清空当前会话记忆

### 测试场景

```
你: 我叫张三，今年 28 岁
助手: 你好张三！很高兴认识你。

你: 我喜欢学习 AI 和 Redis
助手: AI 和 Redis 是很棒的组合...

（继续对话，观察 Redis 中的消息变化）

你: 你还记得我叫什么吗？
助手: 你叫张三。

（输入 :clear 清空记忆）

你: 你还记得我叫什么吗？
助手: 抱歉，我没有之前的对话记录...
```

---

## Redis 核心数据类型速查表

| 数据类型 | 典型业务场景                              |
| -------- | ----------------------------------------- |
| String   | 验证码、Token、计数器、分布式锁、文本记忆 |
| Hash     | 用户信息、商品数据、购物车、结构化会话    |
| List     | 消息队列、任务队列、浏览/聊天历史         |
| Set      | 签到、数据去重、黑名单、好友关系          |
| ZSet     | 排行榜、热度排序、积分排名                |
| Bitmap   | 批量签到、海量布尔状态统计                |
| Geo      | 位置检索、距离计算、附近门店/人群         |

---

## 最佳实践与常见坑

### Key 命名规范

```
✅ 正确：
  user:info:1001           # 业务:资源:标识
  order:lock:2001
  agent:memory:user:001

❌ 错误：
  user_info_1001           # 用下划线而非冒号
  mykey                    # 太模糊
  a_very_long_key_name...  # 太长（浪费内存）
```

### TTL 设置

| 场景       | 推荐 TTL  | 说明                     |
| ---------- | --------- | ------------------------ |
| 验证码     | 5 分钟    | 安全性要求高             |
| 登录 Token | 24 小时   | 平衡安全性和用户体验     |
| 缓存数据   | 1-24 小时 | 根据数据更新频率         |
| Agent 记忆 | 30 分钟   | 避免长时间不活跃占用内存 |

### 常见坑

#### 1. 忘记关闭连接

```javascript
// ❌ 错误：连接泄漏
const redis = new Redis();
await redis.set("key", "value");
// 程序结束，但连接没关闭

// ✅ 正确：finally 中关闭
try {
  await redis.set("key", "value");
} finally {
  await redis.quit();
}
```

#### 2. 循环单条操作（性能差）

```javascript
// ❌ 错误：1000 次网络往返
for (let i = 0; i < 1000; i++) {
  await redis.set(`key:${i}`, `value:${i}`);
}

// ✅ 正确：Pipeline 一次往返
const pipeline = redis.pipeline();
for (let i = 0; i < 1000; i++) {
  pipeline.set(`key:${i}`, `value:${i}`);
}
await pipeline.exec();
```

#### 3. 分布式锁没用 Lua 脚本

```javascript
// ❌ 错误：非原子操作（可能误删别人的锁）
async function releaseLock(key, value) {
  const current = await redis.get(key);
  if (current === value) {
    await redis.del(key); // 这两步之间可能被其他进程抢占
  }
}

// ✅ 正确：Lua 脚本保证原子性
async function releaseLock(key, value) {
  const lua = `
    if redis.call('get', KEYS[1]) == ARGV[1] then
      return redis.call('del', KEYS[1])
    else
      return 0
    end
  `;
  await redis.eval(lua, 1, key, value);
}
```

#### 4. Key 没有设置过期时间

```javascript
// ❌ 错误：永久存储，可能导致内存泄漏
await redis.set("temp:data", "value");

// ✅ 正确：设置合理 TTL
await redis.set("temp:data", "value", "EX", 3600); // 1 小时后过期
```

---

## 下一步

完成所有练习后，可以尝试以下进阶任务：

1. **实现分布式限流器**：使用 Redis + Lua 实现 API 限流
2. **构建消息队列**：基于 Redis List 实现可靠的任务队列
3. **会话共享**：在多个 Node.js 实例间共享用户会话
4. **缓存策略**：实现 Cache-Aside、Write-Through 等缓存模式

---

## 参考资料

- [Redis 官方文档](https://redis.io/docs/)
- [ioredis GitHub](https://github.com/redis/ioredis)
- [LangChain.js 文档](https://js.langchain.com/)
- [RedisInsight 下载](https://redis.com/redis-enterprise/redis-insight/)

---

**祝你学习愉快！🎉**
