/**
 * Exercise 03: 文件系统 Middleware — 权限控制与虚拟文件系统
 *
 * 学习目标：
 * 1. 掌握 createFilesystemMiddleware 的基本用法
 * 2. 理解 FilesystemBackend 的虚拟文件系统
 * 3. 掌握权限控制（permissions）的规则匹配
 *
 * 运行方式：pnpm ex3
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent, HumanMessage } from "langchain";
import { createFilesystemMiddleware, FilesystemBackend } from "deepagents";

// ============================================
// 第一步：准备虚拟工作区
// ============================================

// __dirname 在 ESM 中不可用，需要通过 fileURLToPath 获取
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceDir = path.join(__dirname, "workspace");

// 每次运行前清空工作区，确保可复现
fs.rmSync(workspaceDir, { recursive: true, force: true });
fs.mkdirSync(workspaceDir);

// 预先创建一个「机密」文件
fs.writeFileSync(
  path.join(workspaceDir, "secret.txt"),
  "机密：不得读取",
  "utf8",
);

console.log("工作区:", workspaceDir);

// ============================================
// 第二步：定义权限规则
// ============================================

/**
 * 权限规则说明
 *
 * 规则格式：{ operations, paths, mode }
 * - operations: 适用的操作类型（read / write / edit / ls）
 * - paths: 适用的路径（支持通配符 / **）
 * - mode: allow（允许）或 deny（禁止）
 *
 * 核心原则：先匹配先生效！未命中任何规则则默认允许。
 *
 * 下面规则的含义：
 * 1. 读 /secret.txt → deny（禁止读取机密文件）
 * 2. 写 /todo.md → allow（允许写待办文件）
 * 3. 写 /** → deny（禁止写其他所有文件）
 *
 * 注意顺序！如果把规则 3 放在规则 2 前面，
 * /todo.md 会先匹配 /** 的 deny 规则，导致写 todo 也被禁止！
 */
const permissions = [
  { operations: ["read"], paths: ["/secret.txt"], mode: "deny" },
  { operations: ["write"], paths: ["/todo.md"], mode: "allow" },
  { operations: ["write"], paths: ["/**"], mode: "deny" },
];

console.log("权限:", JSON.stringify(permissions, null, 2));

// TODO: 添加一条规则，允许读取 /public/** 下的所有文件
// 提示：{ operations: ["read"], paths: ["/public/**"], mode: "allow" }
// 注意：这条规则应该放在 deny secret.txt 之后，deny /** 之前（如果有）
// 或者放在最前面（如果只是额外允许读取 public 目录）

// ============================================
// 第三步：创建 FilesystemBackend 和 Middleware
// ============================================

/**
 * [FilesystemBackend]
 *
 * 职责：提供虚拟文件系统后端
 *
 * 关键细节：
 * - rootDir: 虚拟文件系统的根目录映射到真实文件系统的哪个目录
 * - virtualMode: true 表示 Agent 看到的路径以 / 开头
 *   例如 Agent 操作 /todo.md，实际操作的是 rootDir/todo.md
 *
 * 为什么用虚拟文件系统？
 * 1. 安全性：Agent 无法访问 rootDir 以外的真实文件
 * 2. 隔离性：每次运行可以清空工作区，确保可复现
 * 3. 权限控制：可以在虚拟层做权限校验
 */
const backend = new FilesystemBackend({
  rootDir: workspaceDir,
  virtualMode: true,
});

/**
 * [createFilesystemMiddleware]
 *
 * 职责：为 Agent 提供文件操作能力
 *
 * 注入的工具：ls、read_file、write_file、edit_file
 * 这些工具会自动受 permissions 规则约束
 */
const filesystemMiddleware = createFilesystemMiddleware({
  backend,
  permissions,
});

// ============================================
// 第四步：创建 Agent
// ============================================

