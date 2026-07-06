/**
 * Exercise 03: Redis Set 集合、ZSet 有序集合、Bitmap 位图、Geo 地理位置
 *
 * 学习目标：
 * 1. 掌握 Set 集合的去重和集合运算（交集、并集、差集）
 * 2. 掌握 ZSet 有序集合的排行榜实现
 * 3. 理解 Bitmap 位图的极致内存优化
 * 4. 掌握 Geo 地理位置的存储和距离计算
 *
 * 前置条件：
 *   docker compose up -d redis
 *
 * 运行命令：
 *   node src/exercise-03.mjs
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
// 1. Set 集合操作
// ============================================

async function runSetDemo() {
  console.log("\n========== Set 集合操作 ==========\n");

  // ----------------------------------------
  // 1.1 sadd / smembers 添加和查询
  // ----------------------------------------
  console.log("--- 1.1 sadd / smembers 添加和查询 ---");

  // sadd: 向集合中添加元素（自动去重）
  // 返回新添加的元素数量（已存在的不计入）
  const added1 = await redis.sadd(
    "tag:set",
    "redis",
    "node",
    "docker",
    "redis",
  );
  console.log("添加结果:", added1, "个新元素（重复的 redis 被忽略）");

  // smembers: 获取集合所有元素（无序）
  console.log("集合内容:", await redis.smembers("tag:set"));

  // ----------------------------------------
  // 1.2 sismember 判断成员
  // ----------------------------------------
  console.log("\n--- 1.2 sismember 判断成员 ---");

  // sismember: 判断元素是否在集合中（O(1) 时间复杂度）
  const hasRedis = await redis.sismember("tag:set", "redis");
  const hasJava = await redis.sismember("tag:set", "java");
  console.log("包含 redis:", hasRedis ? "是" : "否");
  console.log("包含 java:", hasJava ? "是" : "否");

  // ----------------------------------------
  // 1.3 scard 集合大小
  // ----------------------------------------
  console.log("\n--- 1.3 scard 集合大小 ---");

  const size = await redis.scard("tag:set");
  console.log("集合大小:", size);

  // ----------------------------------------
  // 1.4 集合运算（交集、并集、差集）
  // ----------------------------------------
  console.log("\n--- 1.4 集合运算（交集、并集、差集）---");

  // 创建两个用户的好友集合
  await redis.sadd("friend:1001", "张三", "李四", "王五", "赵六");
  await redis.sadd("friend:1002", "李四", "王五", "钱七", "孙八");

  // sinter: 交集（两位用户的共同好友）
  const common = await redis.sinter("friend:1001", "friend:1002");
  console.log("共同好友:", common);

  // sunion: 并集（两位用户的所有好友，去重）
  const all = await redis.sunion("friend:1001", "friend:1002");
  console.log("所有好友:", all);

  // sdiff: 差集（1001 有但 1002 没有的好友）
  const diff = await redis.sdiff("friend:1001", "friend:1002");
  console.log("1001 独有好友:", diff);

  // ----------------------------------------
  // 1.5 srem 删除元素
  // ----------------------------------------
  console.log("\n--- 1.5 srem 删除元素 ---");

  // srem: 从集合中移除元素
  await redis.srem("tag:set", "docker");
  console.log("删除 docker 后:", await redis.smembers("tag:set"));

  // ----------------------------------------
  // 1.6 实战：每日签到
  // ----------------------------------------
  console.log("\n--- 1.6 实战：每日签到 ---");

  const today = "20250120";
  const signKey = `sign:${today}`;

  // 用户签到
  await redis.sadd(signKey, "1001", "1002", "1003", "1005");
  console.log("今日签到人数:", await redis.scard(signKey));

  // 判断某用户是否签到
  const isSigned = await redis.sismember(signKey, "1001");
  console.log("用户 1001 是否签到:", isSigned ? "已签到" : "未签到");
}

// ============================================
// 2. ZSet 有序集合（排行榜利器）
// ============================================

async function runZSetDemo() {
  console.log("\n========== ZSet 有序集合 ==========\n");

  // ----------------------------------------
  // 2.1 zadd 添加元素（带分数）
  // ----------------------------------------
  console.log("--- 2.1 zadd 添加元素 ---");

  // zadd: 添加元素并指定分数（分数越高排名越后）
  await redis.zadd("rank:course", 98, "PostgreSQL 实战");
  await redis.zadd("rank:course", 95, "AI Agent 开发");
  await redis.zadd("rank:course", 92, "Redis 从入门到精通");
  await redis.zadd("rank:course", 88, "Node.js 高级教程");
  await redis.zadd("rank:course", 96, "LangChain 实战");

  console.log("课程排行榜数据已添加");

  // ----------------------------------------
  // 2.2 zrange / zrevrange 排名查询
  // ----------------------------------------
  console.log("\n--- 2.2 zrange / zrevrange 排名查询 ---");

  // zrange: 按分数升序（从低到高）
  const ascRank = await redis.zrange("rank:course", 0, -1);
  console.log("升序排名:", ascRank);

  // zrevrange: 按分数降序（从高到低，常用）
  const descRank = await redis.zrevrange("rank:course", 0, -1);
  console.log("降序排名（热门在前）:", descRank);

  // zrevrange 带 WITHSCORES
  const descRankWithScores = await redis.zrevrange(
    "rank:course",
    0,
    -1,
    "WITHSCORES",
  );
  console.log("带分数的排名:", descRankWithScores);

  // ----------------------------------------
  // 2.3 zscore / zrank 查询单个元素
  // ----------------------------------------
  console.log("\n--- 2.3 zscore / zrank 查询单个元素 ---");

  // zscore: 获取元素的分数
  const score = await redis.zscore("rank:course", "AI Agent 开发");
  console.log("AI Agent 开发 分数:", score);

  // zrank: 获取元素排名（从 0 开始，升序）
  const rank = await redis.zrank("rank:course", "AI Agent 开发");
  console.log("AI Agent 开发 排名（升序）:", rank);

  // zrevrank: 获取元素排名（从 0 开始，降序）
  const revRank = await redis.zrevrank("rank:course", "AI Agent 开发");
  console.log("AI Agent 开发 排名（降序）:", revRank);

  // ----------------------------------------
  // 2.4 zincrby 分数自增
  // ----------------------------------------
  console.log("\n--- 2.4 zincrby 分数自增 ---");

  // zincrby: 增加元素分数
  await redis.zincrby("rank:course", 10, "Redis 从入门到精通");
  const newScore = await redis.zscore("rank:course", "Redis 从入门到精通");
  console.log("Redis 课程新分数:", newScore);

  // ----------------------------------------
  // 2.5 zrangebyscore 按分数范围查询
  // ----------------------------------------
  console.log("\n--- 2.5 zrangebyscore 按分数范围查询 ---");

  // zrangebyscore: 查询分数在 [90, 100] 之间的元素
  const topCourses = await redis.zrangebyscore("rank:course", 90, 100);
  console.log("分数 90 以上的课程:", topCourses);

  // ----------------------------------------
  // 2.6 zcard / zrem 删除
  // ----------------------------------------
  console.log("\n--- 2.6 zcard / zrem 删除 ---");

  console.log("排行榜元素数:", await redis.zcard("rank:course"));

  // zrem: 删除元素
  await redis.zrem("rank:course", "Node.js 高级教程");
  console.log(
    "删除后:",
    await redis.zrevrange("rank:course", 0, -1, "WITHSCORES"),
  );
}

// ============================================
// 3. Bitmap 位图（极致内存优化）
// ============================================

async function runBitmapDemo() {
  console.log("\n========== Bitmap 位图 ==========\n");

  // ----------------------------------------
  // 3.1 setbit / getbit 设置签到
  // ----------------------------------------
  console.log("--- 3.1 setbit / getbit 设置签到 ---");

  const signKey = "sign:user:1001:202501";

  // 设置指定偏移量为 1（表示已签到）
  // 偏移量 = 日期 - 1，比如第 1 天偏移量是 0，第 5 天偏移量是 4
  await redis.setbit(signKey, 1, 1); // 第 2 天签到
  await redis.setbit(signKey, 5, 1); // 第 6 天签到
  await redis.setbit(signKey, 10, 1); // 第 11 天签到

  console.log(
    "第 2 天签到状态:",
    (await redis.getbit(signKey, 1)) ? "已签到" : "未签到",
  );
  console.log(
    "第 6 天签到状态:",
    (await redis.getbit(signKey, 5)) ? "已签到" : "未签到",
  );
  console.log(
    "第 10 天签到状态:",
    (await redis.getbit(signKey, 9)) ? "已签到" : "未签到",
  );

  // ----------------------------------------
  // 3.2 bitcount 统计签到天数
  // ----------------------------------------
  console.log("\n--- 3.2 bitcount 统计签到天数 ---");

  // bitcount: 统计字符串中值为 1 的位数
  const signDays = await redis.bitcount(signKey);
  console.log("月签到天数:", signDays);

  // ----------------------------------------
  // 3.3 批量查询用户签到情况
  // ----------------------------------------
  console.log("\n--- 3.3 批量查询用户签到情况 ---");

  // 模拟多个用户签到
  for (const userId of [1001, 1002, 1003]) {
    const key = `sign:${userId}:202501`;
    await redis.setbit(key, 5, 1);
    await redis.setbit(key, 10, 1);
    const count = await redis.bitcount(key);
    console.log(`用户 ${userId} 签到天数: ${count} 天`);
  }
}

// ============================================
// 4. Geo 地理位置
// ============================================

async function runGeoDemo() {
  console.log("\n========== Geo 地理位置 ==========\n");

  // ----------------------------------------
  // 4.1 geoadd 添加地理位置
  // ----------------------------------------
  console.log("--- 4.1 geoadd 添加地理位置 ---");

  // geoadd: 添加地理位置（经度 纬度 名称）
  // 注意：经度在前，纬度在后
  await redis.geoadd("shop:location", 116.481028, 39.921983, "北京总店");
  await redis.geoadd("shop:location", 121.473722, 31.230414, "上海分店");
  await redis.geoadd("shop:location", 113.264385, 23.158685, "广州分店");
  await redis.geoadd("shop:location", 104.065735, 30.659462, "成都分店");

  console.log("门店位置已添加");

  // ----------------------------------------
  // 4.2 geopos 获取位置经纬度
  // ----------------------------------------
  console.log("\n--- 4.2 geopos 获取位置经纬度 ---");

  // geopos: 获取元素的经纬度
  const beijingPos = await redis.geopos("shop:location", "北京总店");
  console.log("北京总店经纬度:", beijingPos);

  // ----------------------------------------
  // 4.3 geodist 计算距离
  // ----------------------------------------
  console.log("\n--- 4.3 geodist 计算距离 ---");

  // geodist: 计算两个位置之间的距离
  // 单位可选：m（米）、km（千米）、mi（英里）、ft（英尺）
  const dist = await redis.geodist(
    "shop:location",
    "北京总店",
    "上海分店",
    "km",
  );
  console.log("北京总店 <-> 上海分店:", dist, "km");

  const dist2 = await redis.geodist(
    "shop:location",
    "北京总店",
    "广州分店",
    "km",
  );
  console.log("北京总店 <-> 广州分店:", dist2, "km");

  // ----------------------------------------
  // 4.4 georadius 附近搜索
  // ----------------------------------------
  console.log("\n--- 4.4 georadius 附近搜索 ---");

  // georadius: 以指定经纬度为圆心，搜索半径内的位置
  // 参数：经度 纬度 半径 单位
  const nearbyShops = await redis.georadius(
    "shop:location",
    116.481028, // 北京总店的经度
    39.921983, // 北京总店的纬度
    1000, // 1000 公里半径
    "km",
  );
  console.log("北京总店 1000km 内的门店:", nearbyShops);
}

// ============================================
// 5. 执行并清理
// ============================================

async function main() {
  try {
    await runSetDemo();
    await runZSetDemo();
    await runBitmapDemo();
    await runGeoDemo();

    // 清理测试数据
    console.log("\n========== 清理测试数据 ==========");
    await redis.del(
      "tag:set",
      "friend:1001",
      "friend:1002",
      "sign:20250120",
      "rank:course",
      "sign:user:1001:202501",
      "sign:1001:202501",
      "sign:1002:202501",
      "sign:1003:202501",
      "shop:location",
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
