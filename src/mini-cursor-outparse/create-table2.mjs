import chalk from 'chalk';
import mysql from 'mysql2/promise';


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
        console.log(chalk.blue('🔌 正在连接 MySQL...'))
        connection = await mysql.createConnection(connectionConfig);
        // 2. 创建数据库
        console.log(chalk.green('📦 创建数据库 article（文章） ...'))
        await connection.query('CREATE DATABASE IF NOT EXISTS article CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;');

        // 3.  切换到 article 数据库
        console.log(chalk.green('✅ 切换到 article 数据库  ...'))
        await connection.query('USE article;');

        // 4. 创建表
        console.log(chalk.green(' 🗂️  创建 articles（文章列表） ...'))

        await connection.query(`
            CREATE TABLE IF NOT EXISTS articles (
            id INT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键ID',
            name VARCHAR(100) NOT NULL COMMENT '文章名称',
            author VARCHAR(100) NOT NULL COMMENT '作者',
            description VARCHAR(255) NOT NULL COMMENT '文章描述',
            UNIQUE KEY uk_name_author (name, author) COMMENT '文章名称+作者联合唯一，防止重复导入'
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='文章列表';
            `)

        // 5.验证表结构
        console.log(chalk.green(' 📜  验证表结构 articles ...'))
        const [rows] = await connection.query('DESCRIBE articles;');
        console.table(rows);

    } catch (e) {
        console.error(chalk.red(e));
    } finally {
        if (connection) {
            await connection.end();
            console.log('🔒 连接已关闭');
        }
    }
}
initDatabase()