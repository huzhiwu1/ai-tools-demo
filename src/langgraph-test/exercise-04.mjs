import { StateGraph, START, END, Annotation } from "@langchain/langgraph"


const stateAnnotation = Annotation.Root({
    expression: Annotation({
        reducer: (_pre, next) => next,
        default: () => "",
    }),
    result: Annotation({
        reducer: (_pre, next) => next,
        default: () => 0,
    }),
    error: Annotation({
        reducer: (_pre, next) => next,
        default: () => null,
    })
})

const calculate = (state) => {
    try {
        const result = eval(state.expression)
        return { result, error: null }
    } catch (error) {
        return { error: error.message }
    }
}

const formatSuccess = (state) => {
    const { expression, result } = state
    console.log(`${expression} = ${result}`)
}

const formatError = (state) => {
    const { error } = state
    console.error(error)
}

const graph = new StateGraph(stateAnnotation)
    .addNode('calculate', calculate)
    .addNode('formatSuccess', formatSuccess)
    .addNode('formatError', formatError)
    .addEdge(START, 'calculate')
    .addConditionalEdges('calculate', (state) => state.error ? 'formatError' : 'formatSuccess', {
        formatSuccess: 'formatSuccess',
        formatError: 'formatError'
    })
    .addEdge('formatSuccess', END)
    .addEdge('formatError', END)
    .compile()


const drawable = await graph.getGraphAsync()
const mermaid = drawable.drawMermaid()
console.log(mermaid)
const result = await graph.invoke({ expression: "abc + def" })
console.log(result)
const result2 = await graph.invoke({ expression: "1 + 2 * 4" })
console.log(result2)
