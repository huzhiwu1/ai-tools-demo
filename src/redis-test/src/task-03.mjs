import Redis from 'ioredis';
import "dotenv/config"

const redis = new Redis({
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: Number(process.env.REDIS_PORT ?? 6379),
    db: Number(process.env.REDIS_DB ?? 0),
});

async function runSetDemo() {
    console.log("给课程设置标签")
    const courseTags = await redis.sadd("course:1001", "redis", "backend", "database", "nosql");
    console.log(`课程标签数量: ${courseTags}`)
    const course2Tags = await redis.sadd("course:1002", "redis", "cache", "performance", "nosql");
    console.log(`课程2标签数量: ${course2Tags}`)

    console.log("课程1001和课程1002的共同标签")
    const commonTags = await redis.sinter("course:1001", "course:1002")
    console.log(`共同标签: ${commonTags}`)

    console.log("课程1001和课程1002的并集标签")
    const unionTags = await redis.sunion("course:1001", "course:1002")
    console.log(`并集标签: ${unionTags}`)

    console.log("course:1001的独有标签")
    const uniqueTags = await redis.sdiff("course:1001", "course:1002")
    console.log(`独有标签: ${uniqueTags}`)

    console.log("判断course:1001中是否存在backend标签")
    const hasBackend = await redis.sismember("course:1001", "backend")
    console.log(`course:1001中是否存在backend标签: ${hasBackend}`)
}

async function runZSetDemo() {

}

async function main() {
    try {
        await runSetDemo();
    } catch (error) {
        console.error(error);
    } finally {
        await redis.quit();
        console.log("关闭redis连接");
    }
}
main()