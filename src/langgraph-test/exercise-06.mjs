import {
    StateGraph,
    START,
    END,
    Annotation,
    interrupt,
    MemorySaver,
    Command,
} from "@langchain/langgraph";

const stateAnnotation = Annotation.Root({
    fileName: Annotation({
        reducer: (_pre, next) => next,
        default: () => "",
    }),
    userConfirm: Annotation({
        reducer: (_pre, next) => next,
        default: () => "",
    }),
    result: Annotation({
        reducer: (_pre, next) => next,
        default: () => "",
    }),
    actionSummary: Annotation({
        reducer: (_pre, next) => next,
        default: () => "",
    }),
});

const showWarning = (state) => {
    const { fileName } = state;
    return {
        actionSummary: `即将删除文件: ${fileName}`,
    };
};

const waitConfirm = (state) => {
    const { fileName, actionSummary } = state;

    const text = interrupt({
        hint: `请确认删除文件: ${fileName}`,
        actionSummary,
    });
    return {
        userConfirm: String(text),
    };
};

const executeDelete = (state) => {
    const { fileName, userConfirm } = state;
    return {
        result:
            userConfirm.toLowerCase() === "y"
                ? `已删除文件: ${fileName}`
                : `操作已取消`,
    };
};

const checkpointer = new MemorySaver()

const graph = new StateGraph(stateAnnotation)
    .addNode("showWarning", showWarning)
    .addNode('waitConfirm', waitConfirm)
    .addNode('executeDelete', executeDelete)
    .addEdge(START, "showWarning")
    .addEdge("showWarning", "waitConfirm")
    .addEdge("waitConfirm", "executeDelete")
    .addEdge("executeDelete", END)
    .compile({ checkpointer })


const user = { configurable: { thread_id: "user-A" } };

const paused = await graph.invoke({ fileName: '重要文件.txt' }, user)

console.log(paused.__interrupt__)

const done = await graph.invoke(new Command({ resume: 'y' }), user)

console.log(done.result)
