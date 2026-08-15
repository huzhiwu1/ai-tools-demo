/**
 * [Script] update_workflow op 化 A/B 回放测试（codex S3 验收数据）
 *
 * 职责：
 * 用同一批真实 fixInstruction 分别跑旧 schema（{type, target, content}）
 * 与新 schema（operations 数组），对比解析成功率与平均耗时，
 * 为"op 化后 DeepSeek zod 校验成功率升/降"提供实测依据。
 *
 * 流程：
 * 1. 硬编码 20-30 条历史真实修改指令（改模型/改输出/改代码/改阈值/删节点等）
 * 2. 旧 schema：chatStructured(旧 UpdateInstructionsSchema) 逐条解析，记录成功/失败
 * 3. 新 schema：chatStructured(UpdateOperationsSchema) 逐条解析，记录成功/失败 + 耗时
 * 4. 输出对比表：旧成功率 vs 新成功率 vs 平均耗时
 *
 * 关键细节：
 * - 需要 LLM_API_KEY（或 DEEPSEEK_API_KEY）环境变量，缺失时打印提示退出
 * - 运行：cd apps/api && npx tsx scripts/ab-test-update-schema.ts
 * - token 消耗无法直接测得：DeepSeekClient.chatStructured 不返回 usage，
 *   故用耗时 + prompt 长度作代理指标，token 精确对比需 instrument 客户端
 * - 判定线（任务单五.4）：新 schema 成功率 >= 旧 schema 成功率的 90% 视为通过
 */

import { z } from "zod";
import { config as loadEnv } from "dotenv";
import { DeepSeekClient } from "../src/llm/deepseek.client";
import {
  UpdateOperationsParseSchema,
} from "../src/agent/operations/operations.schema";

// 加载 agent-coze-workflow/.env（脚本在 apps/api/scripts/，需上溯 3 级：
// scripts -> api -> apps -> agent-coze-workflow）
loadEnv({ path: new URL("../../../.env", import.meta.url).pathname });

// ============================================
// 旧 schema（{type, target, content}，历史实现副本）
// ============================================

const OldInstructionSchema = z.object({
  type: z
    .enum([
      "llm_prompt",
      "code_logic",
      "condition",
      "threshold",
      "data",
      "output_field",
      "other",
    ])
    .describe("修改类型"),
  target: z.string().describe("目标节点标识"),
  content: z.string().describe("具体修改内容"),
});

const OldInstructionsSchema = z.union([
  OldInstructionSchema,
  z.array(OldInstructionSchema),
  z.object({ modifications: z.array(OldInstructionSchema) }),
]);

// ============================================
// 回放样本（历史真实 fixInstruction，覆盖各类修改意图）
// ============================================

const CASES: string[] = [
  "把 LLM 处理节点的模型换成 Qwen3.5-Omni-Plus",
  "将模型设置为 Doubao-Seed-2.0-Lite",
  "修改提示词：要求识别歌词中的歌名和演唱者",
  "把系统提示词改成：你是专业的歌词识别助手",
  "重写相似度计算节点的逻辑，改为编辑距离算法",
  "改代码：阈值从 0.8 改为 0.6",
  "把相似度阈值从 0.8 调到 0.6",
  "更新歌词库数据，加上《青花瓷》的歌词",
  "把输出从 recognized_lyrics 改为 result",
  "输出字段 lyrics 改成 song_name",
  "结束节点输出改为引用 node_xxx.result",
  "结束节点 result 的输出源改为相似度计算节点的输出",
  "删除条件判断节点",
  "删掉相似度计算到条件判断的连线",
  "条件分支：score > 0.9 时进入结束节点",
  "修改输入：增加一个用户需求参数 personal_requirement",
  "开始节点输入增加 song_title 字段",
  "代码语言改为 javascript",
  "把数据常量 version 改成 2.0",
  "代码节点输出声明加一个 confidence 字段",
  "条件改成总分大于 90 才通过",
  "提示词里加上：输出 JSON 格式",
  "重写代码：用余弦相似度代替编辑距离",
  "模型改成 Doubao-1.5-vision-pro",
  "把最终输出变量 final 改成 answer",
  "更新《海阔天空》歌词数据",
];

// ============================================
// 解析函数
// ============================================

const OLD_SYSTEM =
  "你是工作流修改指令解析器。将用户的自然语言修改指令解析为结构化修改指令。" +
  "支持一次输出多条修改，输出数组，每条 {type, target, content}。" +
  "type 必须严格从 [llm_prompt, code_logic, condition, threshold, data, output_field, other] 中选择一项；" +
  "无法归类的指令用 type=other。";

