/**
 * [Apply] applyOperations - op 指令执行器（纯函数，可单测）
 *
 * 职责：
 * 对 workflow 深拷贝后逐条执行操作指令（set / set_ref / rewrite_code），
 * 返回新 workflow 与 changes/errors 汇总，不原地修改传入对象。
 * delete_node / delete_edge 属二期，本期返回"未启用"错误。
 *
 * 流程：
 * 1. structuredClone 深拷贝 workflow（不污染缓存原对象，save 失败可回滚）
 * 2. 逐条执行操作：成功 push changes，失败 push errors，不中断
 * 3. findTargetNode 定位节点：title 精确 → id → title 包含
 * 4. 返回 { workflow, changes, errors }（迭代计数由工具壳决定）
 *
 * 关键细节：
 * - set field=branches 元素形状是 {expression, targetNodeId}（codex F1）：
 *   generator 输出该形状、schema-converter 读 branches[].expression，
 *   旧代码的 {label, condition} 是 bug（改条件后 converter 读不到）
 * - 仅改条件表达式时可省略 targetNodeId，工具侧保留旧值只替换 expression
 * - rewrite_code 参考数据优先级反转（codex I2）：节点已有 referenceData
 *   （服务端缓存真实数据）强制注入 > 用户新提供 > 都无则拒绝生成，
 *   废除"仍生成+警告"丢数据路径
 * - set_ref 限定 end 节点 + outputName 必填定位（codex I3）：
 *   converter 只消费 end 的 outputVariables，改非 end 节点无效果
 * - 值类型已由 schema superRefine 保证（STRING_FIELDS→string 等），
 *   这里只赋值不再重复校验
 */

import type { CozeWorkflow, CozeNode } from "@coze-workflow/workflow-schema";
import type { UpdateOperation } from "./operations.schema";

/** 执行结果 */
export interface ApplyResult {
  /** 修改后的 workflow（深拷贝新对象，原对象未被修改） */
  workflow: CozeWorkflow;
  /** 成功的修改描述 */
  changes: string[];
  /** 失败的操作描述 */
  errors: string[];
}

/** 执行上下文 */
export interface ApplyContext {
  /** 用户新提供的参考数据（rewrite_code 用，与节点已有数据合并） */
  userReferenceData?: Record<string, string>;
  /** LLM 生成代码用（注入合并后的参考数据） */
  codeGenerator: {
    generateCode(
      logic: string,
      inputs: string[] | undefined,
      refData: Record<string, string> | undefined,
    ): Promise<string>;
  };
}

/**
 * 按 target 查找节点：title 精确匹配 → id 匹配 → title 包含
 *
 * @returns 目标节点；未找到返回 undefined
 */
export function findTargetNode(
  nodes: CozeNode[],
  target: string,
): CozeNode | undefined {
  return (
    nodes.find((n) => n.title === target) ??
    nodes.find((n) => n.id === target) ??
    nodes.find((n) => n.title.includes(target))
  );
}

/**
 * 执行单条 set 操作：白名单字段赋值（值类型已由 schema 保证）
 *
 * branches 特殊处理（codex F1）：元素形状 {expression, targetNodeId}，
 * 仅改表达式时可省略 targetNodeId，保留旧值。
 *
 * @returns 成功返回 changes 追加项；失败返回错误字符串
 */
function applySet(
  node: CozeNode & Record<string, unknown>,
  op: Extract<UpdateOperation, { op: "set" }>,
  targetName: string,
): string[] | string {
  const { field, value } = op;

  if (field === "config.model") {
    // LLM 节点模型名：config 不存在时防御性创建
    const config = (node.config as Record<string, unknown> | undefined) ?? {};
    config.model = value;
    node.config = config;
    return [`节点 ${targetName} 模型已更新为 ${String(value)}`];
  }

  if (field === "branches") {
    // 条件节点分支：元素形状 {expression, targetNodeId}（codex F1）
    const oldBranches = (node.branches as
      | Array<{ expression?: string; targetNodeId?: string }>
      | undefined) ?? [];
    const newBranches = value as Array<Record<string, unknown>>;

    const next: Array<{ expression: string; targetNodeId?: string }> = [];
    const invalid: string[] = [];
    for (let i = 0; i < newBranches.length; i++) {
      const b = newBranches[i] as { expression?: unknown; targetNodeId?: unknown };
      if (typeof b?.expression !== "string" || b.expression.trim() === "") {
        invalid.push(String(i + 1));
        continue;
      }
      next.push({
        expression: b.expression,
        // 省略 targetNodeId 时保留旧 branches 同位置的值（只改表达式）
        targetNodeId:
          typeof b.targetNodeId === "string" && b.targetNodeId
            ? b.targetNodeId
            : (oldBranches[i]?.targetNodeId ?? ""),
      });
    }
    if (invalid.length > 0) {
      return `节点 ${targetName} branches 第 ${invalid.join("、")} 个元素缺少 expression 字段（形状应为 {expression, targetNodeId}）`;
    }
    node.branches = next;
    return [`节点 ${targetName} 条件分支已更新（expression 形状）`];
  }

  // 其余白名单字段：直接赋值（userPrompt/systemPrompt/code/language/
  // outputs/outputVariables/inputVariables/data）
  node[field] = value;
  return [`节点 ${targetName} ${field} 已更新`];
}

