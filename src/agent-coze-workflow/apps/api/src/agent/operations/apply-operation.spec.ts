/**
 * [Test] applyOperations 单测（op 化一期：set / set_ref / rewrite_code）
 *
 * 职责：
 * 覆盖任务单六.2 验收用例：每个 op 的 happy / 失败 / 边界路径，
 * 以及多条混合部分失败不中断、branches expression 形状回归（codex F1）、
 * 深拷贝不污染原对象（save 失败可回滚的前提）。
 *
 * 关键细节：
 * - codeGenerator 用 mock（返回固定代码），不发起真实 LLM 调用
 * - set 的 value 类型校验在 schema 层（superRefine），apply 层不重复校验，
 *   类型不符用例直接测 schema
 * - 运行：cd apps/api && npx vitest run src/agent/operations/apply-operation.spec.ts
 */

import { describe, it, expect, vi } from "vitest";
import type { CozeWorkflow } from "@coze-workflow/workflow-schema";
import {
  UpdateOperationSchema,
  UpdateOperationsParseSchema,
  normalizeOperations,
} from "./operations.schema";
import { applyOperations, type ApplyContext } from "./apply-operation";

/** 构造测试工作流：start → llm → code → condition → end */
function makeWorkflow(): CozeWorkflow {
  return {
    meta: { name: "测试工作流", description: "单测用", version: "1" },
    nodes: [
      {
        id: "start",
        type: "start",
        title: "开始",
        inputVariables: [{ name: "input", type: "string", required: false }],
      },
      {
        id: "node_llm",
        type: "llm",
        title: "LLM 处理",
        config: { model: "Doubao-Seed-2.0-Lite" },
        userPrompt: "识别歌词",
      },
      {
        id: "node_code",
        type: "code",
        title: "相似度计算",
        code: "def main():\n    pass",
        language: "python",
        // referenceData 不在 CodeNode 类型定义里（运行时存在），测试直接塞
        referenceData: { 歌A: "歌词A" },
      },
      {
        id: "node_condition",
        type: "condition",
        title: "条件判断",
        branches: [
          { expression: "score > 0.8", targetNodeId: "end" },
          { expression: "score <= 0.8", targetNodeId: "end" },
        ],
      },
      {
        id: "end",
        type: "end",
        title: "结束",
        outputVariables: [
          { name: "final", type: "string", value: "node_llm.result" },
          { name: "errorMsg", type: "string", value: "node_llm.result" },
        ],
      },
    ],
    edges: [
      { id: "e1", sourceNodeId: "start", targetNodeId: "node_llm" },
      { id: "e2", sourceNodeId: "node_llm", targetNodeId: "node_code" },
      { id: "e3", sourceNodeId: "node_code", targetNodeId: "node_condition" },
      { id: "e4", sourceNodeId: "node_condition", targetNodeId: "end", sourcePort: "true" },
    ],
  } as unknown as CozeWorkflow;
}

/** mock CodeGenerator：返回固定代码 */
function makeCtx(extra?: Partial<ApplyContext["codeGenerator"]>): ApplyContext {
  return {
    codeGenerator: {
      generateCode: vi.fn(
        async (_logic, _inputs, refData) =>
          `# 生成的代码 refKeys=${Object.keys(refData ?? {}).join(",")}`,
      ),
      ...extra,
    },
  };
}

// ============================================
// set
// ============================================

describe("applyOperations set", () => {
  it("config.model 更新", async () => {
    const wf = makeWorkflow();
    const result = await applyOperations(
      wf,
      [
        { op: "set", target: "LLM 处理", field: "config.model", value: "Qwen3.5-Omni-Plus" },
      ],
      makeCtx(),
    );
    expect(result.changes).toContain("节点 LLM 处理 模型已更新为 Qwen3.5-Omni-Plus");
    const llm = result.workflow.nodes.find((n) => n.id === "node_llm") as {
      config: { model: string };
    };
    expect(llm.config.model).toBe("Qwen3.5-Omni-Plus");
  });

  it("branches expression 形状 set（targetNodeId 省略时保留旧值，codex F1 回归）", async () => {
    const wf = makeWorkflow();
    const result = await applyOperations(
      wf,
      [
        {
          op: "set",
          target: "条件判断",
          field: "branches",
          value: [{ expression: "score > 0.9" }],
        },
      ],
      makeCtx(),
    );
    expect(result.errors).toHaveLength(0);
    const cond = result.workflow.nodes.find((n) => n.id === "node_condition") as {
      branches: Array<{ expression: string; targetNodeId: string }>;
    };
    // expression 更新，targetNodeId 保留旧值（只改表达式场景）
    expect(cond.branches).toEqual([
      { expression: "score > 0.9", targetNodeId: "end" },
    ]);
  });

  it("branches 元素缺 expression 报错", async () => {
    const wf = makeWorkflow();
    const result = await applyOperations(
      wf,
      [
        {
          op: "set",
          target: "条件判断",
          field: "branches",
          value: [{ label: "x" }],
        },
      ],
      makeCtx(),
    );
    expect(result.changes).toHaveLength(0);
    expect(result.errors[0]).toContain("缺少 expression 字段");
  });

  it("深拷贝：原 workflow 对象不被修改", async () => {
    const wf = makeWorkflow();
    await applyOperations(
      wf,
      [
        { op: "set", target: "LLM 处理", field: "config.model", value: "X" },
      ],
      makeCtx(),
    );
    const llm = wf.nodes.find((n) => n.id === "node_llm") as {
      config: { model: string };
    };
    expect(llm.config.model).toBe("Doubao-Seed-2.0-Lite");
  });

  it("未找到节点报错", async () => {
    const wf = makeWorkflow();
    const result = await applyOperations(
      wf,
      [{ op: "set", target: "不存在的节点", field: "data", value: 1 }],
      makeCtx(),
    );
    expect(result.changes).toHaveLength(0);
    expect(result.errors).toContain("未找到节点: 不存在的节点");
  });
});

