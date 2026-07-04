// ============================================
// 第二站：构建美食知识图谱
// ============================================
//
// 【核心知识点】
// 构建一个完整的「美食知识图谱」，包含 5 种节点类型和 4 种关系类型。
// 这是 GraphRAG 的数据基础——有了图谱，才能让 LLM 查询图数据回答问题。
//
// 【知识扩展：知识图谱是什么？】
//
//  知识图谱 = 节点 + 关系 + 属性
//
//  节点（Node）：实体，如「红烧肉」「五花肉」「炒」
//  关系（Relationship）：实体间的联系，如「包含」「属于」「做法」
//  属性（Property）：节点的描述信息，如 name、price
//
//  本教程构建的图谱结构：
//
//    (Product)   -[属于]->   (Type)       红烧肉 属于 热菜
//    (Product)   -[包含]->   (Ingredient) 红烧肉 包含 五花肉
//    (Product)   -[推荐]->   (People)     红烧肉 推荐 张三
//    (Ingredient)-[做法]->   (Method)     五花肉 做法 炒
//
//  为什么这样设计？
//  因为 GraphRAG 需要让 LLM 理解这些关系，
//  才能生成正确的 Cypher 查询来回答用户问题。
//
// 【运行命令】
// node src/neo4j-graphrag/02-build-food-graph.mjs
// ============================================

import neo4j from 'neo4j-driver'

const driver = neo4j.driver(
    'bolt://localhost:7687',
    neo4j.auth.basic('neo4j', '12345678')
)
const session = driver.session()

// ============================================
// 步骤 1：清空旧数据
// ============================================
async function cleanAll() {
    await session.run(`MATCH (n) DETACH DELETE n`)
    console.log('✅ 已清空所有旧数据')
}

// ============================================
// 步骤 2：创建所有节点
// ============================================
// 【知识扩展：MERGE vs CREATE】
//
// CREATE：无条件创建，如果节点已存在会创建重复的
// MERGE：先查找，存在则不创建，不存在才创建（类似 UPSERT）
//
// 在生产环境中推荐用 MERGE，防止重复数据
// 本教程为了教学清晰，使用 CREATE（配合先清空数据）

async function createNodes() {
    console.log('')
    console.log('--- 创建节点 ---')

    // --- 产品节点（Product）---
    // 【小白注意】
    // 一次可以执行多条 CREATE，用空格或换行分隔
    await session.run(`
    CREATE (p1:Product {name: "红烧肉"})
    CREATE (p2:Product {name: "番茄炒蛋"})
    CREATE (p3:Product {name: "宫保鸡丁"})
  `)
    console.log('  ✅ 创建 3 个产品节点：红烧肉、番茄炒蛋、宫保鸡丁')

    // --- 类型节点（Type）---
    await session.run(`
    CREATE (t1:Type {name: "热菜"})
    CREATE (t2:Type {name: "凉菜"})
  `)
    console.log('  ✅ 创建 2 个类型节点：热菜、凉菜')

    // --- 食材节点（Ingredient）---
    await session.run(`
    CREATE (i1:Ingredient {name: "五花肉"})
    CREATE (i2:Ingredient {name: "鸡蛋"})
    CREATE (i3:Ingredient {name: "番茄"})
    CREATE (i4:Ingredient {name: "鸡胸肉"})
    CREATE (i5:Ingredient {name: "花生"})
  `)
    console.log('  ✅ 创建 5 个食材节点：五花肉、鸡蛋、番茄、鸡胸肉、花生')

    // --- 做法节点（Method）---
    await session.run(`
    CREATE (m1:Method {name: "炒"})
    CREATE (m2:Method {name: "炖"})
  `)
    console.log('  ✅ 创建 2 个做法节点：炒、炖')

    // --- 人物节点（People）---
    await session.run(`
    CREATE (pe1:People {name: "张三"})
    CREATE (pe2:People {name: "李四"})
    CREATE (pe3:People {name: "王五"})
  `)
    console.log('  ✅ 创建 3 个人物节点：张三、李四、王五')

    console.log('')
    console.log('  📊 节点总计：3 产品 + 2 类型 + 5 食材 + 2 做法 + 3 人物 = 15 个节点')
}

// ============================================
// 步骤 3：创建所有关系
// ============================================
// 【核心知识点】
// 创建关系必须先 MATCH 到两端节点，再用 CREATE 建立关系
// 语法：MATCH (a), (b) CREATE (a)-[关系]->(b)
//
// 【知识扩展：关系的方向】
// 关系是有方向的！用箭头表示：
//   (红烧肉)-[包含]->(五花肉)  表示"红烧肉包含五花肉"
//   方向反过来意思就不同了
//
// 设计原则：从「主体」指向「客体」
//   产品 → 类型（红烧肉 属于 热菜）
//   产品 → 食材（红烧肉 包含 五花肉）
//   产品 → 人物（红烧肉 推荐 张三）
//   食材 → 做法（五花肉 做法 炒）

