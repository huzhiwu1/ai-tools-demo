/**
 * Exercise 04: Redis 分布式锁与发布订阅
 *
 * 学习目标：
 * 1. 掌握分布式锁的实现原理（SETNX + EX）
 * 2. 理解锁超时、重入、释放的最佳实践
 * 3. 掌握 Pub/Sub 发布订阅模式（实时消息推送）
 * 4. 了解 Pipeline 管道优化批量操作
 *
 * 前置条件：
 *   docker compose up -d redis
 *
 * 运行命令：
 *   node src/exercise-04.mjs
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
// 1. 分布式锁（标准实现）
// ============================================

/**
 * 尝试获取分布式锁
 *
 * @param lockKey 锁的 key（建议格式：lock:业务:资源ID）
 * @param lockValue 锁的值（用于安全释放，通常用 UUID）
 * @param expireSeconds 锁的过期时间（秒）
 * @returns 是否加锁成功
 */
async function acquireLock(lockKey, lockValue, expireSeconds = 10) {
  // NX: 只在 key 不存在时设置（保证互斥性）
  // EX: 设置过期时间（防止死锁）
  const result = await redis.set(lockKey, lockValue, "NX", "EX", expireSeconds);
  return result === "OK";
}

/**
 * 安全释放分布式锁
 *
 * @param lockKey 锁的 key
 * @param lockValue 锁的值（必须与加锁时一致）
 * @returns 是否释放成功
 *
 * 关键：用 Lua 脚本保证原子性（先比较值，再删除）
 */
async function releaseLock(lockKey, lockValue) {
  // Lua 脚本：if redis.call('get', key) == value then return redis.call('del', key) else return 0 end
  const luaScript = `
    if redis.call('get', KEYS[1]) == ARGV[1] then
      return redis.call('del', KEYS[1])
    else
      return 0
    end
  `;

  const result = await redis.eval(luaScript, 1, lockKey, lockValue);
  return result === 1;
}

