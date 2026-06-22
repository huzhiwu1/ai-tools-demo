/**
 * Exercise 07: Skills Middleware — 技能扩展（进阶）
 *
 * 学习目标：
 * 1. 了解 createSkillsMiddleware 的技能扩展机制
 * 2. 理解 Skills 和传统 Tools 的区别
 * 3. 了解技能的安装和使用流程
 *
 * 运行方式：pnpm ex7
 *
 * 前置条件：需要先安装技能包
 *   npx skills add github/awesome-copilot --skill excalidraw-diagram-generator -y
 *
 * 注意：此练习为进阶内容，需要网络环境和技能包支持。
 * 如果无法安装技能包，可以只阅读代码和注释，了解 Skills 的工作原理。
 */

import "dotenv/config";
import { existsSync, mkdirSync } from "node:fs";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent, HumanMessage } from "langchain";
import {
  LocalShellBackend,
  createFilesystemMiddleware,
  createSkillsMiddleware,
} from "deepagents";

// ============================================
// 第一步：检查技能包是否已安装
// ============================================

/**
 * 技能目录说明
 *
 * 技能安装后，会在项目根目录下创建 .agents/skills/ 目录：
 * .agents/skills/
 *   └── excalidraw-diagram-generator/
 *       └── SKILL.md   ← 技能描述文件（核心！）
 *
 * SKILL.md 是一个 Markdown 文件，描述了：
 * - 技能名称和用途
 * - 使用该技能的步骤和注意事项
 * - 输入输出格式
 *
 * LLM 读取 SKILL.md 后，就知道如何使用这个技能完成任务。
 */
const skills = "/.agents/skills/";
const output = "src/deepagents/output/deepagents-skills-flow.excalidraw";

if (!existsSync(".agents/skills/excalidraw-diagram-generator/SKILL.md")) {
  console.error("未找到 excalidraw-diagram-generator 技能包！");
  console.error(
    "请先运行: npx skills add github/awesome-copilot --skill excalidraw-diagram-generator -y",
  );
  console.error("\n你也可以只阅读本文件的代码和注释，了解 Skills 的工作原理。");
  process.exit(0);
}

// ============================================
// 第二步：准备输出目录
// ============================================

mkdirSync("src/deepagents/output", { recursive: true });

// ============================================
// 第三步：创建 Backend 和 Agent
// ============================================

const model = new ChatOpenAI({
  model: process.env.MODEL_NAME,
  apiKey: process.env.OPENAI_API_KEY,
  configuration: { baseURL: process.env.OPENAI_BASE_URL },
  temperature: 0,
  streaming: true,
});

/**
 * [LocalShellBackend]
 *
 * 职责：提供本地 Shell 环境的文件系统后端
 *
 * 与 FilesystemBackend 的区别：
 * - FilesystemBackend: 只支持虚拟文件系统操作（read/write/edit/ls）
 * - LocalShellBackend: 支持真实的本地文件系统操作
 *   更适合需要读写项目真实文件的场景
 *
 * 参数说明：
 * - rootDir: 工作区根目录
 * - virtualMode: true 表示使用虚拟路径
 * - inheritEnv: true 表示继承当前进程的环境变量
 */
const backend = await LocalShellBackend.create({
  rootDir: ".",
  virtualMode: true,
  inheritEnv: true,
});

/**
 * [createSkillsMiddleware]
 *
 * 职责：读取技能包的 SKILL.md，注入到 Agent 的上下文中
 *
 * 流程：
 * 1. 读取 sources 路径下的所有 SKILL.md 文件
 * 2. 将技能描述注入到 Agent 的 systemMessage 中
 * 3. Agent 根据用户需求，选择合适的技能并按指引执行
 *
 * 关键参数：
 * - backend: 文件系统后端
 * - sources: 技能文件路径（可以是目录或文件）
 *
 * 为什么用 Sources 数组？
 * - 你可以有多个技能目录
 * - 每个目录下可以有多个技能
 * - Middleware 会自动发现所有 SKILL.md
 */