const NEW_SYSTEM =
  "你是工作流修改指令解析器。将用户的自然语言修改指令解析为操作数组，输出 JSON 数组。" +
  "每个元素是以下三种操作之一（op 字段区分）：" +
  '{op:"set", target:"节点title或id", field:"白名单字段", value:新值}——改字段。' +
  "白名单字段：config.model（模型名，字符串）/ userPrompt / systemPrompt / code / language（以上字符串值）；" +
  "branches（条件分支数组，元素形状 {expression, targetNodeId}）/ outputs / outputVariables / inputVariables（以上数组值）；data（任意 JSON）。" +
  '{op:"set_ref", target:"结束节点", outputName:"输出变量名", ref:"nodeId.outputName"}——改结束节点输出引用。' +
  '{op:"rewrite_code", target:"代码节点", logicDescription:"新的业务逻辑描述"}——重写代码逻辑。' +
  "无法归类的指令输出空数组。";

const NODE_SUMMARY =
  '当前工作流节点摘要：[{"id":"start","title":"开始","type":"start"},' +
  '{"id":"node_llm","title":"LLM 处理","type":"llm"},' +
  '{"id":"node_code","title":"相似度计算","type":"code"},' +
  '{"id":"node_condition","title":"条件判断","type":"condition"},' +
  '{"id":"end","title":"结束","type":"end"}]';

interface CaseResult {
  ok: boolean;
  ms: number;
  error?: string;
}

/**
 * 用 DeepSeekClient 解析单个回放样本
 *
 * @param schema - zod schema（旧或新）
 * @param system - 解析器 system prompt（旧或新）
 * @returns 是否成功 + 耗时
 */
async function parseOne(
  client: DeepSeekClient,
  schema: z.ZodTypeAny,
  system: string,
  instruction: string,
): Promise<CaseResult> {
  const start = Date.now();
  try {
    await client.chatStructured(
      schema,
      system,
      `${NODE_SUMMARY}\n\n用户修改指令：${instruction}`,
      0, // 不重试：对比单次解析成功率
    );
    return { ok: true, ms: Date.now() - start };
  } catch (e) {
    return { ok: false, ms: Date.now() - start, error: (e as Error).message.slice(0, 120) };
  }
}

// ============================================
// 主流程
// ============================================

async function main() {
  const apiKey =
    process.env.LLM_API_KEY ??
    process.env.DEEPSEEK_API_KEY ??
    "";
  if (!apiKey) {
    console.log("❌ 未设置 LLM_API_KEY / DEEPSEEK_API_KEY，脚本需要真实 LLM 调用。");
    console.log("   设置后运行：cd apps/api && npx tsx scripts/ab-test-update-schema.ts");
    process.exit(0);
  }

  const client = new DeepSeekClient();
  console.log(`A/B 回放测试开始：${CASES.length} 条样本 × 2 套 schema\n`);

  const oldResults: CaseResult[] = [];
  const newResults: CaseResult[] = [];

  for (const [i, c] of CASES.entries()) {
    const oldR = await parseOne(client, OldInstructionsSchema, OLD_SYSTEM, c);
    const newR = await parseOne(client, UpdateOperationsParseSchema, NEW_SYSTEM, c);
    oldResults.push(oldR);
    newResults.push(newR);
    console.log(
      `[${String(i + 1).padStart(2, "0")}/${CASES.length}] 旧:${oldR.ok ? "✅" : "❌"}(${oldR.ms}ms) 新:${newR.ok ? "✅" : "❌"}(${newR.ms}ms) ${c}`,
    );
  }

  const sum = (r: CaseResult[]) => r.reduce((a, b) => a + b.ms, 0);
  const oldOk = oldResults.filter((r) => r.ok).length;
  const newOk = newResults.filter((r) => r.ok).length;
  const oldRate = (oldOk / CASES.length) * 100;
  const newRate = (newOk / CASES.length) * 100;

  console.log("\n================ 对比表 ================");
  console.log(`旧 schema 成功率: ${oldOk}/${CASES.length} = ${oldRate.toFixed(1)}%（平均耗时 ${(sum(oldResults) / CASES.length).toFixed(0)}ms）`);
  console.log(`新 schema 成功率: ${newOk}/${CASES.length} = ${newRate.toFixed(1)}%（平均耗时 ${(sum(newResults) / CASES.length).toFixed(0)}ms）`);
  const pass = newRate >= oldRate * 0.9;
  console.log(`判定线：新成功率 >= 旧成功率的 90%（即 >= ${(oldRate * 0.9).toFixed(1)}%）→ ${pass ? "✅ 通过" : "❌ 不通过，需调整 describe 再测"}`);
  console.log("注：token 消耗无法直接测得（chatStructured 不返回 usage），耗时作代理指标。");

  // 失败样本明细（帮助定位 schema describe 问题）
  const oldFails = oldResults.map((r, i) => ({ r, c: CASES[i] })).filter((x) => !x.r.ok);
  const newFails = newResults.map((r, i) => ({ r, c: CASES[i] })).filter((x) => !x.r.ok);
  if (newFails.length > 0) {
    console.log("\n新 schema 失败样本：");
    for (const f of newFails) console.log(`- ${f.c}\n  → ${f.r.error}`);
  }
  if (oldFails.length > 0) {
    console.log("\n旧 schema 失败样本：");
    for (const f of oldFails) console.log(`- ${f.c}\n  → ${f.r.error}`);
  }
}

main().catch((e) => {
  console.error("脚本执行失败:", e);
  process.exit(1);
});
