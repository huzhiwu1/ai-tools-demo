import Redis from "ioredis";
import "dotenv/config";

const client = new Redis({
  host: process.env.REDIS_HOST ?? "localhost",
  port: Number(process.env.REDIS_PORT) ?? 6379,
  db: process.env.REDIS_DB ?? 0,
});

client.on("connect", () => {
  console.log("✅ Redis 已连接");
});

client.on("error", (err) => {
  console.error("❌ Redis 连接错误:", err);
});

async function runStringDemo() {
  const userId = "123456";
  await client.set(`session:token:${userId}`, "abc123", "EX", 30 * 60);
  console.log("存储用户会话令牌成功", userId);
  const token = await client.get(`session:token:${userId}`);
  console.log("获取用户会话令牌成功", userId, token);

  console.log("计算页面访问次数");
  await client.incr(`page:views:首页`);
  await client.incr(`page:views:首页`);
  await client.incr(`page:views:首页`);
  await client.incr(`page:views:首页`);
  await client.incr(`page:views:首页`);

  const views = await client.get(`page:views:首页`);
  console.log("获取页面访问次数成功", views);

  console.log("批量写入");
  await client.mset(
    `app_name`,
    "Redis Tutorial",
    `app_version`,
    "1.0.0",
    `app_env`,
    "development",
  );

  console.log("批量读取");
  const [name, version, env] = await client.mget(
    `app_name`,
    `app_version`,
    `app_env`,
  );
  console.log("获取应用信息成功", name, version, env);

  console.log("开始删除数据");
  await client.del(`session:token:${userId}`);
  const exists = await client.exists(`session:token:${userId}`);

  if (!exists) console.log("删除用户会话令牌成功", userId);
  await client.del(`page:views:首页`);

  const pageViewsExists = await client.exists(`page:views:首页`);
  if (!pageViewsExists) console.log("删除页面访问次数成功", `page:views:首页`);
  await client.del(`app_name`, `app_version`, `app_env`);
  const appExists = await client.exists(`app_name`, `app_version`, `app_env`);
  if (!appExists) console.log("删除应用信息成功");
}
async function main() {
  try {
    await runStringDemo();
    console.log("开始关闭 Redis 连接");
  } catch (err) {
    console.error("执行异常：", err);
  } finally {
    await client.quit();
    console.log("Redis 连接已关闭");
  }
}
main();
