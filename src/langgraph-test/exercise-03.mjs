import { StateGraph, START, END, Annotation } from "@langchain/langgraph";

const stateAnnotation = Annotation.Root({
    password: Annotation({
        reducer: (_pre, next) => next,
        default: () => "",
    }),
    tries: Annotation({
        reducer: (_pre, next) => next,
        default: () => 0,
    }),
    valid: Annotation({
        reducer: (_pre, next) => next,
        default: () => false,
    }),
    message: Annotation({
        reducer: (_pre, next) => next,
        default: () => "",
    }),
});

const generate = (state) => {
    const password = Math.random().toString(36).substring(2);
    const tries = state.tries + 1;
    console.log(`$${state.tries + 1}次尝试：生成的密码是: ${password}`);
    return { password, tries };
};

const validate = (state) => {
    const { password } = state;
    const isValid = password.length >= 8 && password.match(/[0-9]/) !== null;
    console.log(`第${state.tries}次尝试：验证的密码是: ${password} 验证结果：${isValid}`);
    return { valid: isValid, message: isValid ? "密码验证通过" : "密码验证失败" };
};

const MAX_TRIES = 10;

const graph = new StateGraph(stateAnnotation)
    .addNode("generate", generate)
    .addNode("validate", validate)
    .addEdge(START, "generate")
    .addEdge("generate", "validate")
    .addConditionalEdges(
        "validate",
        (state) => ((state.valid || state.tries >= MAX_TRIES) ? "done" : "retry"),
        {
            done: END,
            retry: "generate",
        },
    )
    .compile();

const result = await graph.invoke({});
console.log("result", result);