// ============================================
// set_ref
// ============================================

describe("applyOperations set_ref", () => {
  it("outputVariables 按 outputName 定向更新（多输出不改错位置，codex I3）", async () => {
    const wf = makeWorkflow();
    const result = await applyOperations(
      wf,
      [
        { op: "set_ref", target: "结束", outputName: "errorMsg", ref: "node_code.result" },
      ],
      makeCtx(),
    );
    expect(result.changes).toContain("节点 结束 输出变量 errorMsg 引用已更新为 node_code.result");
    const end = result.workflow.nodes.find((n) => n.id === "end") as {
      outputVariables: Array<{ name: string; value: string }>;
    };
    // errorMsg 更新，final 不动
    expect(end.outputVariables).toEqual([
      { name: "final", type: "string", value: "node_llm.result" },
      { name: "errorMsg", type: "string", value: "node_code.result" },
    ]);
  });

  it("非 end 节点拒绝（converter 只消费 end 的 outputVariables）", async () => {
    const wf = makeWorkflow();
    const result = await applyOperations(
      wf,
      [{ op: "set_ref", target: "LLM 处理", outputName: "final", ref: "node_code.result" }],
      makeCtx(),
    );
    expect(result.changes).toHaveLength(0);
    expect(result.errors[0]).toContain("set_ref 仅支持结束节点");
  });

  it("outputName 未匹配报错（列出已有变量名）", async () => {
    const wf = makeWorkflow();
    const result = await applyOperations(
      wf,
      [{ op: "set_ref", target: "结束", outputName: "notExist", ref: "node_code.result" }],
      makeCtx(),
    );
    expect(result.changes).toHaveLength(0);
    expect(result.errors[0]).toContain("未找到输出变量 notExist");
    expect(result.errors[0]).toContain("final、errorMsg");
  });
});

// ============================================
// rewrite_code
// ============================================

