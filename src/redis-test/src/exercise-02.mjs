/**
 * Exercise 02: Redis Hash 哈希与 List 列表
 *
 * 学习目标：
 * 1. 掌握 Hash 类型的字段级操作（适合存储结构化数据）
 * 2. 掌握 List 类型的双端操作（适合队列、历史列表）
 * 3. 理解 Hash 与 String 的区别：Hash 可以只修改一个字段，不用整体覆盖
 * 4. 掌握 List 的阻塞式弹出（实现简单消息队列）
 *
 * 前置条件：
 *   docker compose up -d redis
 *
 * 运行命令：
 *   node src/exercise-02.mjs
 */

import Redis from "ioredis";

const redis = new Redis({
  host: "localhost",
  port: 6379,
  db: 0,
});

redis.on("connect", () => console.log("✅ Redis 连接成功"));
redis.on("error", (err) => console.error("❌ Redis 错误:", err.message));

// ============================================
// 1. Hash 哈希操作
// ============================================

async function runHashDemo() {
  console.log("\n========== Hash 哈希操作 ==========\n");

  // ----------------------------------------
  // 1.1 hset / hget 单字段操作
  // ----------------------------------------
  console.log("--- 1.1 hset / hget 单字段操作 ---");

  // hset: 设置哈希表中的字段（如果 key 不存在会自动创建）
  // 格式：hset key field value
  await redis.hset("user:1001", "name", "李四");
  await redis.hset("user:1001", "age", 28);

  // hget: 获取哈希表中某个字段的值
  const name = await redis.hget("user:1001", "name");
  console.log("用户名:", name);

  // ----------------------------------------
  // 1.2 hmset 批量设置字段
  // ----------------------------------------
  console.log("\n--- 1.2 hmset 批量设置字段 ---");

  // hmset: 一次性设置多个字段（减少网络往返）
  await redis.hmset("user:1001", {
    phone: "13800138000",
    email: "lisi@example.com",
    city: "上海",
    role: "developer",
  });

  // hgetall: 获取哈希表所有字段和值（返回对象）
  const user = await redis.hgetall("user:1001");
  console.log("用户完整信息:", user);

  // ----------------------------------------
  // 1.3 hkeys / hvals / hlen
  // ----------------------------------------
  console.log("\n--- 1.3 hkeys / hvals / hlen ---");

  // hkeys: 获取所有字段名
  const fields = await redis.hkeys("user:1001");
  console.log("所有字段:", fields);

  // hvals: 获取所有字段值
  const values = await redis.hvals("user:1001");
  console.log("所有值:", values);

  // hlen: 获取字段数量
  const count = await redis.hlen("user:1001");
  console.log("字段数量:", count);

  // ----------------------------------------
  // 1.4 hincrby 字段自增
  // ----------------------------------------
  console.log("\n--- 1.4 hincrby 字段自增 ---");

  // hincrby: 对哈希表中的数字字段自增（原子操作）
  await redis.hincrby("user:1001", "login_count", 1);
  await redis.hincrby("user:1001", "login_count", 1);
  await redis.hincrby("user:1001", "login_count", 1);
  console.log("登录次数:", await redis.hget("user:1001", "login_count"));

  // ----------------------------------------
  // 1.5 hdel 删除字段
  // ----------------------------------------
  console.log("\n--- 1.5 hdel 删除字段 ---");

  // hdel: 删除哈希表中的字段
  await redis.hdel("user:1001", "email");
  console.log("删除 email 后:", await redis.hgetall("user:1001"));

  // hexists: 判断字段是否存在
  const hasEmail = await redis.hexists("user:1001", "email");
  console.log("email 字段是否存在:", hasEmail ? "是" : "否");
}

// ============================================
// 2. List 列表操作
// ============================================

