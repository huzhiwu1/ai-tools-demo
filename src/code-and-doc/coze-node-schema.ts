/**
 * 文档：Coze 节点 schema 变量引用排雷
 * -------------------------------------------------------
 * 从 agent-coze-workflow 的 schema-converter.ts 提炼：
 * LLM/HTTP/Text 三种节点类型，三种变量引用语法，不能混用。
 */
import assert from "node:assert/strict";

type NodeType = "llm" | "http" | "text";

interface VariableRef {
  nodeId: string;
  field: string;
}

// LLM 节点（type=3）：prompt 里用 {{var}} 简写
function resolveLlmRef(ref: VariableRef): string {
  return `{{${ref.field}}}`;
}

// HTTP 节点（type=45）：URL 必须用完整 block_output 路径
function resolveHttpRef(ref: VariableRef): string {
  return `{{block_output_${ref.nodeId}.${ref.field}}}`;
}

// 文本节点（type=15）：concatResult 用简写，但 concatParams 三项必须齐全
function buildTextConcat(vars: VariableRef[]): {
  concatResult: string;
  arrayItemConcatChar: string;
  allArrayItemConcatChars: { label: string; value: string; isDefault: boolean }[];
} {
  const concatResult = vars.map((v) => `{{${v.field}}}`).join("+");
  return {
    concatResult,
    arrayItemConcatChar: "\\n",
    allArrayItemConcatChars: [
      { label: "换行", value: "\\n", isDefault: true },
      { label: "逗号", value: ",", isDefault: false },
      { label: "空格", value: " ", isDefault: false },
    ],
  };
}

// 统一入口：按节点类型选择引用语法
function resolveVariableRef(nodeType: NodeType, ref: VariableRef): string {
  switch (nodeType) {
    case "llm":
      return resolveLlmRef(ref);
    case "http":
      return resolveHttpRef(ref);
    case "text":
      return `{{${ref.field}}}`;
    default:
      throw new Error(`Unknown node type: ${nodeType}`);
  }
}

// ===== 验证 =====
function main() {
  console.log("========== 三种节点变量引用语法验证 ==========\n");

  const ref: VariableRef = { nodeId: "100001", field: "city" };

  // LLM 节点：简写
  const llmResult = resolveVariableRef("llm", ref);
  assert.strictEqual(llmResult, "{{city}}");
  console.log(`[LLM 节点]  prompt 引用语法：${llmResult}`);
  console.log("  → 大模型能直接解析，不需要完整 block_output 路径\n");

  // HTTP 节点：完整路径
  const httpResult = resolveVariableRef("http", ref);
  assert.strictEqual(httpResult, "{{block_output_100001.city}}");
  console.log(`[HTTP 节点] URL 引用语法：${httpResult}`);
  console.log("  → 必须用完整 block_output 路径，简写 {{city}} 无效\n");

  // 文本节点：concatParams 三项齐全
  const textConcat = buildTextConcat([
    { nodeId: "100001", field: "name" },
    { nodeId: "100001", field: "age" },
  ]);
  assert.strictEqual(textConcat.concatResult, "{{name}}+{{age}}");
  assert.strictEqual(textConcat.arrayItemConcatChar, "\\n");
  assert.strictEqual(textConcat.allArrayItemConcatChars.length, 3);
  console.log(`[文本节点] concatResult：${textConcat.concatResult}`);
  console.log(`  arrayItemConcatChar：${textConcat.arrayItemConcatChar}`);
  console.log(`  allArrayItemConcatChars：${textConcat.allArrayItemConcatChars.length} 项`);
  console.log("  → concatParams 三项缺一不可，少了保存会失败\n");

  console.log("========== 全部验证通过 ✅ ==========");
}

main();