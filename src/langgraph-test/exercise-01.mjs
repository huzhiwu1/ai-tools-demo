import { Annotation, StateGraph, START, END } from "@langchain/langgraph"

const textAnnotation = Annotation.Root({
    text: Annotation({
        reducer: (pre, next) => next,
        default: () => ""
    })
})

const toUpperCase = (state) => ({ text: state.text.toUpperCase() })

const addPrefix = (state) => ({ text: `[PROCESSED]: ${state.text}` })

const addSuffix = (state) => ({ text: `${state.text} [DONE]` })

const graph = new StateGraph(textAnnotation)
    .addNode("toUpperCase", toUpperCase)
    .addNode("addPrefix", addPrefix)
    .addNode("addSuffix", addSuffix)
    .addEdge(START, "toUpperCase")
    .addEdge("toUpperCase", "addPrefix")
    .addEdge("addPrefix", "addSuffix")
    .addEdge("addSuffix", END)
    .compile()


const drawable = await graph.getGraphAsync()
const mermaid = drawable.drawMermaid({ withStyles: true })
console.log(mermaid)

const result = await graph.invoke({ text: "hello world" })


console.log(result)