import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FilesystemBackend, createFilesystemMiddleware } from "deepagents";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent, HumanMessage } from "langchain";
import chalk from "chalk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const workspaceDir = path.join(__dirname, "workspace");

fs.rmSync(workspaceDir, { recursive: true, force: true });

fs.mkdirSync(workspaceDir, { recursive: true });
fs.mkdirSync(path.join(workspaceDir, "public"), { recursive: true });
fs.mkdirSync(path.join(workspaceDir, "secret"), { recursive: true });
fs.mkdirSync(path.join(workspaceDir, "notes"), { recursive: true });

fs.writeFileSync(
    path.join(workspaceDir, "public/readme.md"),
    "项目说明文档!",
    "utf-8",
);

fs.writeFileSync(
    path.join(workspaceDir, "secret/keys.txt"),
    `
AK=xxxx
SK=xxxx
`,
    "utf-8",
);

fs.writeFileSync(
    path.join(workspaceDir, "notes/my-note.md"),
    `# 我的笔记
    `,
    "utf-8",
);

console.log("工作区：", workspaceDir);

const permissions = [
    { operations: ["read"], paths: ["/public/**"], mode: "allow" },
    { operations: ["read", "write"], paths: ["/notes/**"], mode: "allow" },
    { operations: ["read"], paths: ["/secret/**"], mode: "deny" },
    { operations: ["write"], paths: ["/public/**"], mode: "deny" },
    { operations: ["write"], paths: ["/**"], mode: "deny" },
];

console.log("权限配置：", JSON.stringify(permissions, null, 2));

const backend = new FilesystemBackend({
    rootDir: workspaceDir,
    virtualMode: true,
});

const filesystemMiddleware = createFilesystemMiddleware({
    backend,
    permissions,
});

const model = new ChatOpenAI({
    model: process.env.MODEL_NAME,
    apiKey: process.env.API_KEY,
    temperature: 0,
    configuration: {
        baseURL: process.env.BASE_URL,
    },
});

const agent = createAgent({
    model,
    tools: [],
    systemPrompt:
        "工作区根路径为 /。用 ls、read_file、write_file、edit_file 操作文件，路径以 / 开头。中文回答。",
    middleware: [filesystemMiddleware],
});

async function run(label, prompt) {
    console.log(`\n === ${label} === \n`, prompt, "\n");

    const { messages } = await agent.invoke(
        { messages: [new HumanMessage(prompt)] },
        { recursionLimit: 20 },
    );
    for (const m of messages) {
        for (const t of m.tool_calls ?? []) console.log(chalk.blue("→"), t.name);
    }

    console.log(chalk.blue("最终回复：", messages.at(-1)?.content))
}

async function expectDenied(label, prompt) {
    console.log(`\n === ${label}（预期拒绝）=== \n`, prompt, "\n");

    try {
        const { messages } = await agent.invoke(
            { messages: [new HumanMessage(prompt)] },
            { recursionLimit: 20 },
        );
        for (const m of messages) {
            for (const t of m.tool_calls ?? []) console.log(chalk.blue("→"), t.name);
        }
        console.log(chalk.blue("最终回复：", messages.at(-1)?.content))
    } catch (e) {
        console.log("✗", e.message);
    }

}


await run("允许的操作", '读 /public/readme.md')

await run("允许的操作", '写 /notes/my-note.md 追加笔记')

await expectDenied("拒绝的操作", '读 /secret/keys.txt')

await expectDenied("拒绝的操作", '写 /public/readme.md 添加内容')

await expectDenied("拒绝的操作", '写/hack.txt')

