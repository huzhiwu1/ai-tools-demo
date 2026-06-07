import { StateGraph, START, END, Annotation, MemorySaver } from "@langchain/langgraph"


const stateAnnotation = Annotation.Root({
    count: Annotation({
        reducer: (_pre, next) => next,
        default: () => 0,
    }),
    message: Annotation({
        reducer: (_pre, next) => next,
        default: () => "",
    })
})

const increment = (state) => {
    const count = state.count + 1
    return {
        count: count,
        message: `当前计数: ${count}`
    }
}

const checkpointer = new MemorySaver()

const graph = new StateGraph(stateAnnotation)
    .addNode("increment", increment)
    .addEdge(START, "increment")
    .addEdge("increment", END)
    .compile({ checkpointer })


// 用户A 连续调用3次，count 应该累加到 3
const userA = { configurable: { thread_id: "user-A" } };
const result1 = await graph.invoke({}, userA);  // count = 1
console.log('userA first call', result1)
const result2 = await graph.invoke({}, userA);  // count = 2
console.log('userA second call', result2)
const result3 = await graph.invoke({}, userA);  // count = 3
console.log('userA third call', result3)

// 用户B 第一次调用，count 应该是 1（与用户A隔离）
const userB = { configurable: { thread_id: "user-B" } };
const result4 = await graph.invoke({}, userB);  // count = 1
console.log('userB first call', result4)
