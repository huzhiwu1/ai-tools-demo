import { START, END, Annotation, StateGraph } from "@langchain/langgraph";


const StateAnnotation = Annotation.Root({
    text: Annotation({
        reducer: (pre, next) => next,
        default: () => ""
    }),
    mood: Annotation({
        reducer: (pre, next) => next,
        default: () => "neutral"
    }),
    reply: Annotation({
        reducer: (pre, next) => next,
        default: () => ""
    })
})

const detectMood = (state) => {
    const HappyWords = ["开心", "高兴", "哈哈"]
    const SadWords = ["难过", "伤心", "哭"]
    const isHappy = HappyWords.some((word) => state.text.includes(word))
    const isSad = SadWords.some((word) => state.text.includes(word))
    return {
        mood: isHappy ? "happy" : isSad ? "sad" : "neutral"
    }
}

const happyReply = (state) => ({ reply: "你看起来很开心！" })
const sadReply = (state) => ({ reply: "你看起来很难过啊！" })
const neutralReply = (state) => ({ reply: "看起来你没有什么情绪。" })

const graph = new StateGraph(StateAnnotation)
    .addNode("detectMood", detectMood)
    .addNode("happyReply", happyReply)
    .addNode("neutralReply", neutralReply)
    .addNode("sadReply", sadReply)
    .addEdge(START, "detectMood")
    .addConditionalEdges('detectMood', (state) => state.mood, {
        happy: "happyReply",
        sad: "sadReply",
        neutral: "neutralReply"
    })
    .addEdge('happyReply', END)
    .addEdge('sadReply', END)
    .addEdge('neutralReply', END)
    .compile()

const drawable = await graph.getGraphAsync()
const mermaid = drawable.drawMermaid({ withStyles: true })

console.log(mermaid)

const result1 = await graph.invoke({ text: "我今天很开心！" })
console.log(result1)
const result2 = await graph.invoke({ text: "我今天过得一般。" })
console.log(result2)
const result3 = await graph.invoke({ text: "我今天很难过。" })
console.log(result3)
