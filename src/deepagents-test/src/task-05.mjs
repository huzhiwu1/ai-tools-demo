import "dotenv/config"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createMemoryMiddleware, FilesystemBackend, createFilesystemMiddleware } from "deepagents"
import { createAgent, HumanMessage } from "langchain"
import { ChatOpenAI } from "@langchain/openai"
import chalk from "chalk"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const workspaceDir = path.join(__dirname, "workspace")

fs.rmSync(workspaceDir, { recursive: true, force: true })

fs.mkdirSync(workspaceDir, { recursive: true })


const projectMemoryPath = "/AGENTS.md"
const preferencesMemoryPath = "/memory/preferences.md"
const contextMemoryPath = "/memory/context.md"

for (const file of [projectMemoryPath, preferencesMemoryPath, contextMemoryPath]) {
    const filepath = path.join(workspaceDir, file)
    if (!fs.existsSync(filepath)) {
        fs.mkdirSync(path.dirname(filepath), { recursive: true })
        fs.writeFileSync(filepath, "", "utf-8")
    }
}


const backend = new FilesystemBackend({
    rootDir: workspaceDir,
    virtualMode: true,
})


const memoryMiddleware = createMemoryMiddleware({
    backend,
    sources: [projectMemoryPath, preferencesMemoryPath, contextMemoryPath]
})


const filesystemMiddleware = createFilesystemMiddleware({
    backend,
})

const model = new ChatOpenAI({
    model: process.env.MODEL_NAME,
    apiKey: process.env.API_KEY,
    temperature: 0,
    configuration: {
        baseURL: process.env.BASE_URL,
    },
})

const agent = createAgent({
    model,
    tools: [],
    systemPrompt: [
        "你是项目助手。工作区根路径为 /，可用 ls、read_file、write_file、edit_file。",
        "根据 <agent_memory> 回答；用户要求记住时，必须立刻 edit_file，且按类型写入对应文件：",
        `- ${projectMemoryPath}：项目说明、技术栈、架构、仓库约定等`,
        `- ${preferencesMemoryPath}：用户个人偏好（语言、包管理器、回答风格等）`,
        `- ${contextMemoryPath}：对话上下文（当前任务、待办事项）`,
        "不要混写：项目事实不要写入 preferences，个人偏好不要写入 AGENTS.md。",
    ].join("\n"),
    middleware: [filesystemMiddleware, memoryMiddleware],
})


const prompts = [
    "记住：项目使用 DeepAgents 框架 + LangChain",
    "记住：我偏好 TypeScript 而非 JavaScript",
    "记住：当前任务是学习 MemoryMiddleware",
    "我偏好的语言是什么？项目用了什么框架？当前在做什么？分别回答",
]

let messages = []

async function run() {
    for (const prompt of prompts) {
        console.log(chalk.green(`问题：${prompt}`));
        ({ messages } = await agent.invoke({
            messages: [...messages, new HumanMessage(prompt)]
        }, {
            recursionLimit: 20,
        }));

        console.log(chalk.blue(`回复：${messages.at(-1)?.content}`))
    }
}


await run()


console.log('\n\n === 记忆文件内容 ===\n\n')

for (const file of [projectMemoryPath, preferencesMemoryPath, contextMemoryPath]) {
    const filepath = path.join(workspaceDir, file)
    if (fs.existsSync(filepath)) {
        const content = fs.readFileSync(filepath, 'utf-8')
        console.log(`== ${file} ==\n${content}\n`)
    } else {
        console.log(`== ${file} ==\n文件不存在\n`)
    }
}
