/**
 * App 根组件
 *
 * 设计思想：
 * - 三栏布局：左侧输入 → 中间画布 → 右侧输出
 * - 每栏是独立组件，职责单一
 * - 后续通过状态管理（如 Zustand）连接各组件
 *
 * TODO: 后续接入真实后端 API
 */
import { Header } from "./components/Header.js";
import { InputPanel } from "./components/InputPanel.js";
import { WorkflowCanvas } from "./components/WorkflowCanvas.js";
import { JsonPreview } from "./components/JsonPreview.js";
import { RunLogPanel } from "./components/RunLogPanel.js";

export default function App() {
  return (
    <div className="app">
      <Header />
      <main className="main-layout">
        <aside className="panel panel-left">
          <InputPanel />
        </aside>
        <section className="panel panel-center">
          <WorkflowCanvas />
        </section>
        <aside className="panel panel-right">
          <JsonPreview />
          <RunLogPanel />
        </aside>
      </main>
    </div>
  );
}