const agent = createAgent({
  model,
  tools: [],
  systemPrompt:
    "按 skills 库完成任务，需要时 read_file 对应 SKILL.md。中文回答。",
  middleware: [
    // 注意：SkillsMiddleware 需要在 FilesystemMiddleware 前面
    // 因为 SkillsMiddleware 可能需要读取技能文件
    createSkillsMiddleware({ backend, sources: [skills] }),
    createFilesystemMiddleware({ backend }),
  ],
});

// ============================================
// 第四步：运行 Agent（流式输出）
// ============================================

const prompt = [
  "画一张流程图，描述本项目的 skills-agent 工作流：",
  "用户 Prompt → createAgent → createSkillsMiddleware → createFilesystemMiddleware → 模型回复。",
  `保存为 ${output}。要求：`,
  "- 顶部大标题 + 副标题",
  "- 每个主节点 numbered（①②…）且框内 2～3 行中文说明",
  "- 右侧一列「说明：…」补充细节",
  "- 箭头上标注阶段名（如 invoke、wrapModelCall）",
  "- 底部图例（颜色含义 + 如何运行 demo）",
].join("\n");

console.log("用户:", prompt);

/**
 * 流式输出处理（同 Exercise 06）
 */
function chunkText(chunk) {
  if (!chunk?.content) return "";
  if (typeof chunk.content === "string") return chunk.content;
  if (Array.isArray(chunk.content)) {
    return chunk.content
      .map((p) => (typeof p === "string" ? p : (p?.text ?? "")))
      .join("");
  }
  return "";
}

const stream = await agent.streamEvents(
  { messages: [new HumanMessage(prompt)] },
  { recursionLimit: 100 },
);

let skillsMetadata;
console.log("\n--- 流式输出 ---\n");

try {
  for await (const event of stream) {
    if (event.event === "on_chat_model_stream") {
      const text = chunkText(event.data?.chunk);
      if (text) process.stdout.write(text);
    }
    if (event.event === "on_tool_start") {
      const name = event.name?.split("/").pop() ?? event.name;
      process.stdout.write(`\n\n→ ${name}\n\n`);
    }
    if (event.event === "on_chain_end" && event.data?.output?.skillsMetadata) {
      skillsMetadata = event.data.output.skillsMetadata;
    }
  }
} catch (e) {
  console.error("\n\n[错误]", e.cause?.message ?? e.message);
  throw e;
}

console.log("\n");
console.log(
  "skills:",
  skillsMetadata?.map((s) => s.name),
);
if (existsSync(output)) {
  console.log("图表:", output);
  console.log("打开: https://excalidraw.com → Open → 选择该文件");
} else {
  console.log("未生成:", output);
}

await backend.close();

/**
 * 知识扩展：
 *
 * Q: Skills 和传统 Tools 有什么区别？
 * A:
 * | 维度 | Tools | Skills |
 * |------|-------|--------|
 * | 定义方式 | 代码（函数 + zod schema） | Markdown（自然语言描述） |
 * | 灵活性 | 固定行为，参数决定输出 | LLM 自由解释，适应性强 |
 * | 安装方式 | npm 包 | npx skills add |
 * | 适用场景 | 精确操作（计算、查询、API 调用） | 复杂流程（绘图、生成代码、多步骤任务） |
 * | 可读性 | 代码，需要编程知识 | Markdown，非技术人员也能理解 |
 * | 调试方式 | 单元测试 | 阅读执行日志 |
 *
 * Q: 什么时候用 Tools，什么时候用 Skills？
 * A: - 需要精确控制 → Tools（如计算器、数据库查询）
 *    - 需要灵活适应 → Skills（如绘图、写文案、代码生成）
 *    - 两者可以组合使用！
 *
 * Q: skillsMetadata 是什么？
 * A: 它是 SkillsMiddleware 在执行完成后返回的元数据，
 *    包含了本次 Agent 执行中使用了哪些技能。
 *    可用于追踪和分析 Agent 的技能使用情况。
 */
