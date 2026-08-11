/**
 * App 根组件
 *
 * 职责：
 * - 管理全局状态（sketch / workflow / validation / logs）
 * - 实现 handleGenerate 串链路（plan → sketch → generate → validate）
 * - 三栏布局，通过 props 向子组件传递数据
 */
import { useState } from "react";
import type { WorkflowPlan, WorkflowSketch, ValidationResult } from "@coze-workflow/shared";
import { Header } from "./components/Header.js";
import { InputPanel } from "./components/InputPanel.js";
import { WorkflowCanvas } from "./components/WorkflowCanvas.js";
import { JsonPreview } from "./components/JsonPreview.js";
import { RunLogPanel } from "./components/RunLogPanel.js";
import { workflowApi, type CozeWorkflow } from "./api/workflow.js";

type LogEntry = { time: string; level: string; msg: string };

export default function App() {
  const [sketch, setSketch] = useState<WorkflowSketch | null>(null);
  const [workflow, setWorkflow] = useState<CozeWorkflow | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 追加一条日志 */
  function addLog(msg: string, level: string = "info") {
    const now = new Date();
    const time = now.toTimeString().slice(0, 8);
    setLogs((prev) => [...prev, { time, level, msg }]);
  }

  /** 生成工作流 */
  async function handleGenerate(description: string) {
    if (loading || !description.trim()) return;

    setLoading(true);
    setError(null);
    setSketch(null);
    setWorkflow(null);
    setValidation(null);
    setLogs([]);

    try {
      addLog(`收到需求: "${description.slice(0, 50)}${description.length > 50 ? "..." : ""}"`);

      // Step 1: plan
      addLog("Plan: 正在分析需求...");
      const plan: WorkflowPlan = await workflowApi.plan(description);
      addLog(`Plan: 规划完成，共 ${plan.steps.length} 个步骤`);

      // Step 2: sketch
      addLog("Sketch: 正在生成草图...");
      const sketchData = await workflowApi.sketch(description);
      setSketch(sketchData);
      addLog(`Sketch: 草图完成，共 ${sketchData.nodes.length} 个节点`);

      // Step 3: generate
      addLog("Generate: 正在生成 Coze JSON...");
      const wf = await workflowApi.generate(plan);
      setWorkflow(wf);
      const nodeCount = Array.isArray(wf.nodes) ? wf.nodes.length : "?";
      const edgeCount = Array.isArray(wf.edges) ? wf.edges.length : "?";
      addLog(`Generate: 生成完成，共 ${nodeCount} 个节点、${edgeCount} 条连线`);

      // Step 4: validate
      addLog("Validate: 正在校验...");
      const v = await workflowApi.validate(wf);
      setValidation(v);
      addLog(
        v.valid
          ? "Validate: 校验通过"
          : `Validate: 校验失败，${v.errors.length} 个错误`,
        v.valid ? "success" : "error"
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      addLog(`Error: ${msg}`, "error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app">
      <Header />
      <main className="main-layout">
        <aside className="panel panel-left">
          <InputPanel onGenerate={handleGenerate} loading={loading} />
          {error && <p className="hint-text" style={{ color: "var(--color-accent)" }}>{error}</p>}
        </aside>
        <section className="panel panel-center">
          <WorkflowCanvas sketch={sketch} />
        </section>
        <aside className="panel panel-right">
          <JsonPreview workflow={workflow} validation={validation} />
          <RunLogPanel logs={logs} />
        </aside>
      </main>
    </div>
  );
}
