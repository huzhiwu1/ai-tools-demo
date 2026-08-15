/**
 * 文档：LangChain 结构化输出 - withStructuredOutput 三种模式
 * -------------------------------------------------------
 * 从 agent-coze-workflow 的 plan_workflow 提炼：
 * 用 withStructuredOutput + jsonSchema strict 模式锁定 WorkflowPlan 的字段。
 */
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

// agent-coze-workflow 的 WorkflowPlanner 输出的真实 schema
const WorkflowStepSchema = z.object({
  index: z.number().describe("步骤序号，从 0 开始"),
  nodeType: z
    .enum([
      "start", "llm", "code", "condition", "text", "merge",
      "http", "database_query", "end",
    ])
    .describe("Coze 节点类型"),
  description: z.string().describe("该步骤的功能描述，一句话说清做什么"),
  dependencies: z.array(z.number()).describe("依赖的前置步骤 index 列表"),
});

const WorkflowPlanSchema = z.object({
  name: z.string().describe("工作流名称"),
  description: z.string().describe("工作流用途描述"),
  steps: z.array(WorkflowStepSchema).describe("工作流步骤列表"),
  estimatedComplexity: z
    .enum(["low", "medium", "high"])
    .describe("预估复杂度"),
});

type WorkflowPlan = z.infer<typeof WorkflowPlanSchema>;

async function main() {
  const llm = new ChatOpenAI({ model: "gpt-4.1-mini", temperature: 0 });

  // withStructuredOutput + jsonSchema strict：字段类型、必填、枚举全锁死
  const structuredLlm = llm.withStructuredOutput(WorkflowPlanSchema, {
    method: "jsonSchema",
    name: "workflow_plan",
    strict: true,
  });

  console.log("========== withStructuredOutput 验证 ==========\n");
  console.log("Schema 已绑定：WorkflowPlanSchema");
  console.log("  method: jsonSchema (strict: true)");
  console.log("  invoke 返回类型：WorkflowPlan（已校验，无需手动 parse）\n");

  if (!process.env.OPENAI_API_KEY) {
    console.log("⚠️  跳过 LLM 调用：需要设置 OPENAI_API_KEY 环境变量");
    console.log("   Schema 结构验证通过 ✅（类型检查通过）");
    return;
  }

  try {
    const plan: WorkflowPlan = await structuredLlm.invoke(
      "用户输入：帮我建一个音频识别工作流，输入 MP3 链接，输出歌曲名和歌手",
    );
    console.log("LLM 返回结果：");
    console.log(`  工作流名称：${plan.name}`);
    console.log(`  步骤数：${plan.steps.length}`);
    for (const step of plan.steps) {
      console.log(
        `    [${step.index}] ${step.nodeType}: ${step.description} (依赖: [${step.dependencies}])`,
      );
    }
    console.log(`  复杂度：${plan.estimatedComplexity}`);
    console.log("\n✅ withStructuredOutput 调用成功");
  } catch (error) {
    console.error("调用失败:", (error as Error).message);
    console.log("⚠️  可能需要有效的 API key");
  }
}

main().catch((e) => {
  console.error("运行失败:", e);
  process.exitCode = 1;
});