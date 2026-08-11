/**
 * App 根组件
 *
 * 职责：
 * - 管理全局状态（sketch / workflow / validation / logs）
 * - 实现 handleGenerate 串链路（plan → sketch → generate → validate）
 * - 三栏布局，通过 props 向子组件传递数据
 */
import { useState } from "react";
import type {
  WorkflowPlan,
  WorkflowSketch,
  ValidationResult,
} from "@coze-workflow/shared";
import { Header } from "./components/Header.js";
import { InputPanel } from "./components/InputPanel.js";
import { WorkflowCanvas } from "./components/WorkflowCanvas.js";
import { JsonPreview } from "./components/JsonPreview.js";
import { RunLogPanel } from "./components/RunLogPanel.js";
import {
  workflowApi,
  type CozeWorkflow,
  type WorkflowRunResult,
} from "./api/workflow.js";

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
      addLog(
        `收到需求: "${description.slice(0, 50)}${description.length > 50 ? "..." : ""}"`,
      );

      // 单次调用 /workflow/run，后端 LangGraph 走完整链
      const state: WorkflowRunResult = await workflowApi.run(description);

      // 按顺序推日志，每个节点有产物就展示
      if (state.plan) {
        addLog(
          `Plan: 规划完成，共 ${state.plan.steps.length} 个步骤（${state.plan.estimatedComplexity}）`,
        );
      }

      if (state.sketch) {
        setSketch(state.sketch);
        addLog(`Sketch: 草图完成，共 ${state.sketch.nodes.length} 个节点`);
      }

      if (state.workflow) {
        setWorkflow(state.workflow);
        const nodeCount = Array.isArray(state.workflow.nodes)
          ? state.workflow.nodes.length
          : "?";
        const edgeCount = Array.isArray(state.workflow.edges)
          ? state.workflow.edges.length
          : "?";
        addLog(
          `Generate: 生成完成，共 ${nodeCount} 个节点、${edgeCount} 条连线`,
        );
      }

      if (state.validation) {
        setValidation(state.validation);
        addLog(
          state.validation.valid
            ? "Validate: 校验通过"
            : `Validate: 校验失败，${state.validation.errors.length} 个错误`,
          state.validation.valid ? "success" : "error",
        );
      }

      // 修复日志（repair 级别）
      if (state.repairCount > 0) {
        addLog(`Repair: 自动修复了 ${state.repairCount} 次`, "repair");
      }

      // graph 内部产生的错误
      if (state.errors && state.errors.length > 0) {
        for (const err of state.errors) {
          addLog(err, "error");
        }
      }

      // 完成
      addLog(`完成: 总耗时 ${state.durationMs}ms`, "success");
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
          {error && (
            <p className="hint-text" style={{ color: "var(--color-accent)" }}>
              {error}
            </p>
          )}
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
