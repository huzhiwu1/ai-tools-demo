import Redis from "ioredis";
import "dotenv/config";

const client = new Redis({
  host: process.env.REDIS_HOST ?? "localhost",
  port: Number(process.env.REDIS_PORT ?? 6379),
  db: process.env.REDIS_DB ?? 0,
});

async function runHashDemo() {
  console.log("通过哈希表存储用户的购物车信息");
  await client.hmset("cart:user:1001", {
    "sku:1001": 2,
    "sku:1002": 1,
    "sku:1003": 3,
  });
  console.log("获取用户购物车信息");
  const cart = await client.hgetall("cart:user:1001");
  console.log("用户购物车信息:", cart);

  console.log("修改用户购物车信息");
  await client.hset("cart:user:1001", "sku:1002", 5);
  const sku1002 = await client.hget("cart:user:1001", "sku:1002");
  console.log("用户购物车信息已修改", sku1002);

  console.log("删除用户购物车信息sku:1003");
  await client.hdel("cart:user:1001", "sku:1003");
  const skuExists = await client.hexists("cart:user:1001", "sku:1003");
  if (!skuExists) console.log("用户购物车信息已删除");

  console.log("获取用户购物车信息数量");
  const count = await client.hlen("cart:user:1001");
  console.log("用户购物车信息数量:", count);

  console.log("用户操作日志");
  await client.rpush("log:user:1001", "登录", "添加商品", "修改数量");

  const history = await client.lrange("log:user:1001", 0, -1);
  console.log("用户操作日志:", history);

  const len = await client.llen("log:user:1001");
  console.log("用户操作日志数量:", len);
  console.log("裁剪用户的日志");
  await client.ltrim("log:user:1001", 0, 1);
  const history2 = await client.lrange("log:user:1001", 0, -1);
  console.log("裁剪后的用户操作日志:", history2);

  console.log("删除所有的key");
  await client.del("cart:user:1001", "log:user:1001");
  const exists = await client.exists("cart:user:1001", "log:user:1001");
  if (!exists) console.log("所有key已删除");
}

client.on("connect", () => {
  console.log("✅ Redis 已连接");
});

client.on("error", (err) => {
  console.error("❌ Redis 连接错误:", err.message);
});

async function main() {
  try {
    await runHashDemo();
  } catch (err) {
    console.error("执行异常：", err);
  } finally {
    await client.quit();
    console.log("👋 Redis 连接已关闭");
  }
}

main();
