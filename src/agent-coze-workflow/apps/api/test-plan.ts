/**
 * 端到端验收脚本（可复跑）：验证关思考 + 分步生成两阶段规划
 *
 * 场景 A（模糊需求）：验证澄清路径或直接规划均不失败
 * 场景 B（多节点明确需求）：验证完整骨架 + Stage 2 逐节点 nodeConfig
 *
 * 用法：pnpm --filter @coze-workflow/api exec tsx test-plan.ts
 */
import { config } from "dotenv";
config({ path: require("path").join(__dirname, "../../.env") });
import { WorkflowPlanner } from "./src/workflow-engine/planner";
import { DeepSeekClient } from "./src/llm/deepseek.client";

async function run(label: string, description: string) {
  console.log(`\n===== 场景 ${label} =====`);
  console.log("需求:", description.slice(0, 60));
  const planner = new WorkflowPlanner(new DeepSeekClient());
  const start = Date.now();
  const plan = await planner.plan({ description });
  console.log("耗时(ms):", Date.now() - start);
  console.log("name:", plan.name);
  console.log("steps:", plan.steps.map((s) => s.nodeType).join(" → "));
  console.log("contracts 数量:", plan.steps.filter((s) => s.contract).length);
  console.log(
    "nodeConfig 节点:",
    plan.steps
      .filter((s) => s.nodeConfig)
      .map((s) => s.nodeType)
      .join(",") || "(无)",
  );
  if (plan._clarification) {
    console.log("澄清问题数:", plan._clarification.questions.length);
  }
  const json = JSON.stringify(plan);
  console.log("JSON 可序列化:", json.length > 0, `len=${json.length}`);
}

async function main() {
  console.log(
    "model:",
    process.env.LLM_MODEL,
    "| baseURL:",
    process.env.LLM_BASE_URL,
  );

  // 场景 A：需求模糊（输入/输出不明确）→ 期望走澄清路径
  await run(
    "A-澄清路径",
    "接收用户输入一个音频链接，用大模型识别歌词，再用代码节点和参考歌词库匹配判断是哪首歌",
  );

  // 场景 B：需求明确多节点 → 期望完整规划 + 逐节点 config
  await run(
    "B-多节点正常路径",
    "用户输入一个 0-100 的数字分数，用代码节点判断是否及格（60 分及格），条件节点分及格/不及格两个分支，大模型节点分别生成鼓励语或改进建议，最后返回评语文本",
  );
}

main().catch((e) => {
  console.error("FAIL 完整错误:", (e as Error).message);
  console.error("FAIL stack:", (e as Error).stack?.slice(0, 1500));
  process.exit(1);
});
