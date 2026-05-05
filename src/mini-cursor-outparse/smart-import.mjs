// ============================================
// smart-import.mjs
// ============================================
//
// 职责：从非结构化文本中自动提取结构化信息并写入数据库
//
// 核心架构：文本 → AI 结构化提取 → zod 校验 → MySQL 批量写入
//
// 流程：
//   1. 用 zod 定义目标数据结构（friendSchema + friendsArraySchema）
//   2. 用 model.withStructuredOutput() 包装模型，强制返回结构化数据
//   3. 构造 Prompt，把原始文本和要求传给 LLM
//   4. LLM 返回 JSON 数组，自动通过 zod 校验
//   5. 连接 MySQL，切换到 hello 数据库
//   6. 把结构化数据转成二维数组，执行批量插入
//   7. 返回插入结果（影响行数 + ID 范围）
//
// 关键技术：withStructuredOutput
//   普通调用：LLM 返回自由文本，需要手动解析
//   withStructuredOutput：LLM 按 schema 返回 JSON，自动解析和校验
//   如果 LLM 返回的数据不符合 schema（类型错误、缺少字段），会抛异常
//
// 关键细节：
//   zod 的 .describe() 是灵魂！LLM 通过描述理解每个字段该填什么
//   .nullable() 表示字段可选，找不到时 LLM 应返回 null
//   mysql2 批量插入用 VALUES ?，? 被替换为整个二维数组
//   连接用完必须在 finally 里关闭，防止连接泄漏
//
// 知识扩展：
//   为什么不用正则提取？正则对自然语言文本很脆弱，换个说法就失效。
//   AI 提取的优势：理解语义，能处理"30出头"→估算日期、"看起来"→推断性别等模糊信息。
//
//   zod 是什么？一个 TypeScript 优先的模式校验库。
//   在这里它扮演两个角色：1. 告诉 LLM 输出格式 2. 校验 LLM 返回的数据。
// ============================================

import 'dotenv/config';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import mysql from 'mysql2/promise';

// 初始化模型
const model = new ChatOpenAI({
  modelName: process.env.MODEL_NAME,
  apiKey: process.env.API_KEY,
  temperature: 0,
  configuration: {
    baseURL: process.env.BASE_URL,
  },
});

// 定义单个好友信息的 zod schema，匹配 friends 表结构
const friendSchema = z.object({
  name: z.string().describe('姓名'),
  gender: z.string().describe('性别（男/女）'),
  birth_date: z.string().describe('出生日期，格式：YYYY-MM-DD，如果无法确定具体日期，根据年龄估算'),
  company: z.string().nullable().describe('公司名称，如果没有则返回 null'),
  title: z.string().nullable().describe('职位/头衔，如果没有则返回 null'),
  phone: z.string().nullable().describe('手机号，如果没有则返回 null'),
  wechat: z.string().nullable().describe('微信号，如果没有则返回 null'),
});

// 定义批量好友信息的 schema（数组）
const friendsArraySchema = z.array(friendSchema).describe('好友信息数组');

// 使用 withStructuredOutput 方法
const structuredModel = model.withStructuredOutput(friendsArraySchema);

// 数据库连接配置
const connectionConfig = {
  host: 'localhost',
  port: 3306,
  user: 'root',
  password: 'admin',
  multipleStatements: true, // 开启发送多条SQL语句
};

async function extractAndInsert(text) {
  const connection = await mysql.createConnection(connectionConfig);

  try {
    // 切换到 hello 数据库
    await connection.query(`USE hello;`);

    // 使用 AI 提取结构化信息
    console.log('🤔 正在从文本中提取信息...\n');
    const prompt = `请从以下文本中提取所有好友信息，文本中可能包含一个或多个人的信息。请将每个人的信息分别提取出来，返回一个数组。

${text}

要求：
1. 如果文本中包含多个人，请为每个人创建一个对象
2. 每个对象包含以下字段：
   - 姓名：提取文本中的人名
   - 性别：提取性别信息（男/女）
   - 出生日期：如果能找到具体日期最好，否则根据年龄描述估算（格式：YYYY-MM-DD）
   - 公司：提取公司名称
   - 职位：提取职位/头衔信息
   - 手机号：提取手机号码
   - 微信号：提取微信号
3. 如果某个字段在文本中找不到，请返回 null
4. 返回格式必须是一个数组，即使只有一个人也要放在数组中`;

    const results = await structuredModel.invoke(prompt);

    console.log(`✅ 提取到 ${results.length} 条结构化信息:`);
    console.log(JSON.stringify(results, null, 2));
    console.log('');

    if (results.length === 0) {
      console.log('⚠️  没有提取到任何信息');
      return { count: 0, insertIds: [] };
    }

    // 批量插入数据库
    // INSERT IGNORE：遇到唯一约束冲突时自动跳过，不报错
    // 配合 uk_name_phone 唯一索引，实现"存在则忽略，不存在则插入"的幂等写入
    const insertSql = `
      INSERT IGNORE INTO friends (
        name,
        gender,
        birth_date,
        company,
        title,
        phone,
        wechat
      ) VALUES ?;
    `;

    const values = results.map((result) => [
      result.name,
      result.gender,
      result.birth_date || null,
      result.company,
      result.title,
      result.phone,
      result.wechat,
    ]);

    // mysql2 批量插入语法：
    // insertSql 里的 "?" 会被替换为整个 values 二维数组
    // 例如 VALUES (?,?), (?,?) → 变成 VALUES ('张总','女'...), ('李工','男'...)
    // query() 返回 [results, fields] 数组，解构取第一个元素 insertResult
    const [insertResult] = await connection.query(insertSql, [values]);
    console.log(`✅ 成功批量插入 ${insertResult.affectedRows} 条数据`);
    console.log(`   插入的ID范围：${insertResult.insertId} - ${insertResult.insertId + insertResult.affectedRows - 1}`);

    return {
      count: insertResult.affectedRows,
      insertIds: Array.from({ length: insertResult.affectedRows }, (_, i) => insertResult.insertId + i),
    };
  } catch (err) {
    console.error('❌ 执行出错：', err);
    throw err;
  } finally {
    await connection.end();
  }
}

// 主函数
async function main() {
  // 示例文本（包含多个人的信息）
  const sampleText = `我最近认识了几个新朋友。第一个是张总，女的，看起来30出头，在腾讯做技术总监，手机13800138000，微信是zhangzong2024。第二个是李工，男，大概28岁，在阿里云做架构师，电话15900159000，微信号lee_arch。还有一个是陈经理，女，35岁左右，在美团做产品经理，手机号是18800188000，微信chenpm2024。`;

  console.log('📝 输入文本:');
  console.log(sampleText);
  console.log('');

  try {
    const result = await extractAndInsert(sampleText);
    console.log(`\n🎉 处理完成！成功插入 ${result.count} 条记录`);
    console.log(`   插入的ID：${result.insertIds.join(', ')}`);
  } catch (error) {
    console.error('❌ 处理失败：', error.message);
    process.exit(1);
  }
}

main();
