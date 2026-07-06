/**
 * Exercise 01: Redis 基础连接与 String 操作
 *
 * 学习目标：
 * 1. 掌握 ioredis 客户端连接方式
 * 2. 学会 String 类型的增删改查
 * 3. 理解 key 过期时间（TTL）的概念
 * 4. 掌握计数器和分布式锁的基础用法
 *
 * 前置条件：
 *   docker compose up -d redis
 *
 * 运行命令：
 *   node src/exercise-01.mjs
 */

import Redis from "ioredis";

// ============================================
// 1. 创建 Redis 客户端
// ============================================

/**
 * Redis 连接配置
 * host: Redis 服务器地址
 * port: Redis 端口（默认 6379）
 * db: 数据库编号（0-15，默认 0）
 */
const redis = new Redis({
  host: "localhost",
  port: 6379,
  db: 0,
});

// 监听连接成功事件
redis.on("connect", () => {
  console.log("✅ Redis 连接成功");
});

// 监听错误事件（生产环境必须处理）
redis.on("error", (err) => {
  console.error("❌ Redis 连接失败：", err.message);
});

// ============================================
// 2. String 字符串操作
// ============================================

async function runStringDemo() {
  console.log("\n========== String 字符串操作 ==========\n");

  // ----------------------------------------
  // 2.1 基础 set / get
  // ----------------------------------------
  console.log("--- 2.1 基础 set / get ---");

  // set: 写入键值对（如果 key 已存在则覆盖）
  await redis.set("greeting", "你好，Redis！");

  // get: 读取键值（key 不存在返回 null）
  const greeting = await redis.get("greeting");
  console.log("greeting:", greeting);

  // ----------------------------------------
  // 2.2 带过期时间的 set（EX = 秒）
  // ----------------------------------------
  console.log("\n--- 2.2 带过期时间的 set ---");

  // 设置验证码，5 分钟后自动过期
  // EX 参数单位是秒，PX 参数单位是毫秒
  await redis.set("sms:code:13800138000", "666888", "EX", 300);

  const code = await redis.get("sms:code:13800138000");
  console.log("验证码:", code);

  // ttl: 查看 key 剩余存活时间（秒），-1 表示永不过期，-2 表示已过期/不存在
  const ttl = await redis.ttl("sms:code:13800138000");
  console.log("验证码剩余有效期:", ttl, "秒");

  // ----------------------------------------
  // 2.3 incr / decr 计数器
  // ----------------------------------------
  console.log("\n--- 2.3 incr / decr 计数器 ---");

  // 先初始化为 0（如果 key 不存在，incr 会从 0 开始）
  await redis.set("counter:article:1024", 0);

  // incr: 自增 1（原子操作，适合并发场景）
  await redis.incr("counter:article:1024");
  await redis.incr("counter:article:1024");
  await redis.incr("counter:article:1024");

  const views = await redis.get("counter:article:1024");
  console.log("文章阅读量:", views);

  // incrby: 按指定步长自增
  await redis.incrby("counter:article:1024", 10);
  console.log("批量增加后:", await redis.get("counter:article:1024"));

  // decr: 自减 1
  await redis.decr("counter:article:1024");
  console.log("自减后:", await redis.get("counter:article:1024"));

  // ----------------------------------------
  // 2.4 setnx（不存在才设置）
  // ----------------------------------------
  console.log("\n--- 2.4 setnx（不存在才设置）---");

  // setnx: Set if Not eXists，只在 key 不存在时设置成功
  // 返回 1 表示设置成功，0 表示 key 已存在
  const result1 = await redis.set("lock:demo", "locked", "NX", "EX", 10);
  console.log("第一次 setnx:", result1 ? "成功" : "失败（key 已存在）");

  const result2 = await redis.set("lock:demo", "locked", "NX", "EX", 10);
  console.log("第二次 setnx:", result2 ? "成功" : "失败（key 已存在）");

  // ----------------------------------------
  // 2.5 mset / mget 批量操作
  // ----------------------------------------
  console.log("\n--- 2.5 mset / mget 批量操作 ---");

  // mset: 批量设置多个键值对（一次网络往返，性能更好）
  await redis.mset("user:name", "张三", "user:age", 28, "user:city", "北京");

  // mget: 批量获取多个值（返回数组，顺序与 key 一致）
  const values = await redis.mget("user:name", "user:age", "user:city");
  console.log("批量获取:", values);

  // ----------------------------------------
  // 2.6 删除 key
  // ----------------------------------------
  console.log("\n--- 2.6 删除 key ---");

  // del: 删除一个或多个 key，返回成功删除的数量
  const deleted = await redis.del("greeting", "lock:demo");
  console.log("删除了", deleted, "个 key");

  // exists: 检查 key 是否存在
  const exists = await redis.exists("greeting");
  console.log("greeting 是否还存在:", exists ? "是" : "否");
}

// ============================================
// 3. 执行并清理
// ============================================

async function main() {
  try {
    await runStringDemo();

    // 清理本练习创建的测试数据
    console.log("\n========== 清理测试数据 ==========");
    await redis.del(
      "sms:code:13800138000",
      "counter:article:1024",
      "user:name",
      "user:age",
      "user:city",
    );
    console.log("✅ 测试数据已清理");
  } catch (err) {
    console.error("执行异常：", err);
  } finally {
    // 重要：用完必须关闭连接，防止连接泄漏
    await redis.quit();
    console.log("👋 Redis 连接已关闭");
  }
}

main();
