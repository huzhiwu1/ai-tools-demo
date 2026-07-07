// ============================================
// Cypher 语法练习（空白版）
// ============================================
// 说明：
// 1. 先运行 02-build-food-graph.mjs 构建好美食知识图谱
// 2. 在下面每个 TODO 处补全 Cypher 语句
// 3. 运行：node src/neo4j-graphrag/exercise-01-cypher-blank.mjs
//
// 小提示：
// - 节点：(变量:标签 {属性})
// - 关系：-[变量:类型]->
// - 查询：MATCH ... RETURN ...
// ============================================

import neo4j from 'neo4j-driver'

const driver = neo4j.driver(
    'bolt://localhost:7687',
    neo4j.auth.basic('neo4j', '12345678')
)
const session = driver.session()

// 辅助函数：执行 Cypher 并打印结果
async function runCypher(name, cypher) {
    console.log('')
    console.log(`--- ${name} ---`)
    console.log(`Cypher: ${cypher}`)
    try {
        const result = await session.run(cypher)
        console.log(`结果数：${result.records.length}`)
        result.records.forEach((record, index) => {
            console.log(`  记录 ${index + 1}:`, JSON.stringify(record.toObject()))
        })
    } catch (e) {
        console.log(`❌ 错误：${e.message}`)
    }
}

async function main() {
    console.log('')
    console.log('╔══════════════════════════════════════════╗')
    console.log('║    Cypher 语法练习（空白版）              ║')
    console.log('╚══════════════════════════════════════════╝')

    // ==================== 基础题 ====================

    // 练习 1：查询所有 Product 节点
    await runCypher(
        '练习 1：所有产品',
        // TODO：补全下面的 Cypher，查询所有 Product 节点并返回 name
        'MATCH (p: Product {}) RETURN p.name'
    )
    // 练习 2：查询名为"宫保鸡丁"的产品
    await runCypher(
        '练习 2：查询宫保鸡丁',
        // TODO：补全下面的 Cypher
        'MATCH (p: Product {name: "宫保鸡丁"}) RETURN p.name'
    )

    // 练习 3：查询"番茄炒蛋"包含哪些食材
    // 提示：Product -[包含]-> Ingredient
    await runCypher(
        '练习 3：番茄炒蛋的食材',
        // TODO：补全下面的 Cypher
        'MATCH (p: Product {name:"番茄炒蛋"})-[r:包含]->(i:Ingredient) RETURN p.name AS product, i.name AS ingredient'
    )


    // ==================== 进阶题 ====================

    // 练习 4：查询哪些菜属于"热菜"类型
    // 提示：Product -[属于]-> Type
    await runCypher(
        '练习 4：热菜有哪些',
        // TODO：补全下面的 Cypher
        'MATCH (p:Product)-[:属于]->(t:Type {name: "热菜"}) RETURN p.name AS product, t.name AS type'
    )

    // 练习 5：查询"宫保鸡丁"的食材分别用什么做法
    // 提示：Product -[包含]-> Ingredient -[做法]-> Method
    await runCypher(
        '练习 5：宫保鸡丁食材的做法',
        // TODO：补全下面的 Cypher
        'MATCH (p: Product {name: "宫保鸡丁"})-[r:包含]->(i: Ingredient)-[m:做法]->(method: Method) RETURN p.name AS product, i.name AS ingredient, method.name AS method'
    )

    // 练习 6：统计每种类型有多少道菜
    // 提示：使用 count() 和 collect()
    await runCypher(
        '练习 6：每种类型的菜品数量',
        // TODO：补全下面的 Cypher
        'MATCH (p:Product)-[:属于]->(t:Type) RETURN t.name AS type, count(p) AS count'
    )

    // ==================== 挑战题 ====================

    // 练习 7：查询"推荐给了李四"的所有菜品，以及这些菜属于什么类型
    // 提示：Product -[推荐]-> People，还要连到 Type
    await runCypher(
        '练习 7：推荐给李四的菜及其类型',
        // TODO：补全下面的 Cypher
        'MATCH (p:Product)-[:推荐]->(people:People {name: "李四"})<-[:推荐]-(r:Recommend)-[:属于]->(t:Type) RETURN p.name AS product, t.name AS type'
    )

    // 练习 8：查询所有"炖"的食材，以及哪些菜包含这些食材
    // 提示：Ingredient -[做法]-> Method，Ingredient <-[包含]- Product
    await runCypher(
        '练习 8：炖的食材及包含它们的菜',
        // TODO：补全下面的 Cypher
        'MATCH (i: Ingredient)-[:做法]->(method: Method)<-[:包含]-(p: Product) WHERE method.name = "炖" RETURN i.name AS ingredient, collect(p.name) AS products'
    )

    // 练习 9：统计每种关系类型各有多少条
    await runCypher(
        '练习 9：统计关系数量',
        // TODO：补全下面的 Cypher
        'MATCH (a)-[r]->(b) RETURN type(r) AS relationship_type, count(r) AS count'
    )

    console.log('')
    console.log('🎉 练习完成！把不会的题目告诉我。')

    await session.close()
    await driver.close()
}

main()
