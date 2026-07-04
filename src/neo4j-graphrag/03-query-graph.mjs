// ============================================
// 第三站：多跳关系查询与图思维
// ============================================
//
// 【核心知识点】
// 图数据库最强大的能力：多跳关系查询（Multi-hop Traversal）
// 这是 GraphRAG 的基础——LLM 需要理解如何沿关系链查询才能生成正确的 Cypher
//
// 【知识扩展：什么是「跳」？】
//
//   在图数据库中，从一个节点沿着关系走到下一个节点，叫「一跳」。
//
//   一跳：(红烧肉)-[包含]->(五花肉)           → 红烧肉包含什么食材？
//   两跳：(红烧肉)-[包含]->(五花肉)-[做法]->(炒) → 红烧肉的食材怎么烹饪？
//   三跳：(红烧肉)-[包含]->(五花肉)-[做法]->(炒)<-[做法]-(鸡蛋)<-[包含]-(番茄炒蛋)
//                                                  → 和红烧肉用相同做法的菜有哪些？
//
//   SQL 中，每一跳都需要一个 JOIN，查询越深 SQL 越复杂。
//   而 Cypher 只需要在模式匹配中多加一段箭头，非常直观。
//
// 【前提】
// 请先运行 02-build-food-graph.mjs 构建图谱数据
//
// 【运行命令】
// node src/neo4j-graphrag/03-query-graph.mjs
// ============================================

import neo4j from 'neo4j-driver'

const driver = neo4j.driver(
    'bolt://localhost:7687',
    neo4j.auth.basic('neo4j', '12345678')
)
const session = driver.session()

// ============================================
// 查询 1：一跳查询 —— 直接关系
// ============================================
// 问题：红烧肉包含哪些食材？
//
// Cypher 解读：
//   MATCH (p:Product {name: "红烧肉"})-[r:包含]->(i:Ingredient)
//   从 Product 节点出发，沿着"包含"关系，找到 Ingredient 节点
//
// SQL 等价：
//   SELECT i.name FROM products p
//   JOIN product_ingredients pi ON p.id = pi.product_id
//   JOIN ingredients i ON pi.ingredient_id = i.id
//   WHERE p.name = '红烧肉'

async function query1_OneHop() {
    console.log('')
    console.log('--- 查询 1：一跳查询 —— 红烧肉包含哪些食材？ ---')

    const result = await session.run(`
    MATCH (p:Product {name: "红烧肉"})-[r:包含]->(i:Ingredient)
    RETURN p.name AS product, i.name AS ingredient
  `)

    result.records.forEach(record => {
        console.log(`  ${record.get('product')} → 包含 → ${record.get('ingredient')}`)
    })

    if (result.records.length === 0) {
        console.log('  （无数据，请先运行 02-build-food-graph.mjs）')
    }
}

// ============================================
// 查询 2：两跳查询 —— 间接关系
// ============================================
// 问题：红烧肉的食材用什么做法烹饪？
//
// 路径：Product → [包含] → Ingredient → [做法] → Method
// 这就是「两跳」：从产品跳到食材，再从食材跳到做法
//
// 【知识扩展：多跳查询的威力】
// 在 MySQL 中，这个查询需要 3 张表的 JOIN：
//   products → product_ingredients → ingredients → ingredient_methods → methods
// 而在 Neo4j 中，只需要在 MATCH 模式中多写一段箭头！

async function query2_TwoHop() {
    console.log('')
    console.log('--- 查询 2：两跳查询 —— 红烧肉的食材用什么做法？ ---')

    const result = await session.run(`
    MATCH (p:Product {name: "红烧肉"})-[r1:包含]->(i:Ingredient)-[r2:做法]->(m:Method)
    RETURN p.name AS product, i.name AS ingredient, m.name AS method
  `)

    result.records.forEach(record => {
        console.log(`  ${record.get('product')} → 包含 → ${record.get('ingredient')} → 做法 → ${record.get('method')}`)
    })

    if (result.records.length === 0) {
        console.log('  （无数据，请先运行 02-build-food-graph.mjs）')
    }
}

// ============================================
// 查询 3：反向查询 —— 从被引用方查找引用方
// ============================================
// 问题：哪些菜推荐给了张三？
//
// 注意方向的差异：
//   创建时：(Product)-[推荐]->(People)   产品推荐给人
//   查询时：(p:Product)-[推荐]->(pe:People {name: "张三"})  方向一致
//
// 【小白注意】
// 关系的方向很重要！查询时箭头方向必须和创建时一致
// 如果你不确定方向，可以用 -[]- 不带箭头来匹配任意方向（但不推荐）

async function query3_ReverseQuery() {
    console.log('')
    console.log('--- 查询 3：反向查询 —— 哪些菜推荐给了张三？ ---')

    const result = await session.run(`
    MATCH (p:Product)-[r:推荐]->(pe:People {name: "张三"})
    RETURN p.name AS product, pe.name AS person
  `)

    result.records.forEach(record => {
        console.log(`  ${record.get('product')} → 推荐 → ${record.get('person')}`)
    })

    if (result.records.length === 0) {
        console.log('  （无数据，请先运行 02-build-food-graph.mjs）')
    }
}