/**
 * 执行单条 set_ref 操作：定向改结束节点 outputVariables[].value 引用
 *
 * codex I3：限定 end 节点；outputName 必填按 name 定位；
 * 不修改 name、不修改其他元素（多输出结束节点）。
 *
 * @returns 成功返回 changes 追加项；失败返回错误字符串
 */
function applySetRef(
  node: CozeNode & Record<string, unknown>,
  op: Extract<UpdateOperation, { op: "set_ref" }>,
  targetName: string,
): string[] | string {
  if (node.type !== "end") {
    return `set_ref 仅支持结束节点，节点 ${targetName} 类型是 ${node.type}（converter 只消费 end 节点的 outputVariables）`;
  }

  const outputVars = node.outputVariables as
    | Array<{ name?: string; type?: string; value?: string }>
    | undefined;
  if (!Array.isArray(outputVars) || outputVars.length === 0) {
    return `节点 ${targetName} 没有 outputVariables 声明，无法改引用`;
  }

  const target = outputVars.find((v) => v.name === op.outputName);
  if (!target) {
    return `节点 ${targetName} 未找到输出变量 ${op.outputName}（现有：${outputVars
      .map((v) => v.name ?? "?")
      .join("、")}）`;
  }

  target.value = op.ref;
  return [`节点 ${targetName} 输出变量 ${op.outputName} 引用已更新为 ${op.ref}`];
}

/**
 * 执行单条 rewrite_code 操作：按描述重写代码节点
 *
 * codex I2 优先级反转（工具侧强制，LLM 不可覆盖）：
 * 1. 节点已有 referenceData（服务端缓存真实数据）强制注入
 * 2. 用户新提供的参考数据合并（op.referenceData + ctx.userReferenceData）
 * 3. 都无 → 拒绝生成（废除"仍生成+警告"丢数据路径）
 *
 * @returns 成功返回 changes 追加项；失败返回错误字符串
 */
async function applyRewriteCode(
  node: CozeNode & Record<string, unknown>,
  op: Extract<UpdateOperation, { op: "rewrite_code" }>,
  targetName: string,
  ctx: ApplyContext,
): Promise<string[] | string> {
  if (node.type !== "code") {
    return `节点 ${targetName} 不是代码节点（type=${String(node.type)}）`;
  }

  // 1. 节点已有 referenceData（真实数据，强制注入）
  const nodeRef = node.referenceData as Record<string, string> | undefined;
  // 2. 用户新提供（op 内嵌 + 工具级参数）
  const merged: Record<string, string> = {
    ...(nodeRef && Object.keys(nodeRef).length > 0 ? nodeRef : {}),
    ...(op.referenceData ?? {}),
    ...(ctx.userReferenceData ?? {}),
  };
  // 3. 都无 → 拒绝生成
  if (Object.keys(merged).length === 0) {
    return `节点 ${targetName} 无参考数据，请先提供歌词库/数据后再重写（防止 LLM 幻觉编造数据）`;
  }

  const code = await ctx.codeGenerator.generateCode(
    op.logicDescription,
    undefined,
    merged,
  );
  node.code = code;
  node.language = "python";
  return [`节点 ${targetName} 代码逻辑已按新描述重写（注入参考数据 ${Object.keys(merged).length} 项）`];
}

/**
 * 对 workflow 深拷贝后逐条执行操作指令
 *
 * @param workflow - 目标工作流（不会被原地修改）
 * @param operations - 操作指令数组（已过 zod 校验）
 * @param ctx - 执行上下文（参考数据 + 代码生成器）
 * @returns 新 workflow + changes/errors 汇总
 */
export async function applyOperations(
  workflow: CozeWorkflow,
  operations: UpdateOperation[],
  ctx: ApplyContext,
): Promise<ApplyResult> {
  // 深拷贝后修改：不污染缓存原对象，save 失败可回滚
  const next = structuredClone(workflow) as CozeWorkflow;

  const changes: string[] = [];
  const errors: string[] = [];

  for (const op of operations) {
    // 二期 op：schema 已定义（防 LLM 输出被静默忽略），执行返回明确错误
    if (op.op === "delete_node" || op.op === "delete_edge") {
      errors.push(`操作 ${op.op} 属二期，本期未启用`);
      continue;
    }

    const node = findTargetNode(next.nodes, op.target);
    if (!node) {
      errors.push(`未找到节点: ${op.target}`);
      continue;
    }
    const targetName = node.title;
    const loose = node as CozeNode & Record<string, unknown>;

    try {
      // 按 op 分发执行：成功返回 changes 数组，失败返回错误字符串
      const outcome =
        op.op === "set"
          ? applySet(loose, op, targetName)
          : op.op === "set_ref"
            ? applySetRef(loose, op, targetName)
            : await applyRewriteCode(loose, op, targetName, ctx);

      if (typeof outcome === "string") {
        errors.push(outcome);
      } else {
        changes.push(...outcome);
      }
    } catch (e) {
      // 单条操作异常（如代码生成失败）：不中断其他操作
      errors.push(`节点 ${targetName} ${op.op} 执行失败: ${(e as Error).message}`);
    }
  }

  return { workflow: next, changes, errors };
}