describe("applyOperations rewrite_code", () => {
  it("referenceData 合并注入：节点已有 + 用户新提供（codex I2 优先级）", async () => {
    const wf = makeWorkflow();
    const ctx = makeCtx();
    const result = await applyOperations(
      wf,
      [
        {
          op: "rewrite_code",
          target: "相似度计算",
          logicDescription: "改用编辑距离",
          referenceData: { 歌B: "歌词B" },
        },
      ],
      { ...ctx, userReferenceData: { 歌C: "歌词C" } },
    );
    expect(result.errors).toHaveLength(0);
    const gen = ctx.codeGenerator.generateCode as ReturnType<typeof vi.fn>;
    // 合并了节点已有（歌A）+ op 内嵌（歌B）+ 工具级（歌C）
    expect(gen.mock.calls[0][2]).toEqual({ 歌A: "歌词A", 歌B: "歌词B", 歌C: "歌词C" });
    const codeNode = result.workflow.nodes.find((n) => n.id === "node_code") as {
      code: string;
    };
    expect(codeNode.code).toContain("refKeys=歌A,歌B,歌C");
  });

  it("无参考数据拒绝生成（废除仍生成+警告路径）", async () => {
    const wf = makeWorkflow();
    // 清掉节点 referenceData
    delete (wf.nodes.find((n) => n.id === "node_code") as unknown as Record<
      string,
      unknown
    >).referenceData;
    const ctx = makeCtx();
    const result = await applyOperations(
      wf,
      [
        {
          op: "rewrite_code",
          target: "相似度计算",
          logicDescription: "改用编辑距离",
        },
      ],
      ctx,
    );
    expect(result.changes).toHaveLength(0);
    expect(result.errors[0]).toContain("无参考数据");
    // 未调用生成器
    expect((ctx.codeGenerator.generateCode as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("非 code 节点拒绝", async () => {
    const wf = makeWorkflow();
    const result = await applyOperations(
      wf,
      [{ op: "rewrite_code", target: "LLM 处理", logicDescription: "x" }],
      makeCtx(),
    );
    expect(result.changes).toHaveLength(0);
    expect(result.errors[0]).toContain("不是代码节点");
  });
});

// ============================================
// 二期 op / 多条混合
// ============================================

describe("applyOperations 二期 op 与多条混合", () => {
  it("delete_node / delete_edge 返回二期未启用", async () => {
    const wf = makeWorkflow();
    const result = await applyOperations(
      wf,
      [
        { op: "delete_node", target: "条件判断" },
        { op: "delete_edge", source: "a", target: "b" },
      ],
      makeCtx(),
    );
    expect(result.changes).toHaveLength(0);
    expect(result.errors).toContain("操作 delete_node 属二期，本期未启用");
    expect(result.errors).toContain("操作 delete_edge 属二期，本期未启用");
  });

  it("多条混合：部分失败不中断，成功生效", async () => {
    const wf = makeWorkflow();
    const result = await applyOperations(
      wf,
      [
        { op: "set", target: "LLM 处理", field: "config.model", value: "M1" },
        { op: "set", target: "不存在的节点", field: "data", value: 1 },
        { op: "set", target: "LLM 处理", field: "userPrompt", value: "新提示词" },
      ],
      makeCtx(),
    );
    expect(result.changes).toHaveLength(2);
    expect(result.errors).toContain("未找到节点: 不存在的节点");
  });

  it("全部失败：changes 为空（工具壳据此不消耗迭代计数）", async () => {
    const wf = makeWorkflow();
    const result = await applyOperations(
      wf,
      [
        { op: "set", target: "不存在1", field: "data", value: 1 },
        { op: "set", target: "不存在2", field: "data", value: 2 },
      ],
      makeCtx(),
    );
    expect(result.changes).toHaveLength(0);
    expect(result.errors).toHaveLength(2);
  });
});

// ============================================
// schema 层校验（codex F2：set 值类型 + 非法 field）
// ============================================

describe("UpdateOperationSchema 校验", () => {
  it("set 非法 field 拦截", () => {
    const r = UpdateOperationSchema.safeParse({
      op: "set",
      target: "x",
      field: "不存在的字段",
      value: "x",
    });
    expect(r.success).toBe(false);
  });

  it("set 值类型不符拦截（config.model 传对象，codex F2）", () => {
    const r = UpdateOperationSchema.safeParse({
      op: "set",
      target: "x",
      field: "config.model",
      value: { name: "xxx" },
    });
    expect(r.success).toBe(false);
  });

  it("set 数组字段传字符串拦截（branches 传字符串）", () => {
    const r = UpdateOperationSchema.safeParse({
      op: "set",
      target: "x",
      field: "branches",
      value: "不是数组",
    });
    expect(r.success).toBe(false);
  });

  it("set data 接受任意 JSON（ANY_FIELDS 不校验）", () => {
    const r = UpdateOperationSchema.safeParse({
      op: "set",
      target: "x",
      field: "data",
      value: { anything: [1, 2, 3] },
    });
    expect(r.success).toBe(true);
  });

  it("set_ref ref 格式非法拦截（codex I3，防 converter 静默 fallback）", () => {
    const r = UpdateOperationSchema.safeParse({
      op: "set_ref",
      target: "结束",
      outputName: "final",
      ref: "无点号格式",
    });
    expect(r.success).toBe(false);
  });

  it("合法 op 全部通过", () => {
    const r = UpdateOperationSchema.safeParse({
      op: "rewrite_code",
      target: "相似度计算",
      logicDescription: "改用编辑距离",
    });
    expect(r.success).toBe(true);
  });
});

// ============================================
// fixInstruction 宽松解析（A/B 实测校准：模型输出形状不稳定）
// ============================================

describe("UpdateOperationsParseSchema + normalizeOperations", () => {
  const one = { op: "set", target: "LLM 处理", field: "config.model", value: "M1" };
  const two = [
    one,
    { op: "set", target: "LLM 处理", field: "userPrompt", value: "新提示词" },
  ];

  it("裸数组形状（理想输出）", () => {
    const r = UpdateOperationsParseSchema.safeParse(two);
    expect(r.success).toBe(true);
    expect(normalizeOperations(r.data)).toHaveLength(2);
  });

  it("单个对象形状（模型省略数组包装，实测常见）", () => {
    const r = UpdateOperationsParseSchema.safeParse(one);
    expect(r.success).toBe(true);
    expect(normalizeOperations(r.data)).toHaveLength(1);
  });

  it("{ops:[...]} 包裹壳形状（实测常见）", () => {
    const r = UpdateOperationsParseSchema.safeParse({ ops: two });
    expect(r.success).toBe(true);
    expect(normalizeOperations(r.data)).toHaveLength(2);
  });

  it("{operations:[...]} 包裹壳形状", () => {
    const r = UpdateOperationsParseSchema.safeParse({ operations: two });
    expect(r.success).toBe(true);
    expect(normalizeOperations(r.data)).toHaveLength(2);
  });

  it("非法形状仍拦截（乱字段对象）", () => {
    const r = UpdateOperationsParseSchema.safeParse({ foo: "bar" });
    expect(r.success).toBe(false);
  });

  it("元素非法仍拦截（壳内操作缺 target）", () => {
    const r = UpdateOperationsParseSchema.safeParse({
      ops: [{ op: "set", field: "data", value: 1 }],
    });
    expect(r.success).toBe(false);
  });
});
