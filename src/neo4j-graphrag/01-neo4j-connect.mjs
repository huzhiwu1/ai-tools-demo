// ============================================
// 第一站：Neo4j 连接与基础 CRUD
// ============================================
//
// 【核心知识点】
// 1. Neo4j 是什么？—— 一个「图数据库」，用节点(Node)和关系(Relationship)存储数据
// 2. Cypher 是什么？—— Neo4j 的查询语言，类似 SQL 但专门为图设计
// 3. 如何用 Node.js 连接 Neo4j？—— 使用 neo4j-driver 官方驱动
//
// 【知识扩展：图数据库 vs 关系型数据库】
//
//   关系型数据库（MySQL）：数据存在表格里，表与表通过外键关联
//     - 适合：结构化数据、事务处理
//     - 缺点：多表 JOIN 查询很慢，关系越深越痛苦
//
//   图数据库（Neo4j）：数据存在「图」里，节点之间直接连着
//     - 适合：社交网络、推荐系统、知识图谱
//     - 优点：关系遍历飞快，天然适合「A 的朋友的朋友」这类查询
//
//   打个比方：
//   - MySQL 像 Excel：一张一张表，查关联要 VLOOKUP
//   - Neo4j 像思维导图：节点直接连线，一眼看到关系
//
// 【运行前提】
// 1. 先启动 Neo4j：cd src/neo4j-graphrag && docker compose up -d
// 2. 等待 10 秒让 Neo4j 完全启动
// 3. 浏览器打开 http://localhost:7474 可以看到 Web 管理界面
//
// 【运行命令】
// node src/neo4j-graphrag/01-neo4j-connect.mjs
// ============================================

import neo4j from 'neo4j-driver'

// ============================================
// 第一步：建立连接
// ============================================
// 【知识扩展：Bolt 协议】
// Neo4j 支持多种连接方式：
// - bolt://  —— 原生二进制协议，速度最快，本地/内网用这个
// - neo4j:// —— 路由协议，集群环境下自动选择读/写节点
// - http://  —— REST API，已废弃，不推荐
//
// 端口说明：
// - 7687：Bolt 协议端口（代码连接用这个）
// - 7474：HTTP 端口（浏览器 Web 界面用这个）

const driver = neo4j.driver(
    'bolt://localhost:7687',
    neo4j.auth.basic('neo4j', '12345678')  // 用户名/密码，和 docker-compose.yml 中一致
)

// 创建一个「会话」—— 类似于 MySQL 的 connection
// 【小白注意】
// session 是一次对话通道，用完要关闭（就像打电话，说完要挂断）
// 但 driver 是连接池，不需要关闭，程序结束时自动释放
const session = driver.session()

// ============================================
// 第二步：CRUD 操作
// ============================================
// 【知识扩展：Cypher 语言速览】
//
// Cypher 是 Neo4j 的查询语言，用「ASCII 艺术」表示图模式：
//
//   (n)           —— 一个节点（圆括号表示节点）
//   (n:Person)    —— 带标签的节点（Person 是标签，类似表名）
//   (n {name:"张三"})  —— 带属性的节点（花括号是属性，类似 JSON）
//   -[r]->        —— 一条有向关系（方括号表示关系，箭头表示方向）
//   -[r:朋友]->    —— 带类型的关系
//   (a)-[r]->(b)  —— 完整模式：a 通过关系 r 指向 b
//
// 对比 SQL：
//   SQL:    SELECT * FROM users WHERE name = '张三'
//   Cypher: MATCH (u:User {name: '张三'}) RETURN u
// ============================================

// --- 操作 1：创建节点（对应 SQL 的 INSERT）---
async function createData() {
    // 【小白注意】
    // Cypher 的字符串模板用反引号 ` 包裹（和 JS 模板字符串一样）
    // CREATE 创建节点，类似 INSERT INTO
    // :Product 是节点标签（类似表名）
    // {name: "红烧肉"} 是节点属性
    const result = await session.run(`
    CREATE (p:Product {name: "红烧肉"})
    CREATE (i:Ingredient {name: "五花肉"})
    RETURN p, i
  `)
    console.log('✅ 创建节点成功！')
    console.log('   创建的产品节点:', result.records[0].get('p').properties)
    console.log('   创建的食材节点:', result.records[0].get('i').properties)
}

// --- 操作 2：创建关系（SQL 没有直接对应，需要通过外键+JOIN）---
async function createRelation() {
    // 【核心知识点】
    // MATCH 先找到已有节点（类似 SELECT ... WHERE）
    // CREATE 再在它们之间建立关系
    // -[关系名]->  表示有向关系，箭头方向很重要！
    //
    // 这条语句的含义：
    // 找到"红烧肉"产品和"五花肉"食材，创建"包含"关系
    // 方向：红烧肉 -[包含]-> 五花肉（产品包含食材）
    await session.run(`
    MATCH (p:Product {name: "红烧肉"}), (i:Ingredient {name: "五花肉"})
    CREATE (p)-[:包含]->(i)
  `)
    console.log('✅ 创建关系成功：红烧肉 -[包含]-> 五花肉')
}