async function runListDemo() {
  console.log("\n========== List 列表操作 ==========\n");

  // ----------------------------------------
  // 2.1 lpush / rpush 双端插入
  // ----------------------------------------
  console.log("--- 2.1 lpush / rpush 双端插入 ---");

  // lpush: 从左侧（头部）插入，最新数据在最前
  await redis.lpush("history:1001", "查看了 Redis 教程", "打开了首页");

  // rpush: 从右侧（尾部）插入，按时间顺序追加
  await redis.rpush("history:1001", "点击了购买按钮");

  // lrange: 获取指定范围的元素（0 到 -1 表示全部）
  const history = await redis.lrange("history:1001", 0, -1);
  console.log("浏览历史:", history);

  // ----------------------------------------
  // 2.2 llen 获取长度
  // ----------------------------------------
  console.log("\n--- 2.2 llen 获取长度 ---");

  const len = await redis.llen("history:1001");
  console.log("历史记录条数:", len);

  // ----------------------------------------
  // 2.3 lpop / rpop 双端弹出
  // ----------------------------------------
  console.log("\n--- 2.3 lpop / rpop 双端弹出 ---");

  // lpop: 从左侧弹出一个元素（FIFO 先进先出）
  const first = await redis.lpop("history:1001");
  console.log("弹出最早记录:", first);

  // rpop: 从右侧弹出一个元素（LIFO 后进先出）
  const last = await redis.rpop("history:1001");
  console.log("弹出最新记录:", last);

  console.log("弹出后剩余:", await redis.lrange("history:1001", 0, -1));

  // ----------------------------------------
  // 2.4 ltrim 裁剪列表（保留最近 N 条）
  // ----------------------------------------
  console.log("\n--- 2.4 ltrim 裁剪列表 ---");

  // 模拟追加更多记录
  await redis.rpush(
    "history:1001",
    "记录A",
    "记录B",
    "记录C",
    "记录D",
    "记录E",
  );

  // ltrim: 只保留前 5 条记录（常用于限制历史长度）
  await redis.ltrim("history:1001", 0, 4);
  console.log(
    "裁剪后（最多 5 条）:",
    await redis.lrange("history:1001", 0, -1),
  );

  // ----------------------------------------
  // 2.5 模拟消息队列
  // ----------------------------------------
  console.log("\n--- 2.5 模拟消息队列 ---");

  // 生产者：rpush 入队
  await redis.rpush("queue:task", "发送邮件", "生成报表", "清理缓存");
  console.log("队列初始状态:", await redis.lrange("queue:task", 0, -1));

  // 消费者：lpop 出队（先进先出）
  let task;
  while ((task = await redis.lpop("queue:task"))) {
    console.log("  处理任务:", task);
  }
  console.log("队列已清空");
}

// ============================================
// 3. 实战：简单购物车（Hash 实现）
// ============================================

async function runCartDemo() {
  console.log("\n========== 实战：简单购物车 ==========\n");

  const cartKey = "cart:user:1001";

  // 添加商品（field = 商品ID，value = 数量）
  await redis.hset(cartKey, "product:10086", 2);
  await redis.hset(cartKey, "product:10087", 1);
  await redis.hset(cartKey, "product:10088", 3);

  console.log("购物车内容:", await redis.hgetall(cartKey));

  // 修改数量
  await redis.hset(cartKey, "product:10087", 5);
  console.log("修改数量后:", await redis.hgetall(cartKey));

  // 删除商品
  await redis.hdel(cartKey, "product:10088");
  console.log("删除商品后:", await redis.hgetall(cartKey));

  // 计算总价（模拟）
  const cart = await redis.hgetall(cartKey);
  const prices = { "product:10086": 99.9, "product:10087": 59.9 };
  let total = 0;
  for (const [productId, qty] of Object.entries(cart)) {
    const price = prices[productId] || 0;
    total += price * Number(qty);
  }
  console.log(`购物车总价: ¥${total.toFixed(2)}`);
}

// ============================================
// 4. 执行并清理
// ============================================

async function main() {
  try {
    await runHashDemo();
    await runListDemo();
    await runCartDemo();

    // 清理测试数据
    console.log("\n========== 清理测试数据 ==========");
    await redis.del(
      "user:1001",
      "history:1001",
      "queue:task",
      "cart:user:1001",
    );
    console.log("✅ 测试数据已清理");
  } catch (err) {
    console.error("执行异常：", err);
  } finally {
    await redis.quit();
    console.log("👋 Redis 连接已关闭");
  }
}

main();