async function runDistributedLockDemo() {
  console.log("\n========== 分布式锁 ==========\n");

  const lockKey = "lock:order:1001";
  const lockValue = `worker:${Date.now()}`; // 唯一标识，防止误删别人的锁

  // ----------------------------------------
  // 1.1 正常加锁和释放
  // ----------------------------------------
  console.log("--- 1.1 正常加锁和释放 ---");

  const locked = await acquireLock(lockKey, lockValue, 10);
  console.log("加锁结果:", locked ? "成功" : "失败");

  if (locked) {
    console.log("  正在处理订单 1001...");
    await new Promise((resolve) => setTimeout(resolve, 1000)); // 模拟耗时操作
    console.log("  订单处理完成");

    const released = await releaseLock(lockKey, lockValue);
    console.log("释放锁:", released ? "成功" : "失败");
  }

  // ----------------------------------------
  // 1.2 模拟并发竞争
  // ----------------------------------------
  console.log("\n--- 1.2 模拟并发竞争 ---");

  // 模拟 3 个 Worker 同时竞争同一把锁
  const workers = ["worker-A", "worker-B", "worker-C"];

  for (const worker of workers) {
    const success = await acquireLock(lockKey, worker, 5);
    console.log(`  ${worker} 竞争结果:`, success ? "获得锁" : "竞争失败");

    if (success) {
      console.log(`  ${worker} 正在执行任务...`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await releaseLock(lockKey, worker);
      console.log(`  ${worker} 释放锁完成`);
    }
  }

  // ----------------------------------------
  // 1.3 锁超时自动释放
  // ----------------------------------------
  console.log("\n--- 1.3 锁超时自动释放 ---");

  const timeoutKey = "lock:timeout:test";
  await acquireLock(timeoutKey, "worker-timeout", 2); // 2 秒后过期

  console.log("  加锁成功，等待 3 秒让锁自动过期...");
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const ttl = await redis.ttl(timeoutKey);
  console.log("  锁剩余 TTL:", ttl, "秒（-2 表示已过期）");

  // 锁过期后，其他 Worker 可以重新获取
  const reacquired = await acquireLock(timeoutKey, "worker-new", 5);
  console.log("  新 Worker 重新加锁:", reacquired ? "成功" : "失败");

  await releaseLock(timeoutKey, "worker-new");
}

// ============================================
// 2. 发布订阅（Pub/Sub）
// ============================================

async function runPubSubDemo() {
  console.log("\n========== 发布订阅（Pub/Sub）==========\n");

  // 创建两个客户端：一个发布，一个订阅
  // 注意：订阅客户端在订阅期间只能执行订阅相关命令
  const publisher = new Redis({ host: "localhost", port: 6379 });
  const subscriber = new Redis({ host: "localhost", port: 6379 });

  // ----------------------------------------
  // 2.1 基础发布订阅
  // ----------------------------------------
  console.log("--- 2.1 基础发布订阅 ---");

  // 订阅频道
  await subscriber.subscribe("news", "alerts");
  console.log("  已订阅频道: news, alerts");

  // 监听消息
  subscriber.on("message", (channel, message) => {
    console.log(`  收到 [${channel}]: ${message}`);
  });

  // 发布消息
  await publisher.publish("news", "今日头条新闻");
  await publisher.publish("alerts", "系统维护通知");
  await publisher.publish("news", "AI Agent 技术突破");

  // 等待消息处理
  await new Promise((resolve) => setTimeout(resolve, 500));

  // 取消订阅
  await subscriber.unsubscribe("news", "alerts");
  console.log("  已取消订阅");

  await publisher.quit();
  await subscriber.quit();
}

// ============================================
// 3. Pipeline 管道（批量操作优化）
// ============================================

async function runPipelineDemo() {
  console.log("\n========== Pipeline 管道 ==========\n");

  // ----------------------------------------
  // 3.1 对比：普通方式 vs Pipeline
  // ----------------------------------------
  console.log("--- 3.1 对比：普通方式 vs Pipeline ---");

  const COUNT = 1000;

  // 方式 A：逐条执行（N 次网络往返）
  console.log("  普通方式写入 1000 条...");
  const startNormal = Date.now();
  for (let i = 0; i < COUNT; i++) {
    await redis.set(`normal:${i}`, `value-${i}`);
  }
  const normalTime = Date.now() - startNormal;
  console.log(`  普通方式耗时: ${normalTime}ms`);

  // 方式 B：Pipeline（1 次网络往返）
  console.log("  Pipeline 方式写入 1000 条...");
  const startPipeline = Date.now();
  const pipeline = redis.pipeline();
  for (let i = 0; i < COUNT; i++) {
    pipeline.set(`pipeline:${i}`, `value-${i}`);
  }
  await pipeline.exec();
  const pipelineTime = Date.now() - startPipeline;
  console.log(`  Pipeline 方式耗时: ${pipelineTime}ms`);

  console.log(`  性能提升: ${(normalTime / pipelineTime).toFixed(2)} 倍`);

  // ----------------------------------------
  // 3.2 Pipeline 批量读取
  // ----------------------------------------
  console.log("\n--- 3.2 Pipeline 批量读取 ---");

  const readPipeline = redis.pipeline();
  for (let i = 0; i < 10; i++) {
    readPipeline.get(`pipeline:${i}`);
  }
  const results = await readPipeline.exec();

  // results 格式：[[err, value], [err, value], ...]
  console.log("批量读取前 10 条:");
  for (let i = 0; i < results.length; i++) {
    const [err, value] = results[i];
    if (err) {
      console.log(`  pipeline:${i} 读取失败:`, err.message);
    } else {
      console.log(`  pipeline:${i} = ${value}`);
    }
  }

  // ----------------------------------------
  // 3.3 清理测试数据
  // ----------------------------------------
  const delPipeline = redis.pipeline();
  for (let i = 0; i < COUNT; i++) {
    delPipeline.del(`normal:${i}`);
    delPipeline.del(`pipeline:${i}`);
  }
  await delPipeline.exec();
  console.log("\n  已清理 2000 条测试数据");
}

// ============================================
// 4. 事务（Multi/Exec）
// ============================================

async function runTransactionDemo() {
  console.log("\n========== 事务（Multi/Exec）==========\n");

  // ----------------------------------------
  // 4.1 基础事务
  // ----------------------------------------
  console.log("--- 4.1 基础事务 ---");

  // multi() 开启事务，exec() 提交事务
  // 事务中的命令会按顺序执行，保证原子性
  const multi = redis.multi();

  multi.set("tx:user:balance", 1000);
  multi.decrby("tx:user:balance", 200); // 消费 200
  multi.incrby("tx:shop:income", 200); // 商家收入 200

  const txResults = await multi.exec();
  console.log("事务执行结果:", txResults);

  // 验证结果
  const balance = await redis.get("tx:user:balance");
  const income = await redis.get("tx:shop:income");
  console.log("用户余额:", balance, "商家收入:", income);

  // ----------------------------------------
  // 4.2 事务回滚（错误处理）
  // ----------------------------------------
  console.log("\n--- 4.2 事务回滚（错误处理）---");

  try {
    const multi2 = redis.multi();
    multi2.set("tx:test", "value");
    multi2.incr("tx:test"); // 这会失败（非数字字符串不能 incr）
    multi2.get("tx:test");

    const results = await multi2.exec();

    // 检查是否有错误
    for (const [err, result] of results) {
      if (err) {
        console.log("  事务中有错误:", err.message);
      } else {
        console.log("  执行结果:", result);
      }
    }
  } catch (err) {
    console.log("  事务执行失败:", err.message);
  }

  // 清理
  await redis.del("tx:user:balance", "tx:shop:income", "tx:test");
}

// ============================================
// 5. 执行并清理
// ============================================

async function main() {
  try {
    await runDistributedLockDemo();
    await runPubSubDemo();
    await runPipelineDemo();
    await runTransactionDemo();

    console.log("\n========== 所有练习完成 ==========");
  } catch (err) {
    console.error("执行异常：", err);
  } finally {
    await redis.quit();
    console.log("👋 Redis 连接已关闭");
  }
}

main();