// ============================================
// 查询 4：聚合查询 —— 类 SQL 的聚合函数
// ============================================
// 问题：每种类型的菜有多少个？
//
// 【知识扩展：Cypher 的聚合】
// Cypher 和 SQL 一样支持 GROUP BY 和聚合函数：
//   count()  —— 计数
//   collect() —— 收集为数组
//   sum()    —— 求和
//
// 区别：Cypher 不需要显式写 GROUP BY！
// RETURN 中非聚合的字段自动成为分组依据

async function query4_Aggregation() {
    console.log('')
    console.log('--- 查询 4：聚合查询 —— 每种类型有多少道菜？ ---')

    const result = await session.run(`
    MATCH (p:Product)-[:属于]->(t:Type)
    RETURN t.name AS type, count(p) AS dishCount, collect(p.name) AS dishes
  `)

    result.records.forEach(record => {
        console.log(`  ${record.get('type')}：${record.get('dishCount')} 道菜`)
        console.log(`    菜品：${record.get('dishes').join('、')}`)
    })

    if (result.records.length === 0) {
        console.log('  （无数据，请先运行 02-build-food-graph.mjs）')
    }
}

// ============================================
// 查询 5：路径查询 —— 查找两个节点之间的完整路径
// ============================================
// 问题：红烧肉和「炒」这种烹饪方式之间有什么关系链？
//
// 【知识扩展：可变长度路径】
// Cypher 支持可变长度的关系遍历：
//   -[*1..3]-> 表示 1 到 3 跳的关系
//   -[*2]->   表示恰好 2 跳
//   -[*]->    表示任意跳数（⚠️ 可能很慢，慎用）
//
// shortestPath() 可以查找两个节点之间的最短路径
// 这在社交网络（六度分隔理论）中非常有用

async function query5_PathQuery() {
    console.log('')
    console.log('--- 查询 5：路径查询 —— 红烧肉到"炒"的关系链 ---')

    const result = await session.run(`
    MATCH path = (p:Product {name: "红烧肉"})-[*1..3]->(m:Method {name: "炒"})
    RETURN path
    LIMIT 5
  `)

    if (result.records.length === 0) {
        console.log('  红烧肉到"炒"之间没有直接路径')
        console.log('  （红烧肉的食材五花肉用的是"炖"的做法，不是"炒"）')
    } else {
        result.records.forEach((record, index) => {
            const path = record.get('path')
            const segments = path.segments
            console.log(`  路径 ${index + 1}（${segments.length} 跳）：`)
            segments.forEach(seg => {
                const startName = seg.start.properties.name || '?'
                const endName = seg.end.properties.name || '?'
                const relType = seg.relationship.type
                console.log(`    ${startName} -[${relType}]-> ${endName}`)
            })
        })
    }
}

// ============================================
// 查询 6：全局遍历 —— GraphRAG 的核心查询模式
// ============================================
// 问题：查看所有节点和关系（GraphRAG 中 LLM 生成的 Cypher 通常类似这种）
//
// 这是 GraphRAG 最常用的查询模式：
// LLM 根据用户问题，生成一个 MATCH 模式，然后 RETURN 相关数据

async function query6_FullTraversal() {
    console.log('')
    console.log('--- 查询 6：全局遍历 —— 查看完整的图谱关系 ---')

    const result = await session.run(`
    MATCH (a)-[r]->(b)
    RETURN labels(a)[0] AS fromType, a.name AS fromName,
           type(r) AS relation,
           labels(b)[0] AS toType, b.name AS toName
    ORDER BY fromType, fromName
  `)

    console.log(`  共 ${result.records.length} 条关系：`)
    result.records.forEach(record => {
        console.log(`  (${record.get('fromType')})${record.get('fromName')} -[${record.get('relation')}]-> (${record.get('toType')})${record.get('toName')}`)
    })
}

// ============================================
// 主流程
// ============================================
async function main() {
    console.log('')
    console.log('╔══════════════════════════════════════════╗')
    console.log('║    第三站：多跳关系查询与图思维           ║')
    console.log('╚══════════════════════════════════════════╝')

    try {
        await query1_OneHop()
        await query2_TwoHop()
        await query3_ReverseQuery()
        await query4_Aggregation()
        await query5_PathQuery()
        await query6_FullTraversal()

        console.log('')
        console.log('╔══════════════════════════════════════════╗')
        console.log('║  ✅ 小结                                 ║')
        console.log('╠══════════════════════════════════════════╣')
        console.log('║  Cypher 查询核心技巧：                     ║')
        console.log('║  ✅ 一跳查询：直接关系 MATCH (a)-[r]->(b) ║')
        console.log('║  ✅ 多跳查询：链式箭头 (a)-[]->(b)-[]->(c)║')
        console.log('║  ✅ 聚合函数：count(), collect()           ║')
        console.log('║  ✅ 可变路径：-[*1..3]-> 和 shortestPath ║')
        console.log('║                                          ║')
        console.log('║  💡 关键理解：                             ║')
        console.log('║  GraphRAG 的本质就是让 LLM 学会             ║')
        console.log('║  根据用户问题生成这些 MATCH 模式！          ║')
        console.log('║                                          ║')
        console.log('║  下一站：04-graphrag.mjs                  ║')
        console.log('║  → 让 LLM 自动生成 Cypher 查询图谱       ║')
        console.log('╚══════════════════════════════════════════╝')
    } catch (error) {
        console.error('❌ 出错了:', error.message)
        if (error.message.includes('Unable to connect')) {
            console.log('💡 提示：请先启动 Neo4j → docker compose up -d')
        }
    } finally {
        await session.close()
        await driver.close()
    }
}

main()