async function createRelations() {
    console.log('')
    console.log('--- 创建关系 ---')

    // --- 产品 → 类型（属于）---
    await session.run(`
    MATCH (p:Product {name: "红烧肉"}), (t:Type {name: "热菜"})
    CREATE (p)-[:属于]->(t)
  `)
    await session.run(`
    MATCH (p:Product {name: "番茄炒蛋"}), (t:Type {name: "热菜"})
    CREATE (p)-[:属于]->(t)
  `)
    await session.run(`
    MATCH (p:Product {name: "宫保鸡丁"}), (t:Type {name: "热菜"})
    CREATE (p)-[:属于]->(t)
  `)
    console.log('  ✅ 红烧肉、番茄炒蛋、宫保鸡丁 → 属于 → 热菜')

    // --- 产品 → 食材（包含）---
    // 红烧肉：五花肉
    await session.run(`
    MATCH (p:Product {name: "红烧肉"}), (i:Ingredient {name: "五花肉"})
    CREATE (p)-[:包含]->(i)
  `)
    // 番茄炒蛋：鸡蛋 + 番茄
    await session.run(`
    MATCH (p:Product {name: "番茄炒蛋"}), (i:Ingredient {name: "鸡蛋"})
    CREATE (p)-[:包含]->(i)
  `)
    await session.run(`
    MATCH (p:Product {name: "番茄炒蛋"}), (i:Ingredient {name: "番茄"})
    CREATE (p)-[:包含]->(i)
  `)
    // 宫保鸡丁：鸡胸肉 + 花生
    await session.run(`
    MATCH (p:Product {name: "宫保鸡丁"}), (i:Ingredient {name: "鸡胸肉"})
    CREATE (p)-[:包含]->(i)
  `)
    await session.run(`
    MATCH (p:Product {name: "宫保鸡丁"}), (i:Ingredient {name: "花生"})
    CREATE (p)-[:包含]->(i)
  `)
    console.log('  ✅ 红烧肉→五花肉, 番茄炒蛋→鸡蛋+番茄, 宫保鸡丁→鸡胸肉+花生')

    // --- 食材 → 做法（做法关系）---
    await session.run(`
    MATCH (i:Ingredient {name: "五花肉"}), (m:Method {name: "炖"})
    CREATE (i)-[:做法]->(m)
  `)
    await session.run(`
    MATCH (i:Ingredient {name: "鸡蛋"}), (m:Method {name: "炒"})
    CREATE (i)-[:做法]->(m)
  `)
    await session.run(`
    MATCH (i:Ingredient {name: "鸡胸肉"}), (m:Method {name: "炒"})
    CREATE (i)-[:做法]->(m)
  `)
    console.log('  ✅ 五花肉→炖, 鸡蛋→炒, 鸡胸肉→炒')

    // --- 产品 → 人物（推荐）---
    await session.run(`
    MATCH (p:Product {name: "红烧肉"}), (pe:People {name: "张三"})
    CREATE (p)-[:推荐]->(pe)
  `)
    await session.run(`
    MATCH (p:Product {name: "红烧肉"}), (pe:People {name: "李四"})
    CREATE (p)-[:推荐]->(pe)
  `)
    await session.run(`
    MATCH (p:Product {name: "番茄炒蛋"}), (pe:People {name: "王五"})
    CREATE (p)-[:推荐]->(pe)
  `)
    console.log('  ✅ 红烧肉→张三+李四, 番茄炒蛋→王五')
}

// ============================================
// 步骤 4：验证图谱
// ============================================
async function verifyGraph() {
    console.log('')
    console.log('--- 验证图谱 ---')

    // 统计节点数
    const nodeCount = await session.run(`MATCH (n) RETURN count(n) AS cnt`)
    console.log(`  📊 节点总数：${nodeCount.records[0].get('cnt')}`)

    // 统计关系数
    const relCount = await session.run(`MATCH ()-[r]->() RETURN count(r) AS cnt`)
    console.log(`  📊 关系总数：${relCount.records[0].get('cnt')}`)

    // 查看所有关系类型
    const relTypes = await session.run(`
    MATCH (a)-[r]->(b)
    RETURN DISTINCT labels(a)[0] AS fromLabel, type(r) AS relType, labels(b)[0] AS toLabel
    ORDER BY fromLabel
  `)
    console.log('')
    console.log('  📋 关系类型总览：')
    relTypes.records.forEach(record => {
        console.log(`    (${record.get('fromLabel')}) -[${record.get('relType')}]-> (${record.get('toLabel')})`)
    })
}

// ============================================
// 主流程
// ============================================
async function main() {
    console.log('')
    console.log('╔══════════════════════════════════════════╗')
    console.log('║    第二站：构建美食知识图谱               ║')
    console.log('╚══════════════════════════════════════════╝')

    try {
        await cleanAll()
        await createNodes()
        await createRelations()
        await verifyGraph()

        console.log('')
        console.log('╔══════════════════════════════════════════╗')
        console.log('║  ✅ 小结                                 ║')
        console.log('╠══════════════════════════════════════════╣')
        console.log('║  本图谱包含 5 种节点：                      ║')
        console.log('║    Product, Type, Ingredient,            ║')
        console.log('║    Method, People                        ║')
        console.log('║                                          ║')
        console.log('║  4 种关系：                                ║')
        console.log('║    属于、包含、做法、推荐                   ║')
        console.log('║                                          ║')
        console.log('║  💡 打开 http://localhost:7474            ║')
        console.log('║     输入 MATCH (n) RETURN n 可视化图谱    ║')
        console.log('║                                          ║')
        console.log('║  下一站：03-query-graph.mjs               ║')
        console.log('║  → 用 Cypher 进行多跳关系查询             ║')
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