// --- 操作 3：查询数据（对应 SQL 的 SELECT + JOIN）---
async function queryData() {
    // 【核心知识点】
    // MATCH 模式匹配：(p)-[r]->(i)
    // 这就像 SQL 的 JOIN，但语法更直观
    //
    // 对比 SQL：
    //   SELECT p.name, r.type, i.name
    //   FROM products p
    //   JOIN product_ingredient pi ON p.id = pi.product_id
    //   JOIN ingredients i ON pi.ingredient_id = i.id
    //   WHERE p.name = '红烧肉'
    //
    // Cypher 只需要一行模式匹配！这就是图数据库的优势
    const result = await session.run(`
    MATCH (p:Product {name: "红烧肉"})-[r]->(i)
    RETURN p, r, i
  `)

    console.log('✅ 查询结果：')
    if (result.records.length === 0) {
        console.log('   （没有数据，请先运行 createData 和 createRelation）')
        console.log('   提示：取消底部的注释，按顺序运行')
    }
    result.records.forEach(record => {
        const product = record.get('p')
        const relation = record.get('r')
        const ingredient = record.get('i')
        console.log(`   产品: ${product.properties.name}`)
        console.log(`   关系: ${relation.type}`)
        console.log(`   食材: ${ingredient.properties.name}`)
        console.log('   ---')
    })
}

// --- 操作 4：更新数据（对应 SQL 的 UPDATE）---
async function updateData() {
    // 【小白注意】
    // SET 用来修改属性（类似 SQL 的 SET）
    // 可以同时设置多个属性，用逗号分隔
    await session.run(`
    MATCH (p:Product {name: "红烧肉"})
    SET p.price = 38, p.taste = "咸鲜"
  `)
    console.log('✅ 更新成功：给红烧肉添加了 price=38, taste="咸鲜"')
}

// --- 操作 5：删除关系（SQL 无直接对应）---
async function deleteRelation() {
    // 【小白注意】
    // 删除关系前必须先 MATCH 到这个关系
    // DELETE 只删除关系，不删除节点
    await session.run(`
    MATCH (p:Product {name: "红烧肉"})-[r:包含]->(i:Ingredient {name: "五花肉"})
    DELETE r
  `)
    console.log('✅ 删除关系成功：红烧肉 -[包含]-> 五花肉（关系已删除，节点还在）')
}

// --- 操作 6：删除节点（对应 SQL 的 DELETE）---
async function deleteNode() {
    // 【小白注意】
    // 如果节点还有关系连着，直接 DELETE 会报错！
    // 需要先删除所有关系，再删除节点
    // 或者用 DETACH DELETE（强制删除节点及其所有关系）
    await session.run(`
    MATCH (p:Product {name: "红烧肉"})
    DETACH DELETE p
  `)
    console.log('✅ 删除节点成功：红烧肉（及其所有关系）')
}

// ============================================
// 第三步：清理所有测试数据
// ============================================
async function cleanAll() {
    // 【小白注意】
    // MATCH (n) 匹配所有节点
    // DETACH DELETE n 删除所有节点和关系
    // ⚠️ 危险操作！相当于 DROP TABLE ALL
    await session.run(`MATCH (n) DETACH DELETE n`)
    console.log('✅ 已清空所有数据')
}

// ============================================
// 主流程：按顺序演示 CRUD
// ============================================
async function main() {
    console.log('')
    console.log('╔══════════════════════════════════════════╗')
    console.log('║    第一站：Neo4j 连接与基础 CRUD          ║')
    console.log('╚══════════════════════════════════════════╝')
    console.log('')

    try {
        // 先清空，保证干净的演示环境
        console.log('--- 清空数据 ---')
        await cleanAll()
        console.log('')

        // 1. 创建节点
        console.log('--- 1. 创建节点 ---')
        await createData()
        console.log('')

        // 2. 创建关系
        console.log('--- 2. 创建关系 ---')
        await createRelation()
        console.log('')

        // 3. 查询数据
        console.log('--- 3. 查询数据 ---')
        await queryData()
        console.log('')

        // 4. 更新数据
        console.log('--- 4. 更新数据 ---')
        await updateData()
        console.log('')

        // 5. 删除关系
        console.log('--- 5. 删除关系 ---')
        await deleteRelation()
        console.log('')

        // 6. 删除节点
        console.log('--- 6. 删除节点 ---')
        await deleteNode()
        console.log('')

        console.log('╔══════════════════════════════════════════╗')
        console.log('║  ✅ 小结                                 ║')
        console.log('╠══════════════════════════════════════════╣')
        console.log('║  Cypher 五大关键词：                       ║')
        console.log('║  ✅ CREATE  - 创建节点/关系               ║')
        console.log('║  ✅ MATCH   - 模式匹配（最常用）          ║')
        console.log('║  ✅ SET     - 更新属性                    ║')
        console.log('║  ✅ DELETE  - 删除节点/关系               ║')
        console.log('║  ✅ RETURN  - 返回结果                    ║')
        console.log('║                                          ║')
        console.log('║  下一站：02-build-food-graph.mjs          ║')
        console.log('║  → 构建完整的美食知识图谱                  ║')
        console.log('╚══════════════════════════════════════════╝')
    } catch (error) {
        console.error('❌ 出错了:', error.message)
        if (error.message.includes('Unable to connect')) {
            console.log('')
            console.log('💡 提示：Neo4j 可能没有启动！')
            console.log('   请先运行：cd src/neo4j-graphrag && docker compose up -d')
            console.log('   等待约 10 秒后再运行本文件')
        }
    } finally {
        // 【小白注意】
        // 必须关闭 session！否则连接泄漏，Neo4j 连接池会被耗尽
        await session.close()
        await driver.close()
    }
}

main()
