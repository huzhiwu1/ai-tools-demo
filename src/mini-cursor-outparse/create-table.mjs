// ============================================
// create-table.mjs
// ============================================
//
// 职责：一键初始化 smart-import.mjs 需要的数据库和表
//
// 流程：
//   1. 连接 MySQL
//   2. 创建 hello 数据库（如果不存在）
//   3. 切换到 hello 数据库
//   4. 创建 friends 表（如果不存在）
//   5. 打印表结构确认
//   6. 关闭连接
//
// 使用方式：
//   node create-table.mjs
//
// 关键细节：
//   IF NOT EXISTS 防止重复执行报错
//   字段类型与 smart-import.mjs 中的 zod schema 一一对应
//   finally 确保连接一定关闭，防止连接泄漏
//
// 知识扩展：
//   为什么需要单独建表脚本？
//   因为 smart-import.mjs 只负责 INSERT，不负责 CREATE TABLE。
//   在实际项目中，建表通常由 migration 工具（如 flyway、prisma）管理，
//   这里用简单脚本演示，方便小白理解。
// ============================================

import mysql from 'mysql2/promise';

// 数据库连接配置
// host 用 localhost 连接本机 MySQL，port 3306 是 MySQL 默认端口
const connectionConfig = {
    host: 'localhost',
    port: 3306,
    user: 'root',
    password: 'admin',
};

async function initDatabase() {
    let connection;

    try {
        // 1. 建立连接
        console.log('🔌 正在连接 MySQL...');
        connection = await mysql.createConnection(connectionConfig);

        // 2. 创建数据库（IF NOT EXISTS 表示已存在则不报错）
        console.log('📦 创建数据库 hello...');
        await connection.query('CREATE DATABASE IF NOT EXISTS hello CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;');

        // 3. 切换到 hello 数据库
        console.log('🔄 切换到 hello 数据库...');
        await connection.query('USE hello;');

        // 4. 创建 friends 表
        // 字段设计与 smart-import.mjs 的 zod schema 对应：
        //   name       -> z.string()        -> VARCHAR(100) NOT NULL
        //   gender     -> z.string()        -> VARCHAR(10)
        //   birth_date -> z.string()        -> DATE
        //   company    -> z.string().nullable() -> VARCHAR(200)
        //   title      -> z.string().nullable() -> VARCHAR(100)
        //   phone      -> z.string().nullable() -> VARCHAR(20)
        //   wechat     -> z.string().nullable() -> VARCHAR(100)
        console.log('🗂️  创建 friends 表...');
        await connection.query(`
      CREATE TABLE IF NOT EXISTS friends (
        id INT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键ID',
        name VARCHAR(100) NOT NULL COMMENT '姓名',
        gender VARCHAR(10) COMMENT '性别',
        birth_date DATE COMMENT '出生日期',
        company VARCHAR(200) COMMENT '公司名称',
        title VARCHAR(100) COMMENT '职位/头衔',
        phone VARCHAR(20) COMMENT '手机号',
        wechat VARCHAR(100) COMMENT '微信号',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        UNIQUE KEY uk_name_phone (name, phone) COMMENT '姓名+手机号联合唯一，防止重复导入'
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='好友信息表';
    `);

        // 5. 验证表结构
        console.log('\n✅ 数据库初始化完成！表结构如下：\n');
        const [columns] = await connection.query('DESCRIBE friends;');
        console.table(columns);

        // 6. 显示当前表中的数据条数
        const [countResult] = await connection.query('SELECT COUNT(*) as total FROM friends;');
        console.log(`📊 当前表中已有 ${countResult[0].total} 条记录\n`);

    } catch (error) {
        console.error('\n❌ 初始化失败：', error.message);
        console.error('\n排查建议：');
        console.error('  1. MySQL 是否已启动？运行：docker ps | grep mysql');
        console.error('  2. 端口 3306 是否被占用？');
        console.error('  3. 用户名/密码是否正确？当前配置：root/admin');
        process.exit(1);
    } finally {
        // 无论成功还是失败，连接一定要关闭
        if (connection) {
            await connection.end();
            console.log('🔒 连接已关闭');
        }
    }
}

initDatabase();