const model = new ChatOpenAI({
  model: process.env.MODEL_NAME,
  apiKey: process.env.OPENAI_API_KEY,
  configuration: { baseURL: process.env.OPENAI_BASE_URL },
  temperature: 0,
});

const agent = createAgent({
  model,
  tools: [],
  systemPrompt:
    "工作区根路径为 /。用 ls、read_file、write_file、edit_file 操作文件，路径以 / 开头。中文回答。",
  middleware: [filesystemMiddleware],
});

// ============================================
// 第五步：运行测试用例
// ============================================

/**
 * 测试辅助函数
 *
 * 职责：运行一次 Agent 调用并打印结果
 *
 * 流程：
 * 1. 调用 agent.invoke
 * 2. 打印所有 tool_calls（工具调用）
 * 3. 打印最终回复
 */
async function run(label, prompt) {
  console.log(`\n=== ${label} ===\n`, prompt, "\n");
  const { messages } = await agent.invoke(
    { messages: [new HumanMessage(prompt)] },
    { recursionLimit: 20 },
  );
  // 打印工具调用链
  for (const m of messages) {
    for (const t of m.tool_calls ?? []) console.log("→", t.name);
  }
  console.log("回复:", messages.at(-1)?.content);
}

/**
 * 预期拒绝的测试辅助函数
 *
 * 职责：运行一次应该被权限拒绝的 Agent 调用
 *
 * 关键细节：
 * - 被权限拒绝时，Agent 会抛出异常
 * - 通过 try/catch 捕获异常并打印错误信息
 */
async function expectDenied(label, prompt) {
  console.log(`\n=== ${label}（预期拒绝）===\n`, prompt, "\n");
  try {
    await agent.invoke(
      { messages: [new HumanMessage(prompt)] },
      { recursionLimit: 5 },
    );
    console.log("未触发拒绝（异常）");
  } catch (e) {
    const msg = e.cause?.message ?? e.message;
    console.log("✗", msg);
  }
}

// 测试 1：允许的操作 — 写 todo.md、编辑 todo.md、列出目录
await run(
  "允许的操作",
  "write_file 创建 /todo.md（三条待办），edit_file 把第一条标为完成，ls /，一句话总结。",
);

// 测试 2：禁止读取 secret.txt
await expectDenied("禁止读", "只调用 read_file，路径 /secret.txt。");

// 测试 3：禁止写入非 todo.md 的文件
await expectDenied("禁止写", "只调用 write_file，路径 /hack.txt，内容 test。");

// TODO: 添加一个测试用例，验证 /public/ 目录的读取权限
// 提示：
// 1. 先在工作区创建 public 目录和一个文件
//    fs.mkdirSync(path.join(workspaceDir, "public"), { recursive: true });
//    fs.writeFileSync(path.join(workspaceDir, "public", "info.txt"), "公开信息", "utf8");
// 2. 然后调用 run 函数测试读取
//    await run("允许读 public", "读取 /public/info.txt 的内容，一句话总结。");

/**
 * 预期输出：
 *
 * === 允许的操作 ===
 * → write_file
 * → edit_file
 * → ls
 * 回复: 已创建 /todo.md（三条待办），第一条已标为完成...
 *
 * === 禁止读 ===（预期拒绝）
 * ✗ Permission denied: read /secret.txt
 *
 * === 禁止写 ===（预期拒绝）
 * ✗ Permission denied: write /hack.txt
 *
 * 知识扩展：
 *
 * Q: 权限规则为什么用"先匹配先生效"而不是"最具体优先"？
 * A: "先匹配先生效"更直观，规则就是按声明顺序检查的。
 *    如果要覆盖前面的规则，只需在前面添加更具体的规则。
 *    这和防火墙规则的逻辑一样：规则越靠前优先级越高。
 *
 * Q: 生产环境应该怎么设置权限？
 * A: 推荐使用"默认拒绝"策略，最后一条规则设为 deny /**，
 *    然后只在前面逐条 allow 需要的路径和操作。
 *    这比"默认允许"更安全。
 */
