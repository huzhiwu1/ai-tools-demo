// 验证 LangGraph store API 在当前版本是否可用
import { InMemoryStore } from "@langchain/langgraph";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";

async function main() {
  console.log("版本:", require("@langchain/langgraph/package.json").version);

  // 1. InMemoryStore 是否存在
  const store = new InMemoryStore();
  console.log("InMemoryStore 创建 OK");

  // 2. store.put / store.get 是否可用
  await store.put(["user-zhangsan"], "profile", { name: "张三", preference: "简洁" });
  console.log("store.put OK");

  const mem = await store.get(["user-zhangsan"], "profile");
  console.log("store.get OK:", JSON.stringify(mem));

  // 3. store.search 是否可用
  const results = await store.search(["user-zhangsan"]);
  console.log("store.search OK, 结果数:", results.length);

  // 4. compile({ checkpointer, store }) 是否接受
  const State = Annotation.Root({ x: Annotation<number>({ default: () => 0 }) });
  const g = new StateGraph(State)
    .addNode("n", async (s) => ({ x: s.x + 1 }))
    .addEdge(START, "n").addEdge("n", END)
    .compile({ store });  // 不带 checkpointer，只测 store 参数是否接受
  console.log("compile({ store }) OK");
  const r = await g.invoke({});
  console.log("invoke OK:", JSON.stringify(r));
}
main().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
