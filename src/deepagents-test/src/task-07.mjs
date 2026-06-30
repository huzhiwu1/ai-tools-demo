import { ChatOpenAI } from "@langchain/openai";
import "dotenv/config";
import { tool, createAgent, HumanMessage } from "langchain";
import { createSubAgentMiddleware } from "deepagents";
import { z } from "zod";

const checkNaming = tool(
  ({ code }) => {
    const issues = [];
    const lines = code.split("\n");
    const varRegex = /(?:const|let|var)\s+([a-zA-Z_$][\w$]*)/g;

    lines.forEach((line, index) => {
      let match;
      while ((match = varRegex.exec(line)) !== null) {
        const name = match[1];
        if (name.startsWith("_") || name.includes("-")) {
          issues.push({
            line: index + 1,
            name,
            suggestion: `建议改为驼峰命名，如 ${name.replace(/[-_]/g, "")}`,
          });
        }
      }
    });

    return JSON.stringify({ issues });
  },
  {
    name: "check_naming",
    description: "检查代码中变量命名是否符合驼峰命名法",
    schema: z.object({
      code: z.string().describe("待检查的代码"),
    }),
  },
);

const countComplexity = tool(
  ({ code }) => {
    const functionMatches =
      code.match(/function\s+\w+\s*\([^)]*\)\s*\{/g) || [];
    const functionCount = functionMatches.length;

    let maxLines = 0;
    // 简单统计：找函数体行数（按 { } 匹配）
    let currentLines = 0;
    let depth = 0;
    let inFunction = false;

    for (const line of code.split("\n")) {
      if (/function\s+\w+/.test(line)) {
        inFunction = true;
        currentLines = 0;
      }

      if (inFunction) {
        currentLines++;
        const openBraces = (line.match(/\{/g) || []).length;
        const closeBraces = (line.match(/\}/g) || []).length;
        depth += openBraces - closeBraces;

        if (depth === 0 && openBraces > 0) {
          maxLines = Math.max(maxLines, currentLines);
          inFunction = false;
        }
      }
    }

    return JSON.stringify({ functionCount, maxLines });
  },
  {
    name: "count_complexity",
    description: "统计代码中函数数量和最长函数行数",
    schema: z.object({
      code: z.string().describe("待分析的代码"),
    }),
  },
);

const suggestTest = tool(
  ({ functionName, description }) => {
    const testCases = [
      {
        name: `${functionName} 正常情况`,
        input: "典型输入",
        expected: "预期输出",
      },
      {
        name: `${functionName} 边界情况`,
        input: "边界输入",
        expected: "边界输出",
      },
    ];

    return JSON.stringify({ testCases });
  },
  {
    name: "suggest_test",
    description: "根据函数名和描述生成测试建议",
    schema: z.object({
      functionName: z.string().describe("函数名"),
      description: z.string().describe("函数功能描述"),
    }),
  },
);

const subagents = [
  {
    name: "code-analyzer",
    description: "做代码静态分析：检查命名规范和统计复杂度。",
    systemPrompt: [
      "你是代码静态分析专家。",
      "使用 check_naming 检查变量命名。",
      "使用 count_complexity 统计函数数量和最长函数行数。",
      "返回结构化的分析结果。",
    ].join("\n"),
    tools: [checkNaming, countComplexity],
  },
  {
    name: "test-advisor",
    description: "根据函数生成测试建议。",
    systemPrompt:
      "你是测试专家。根据 code-analyzer 的分析结果，使用 suggest_test 为每个函数生成测试用例。",
    tools: [suggestTest],
  },
  {
    name: "improvement-suggester",
    description: "根据前面分析结果提出代码优化建议。",
    systemPrompt:
      "你是代码优化专家。根据 code-analyzer 和 test-advisor 的结果，提出具体的改进建议。不要调用工具。",
    tools: [],
  },
];

const model = new ChatOpenAI({
  apiKey: process.env.API_KEY,
  modelName: process.env.MODEL_NAME,
  temperature: 0,
  configuration: {
    baseURL: process.env.BASE_URL,
  },
});

const agent = createAgent({
  model,
  tools: [],
  systemPrompt: [
    "你是代码审查主 Agent，只负责委派子 Agent，不自己分析代码。",
    "按顺序执行：① code-analyzer ② test-advisor ③ improvement-suggester。",
    "最后汇总：命名问题、复杂度统计、测试建议、优化方案。",
  ].join("\n"),
  middleware: [
    createSubAgentMiddleware({
      defaultModel: model,
      subagents,
      generalPurposeAgent: false,
    }),
  ],
});

const code = `
const my_var = 10;
const _hidden = true;

function calculateTotal(price, tax, discount) {
  let result = price * tax;
  result = result - discount;
  result = result + price;
  result = result * 0.9;
  result = result + 10;
  result = result - 5;
  result = result / 2;
  return result;
}
`;

const prompt = `请审查以下代码，按顺序完成静态分析、测试建议、优化建议，并汇总：\n\n${code}`;

const stream = await agent.streamEvents(
  { messages: [new HumanMessage(prompt)] },
  { recursionLimit: 60 },
);

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

try {
  for await (const event of stream) {
    if (event.event === "on_chat_model_stream") {
      const t = chunkText(event.data?.chunk);
      if (t) process.stdout.write(t);
    }
    if (event.event === "on_tool_start") {
      const name = event.name?.split("/").pop() ?? event.name;
      process.stdout.write(`\n\n→ ${name}\n\n`);
    }
  }
} catch (e) {
  console.error("\n\n[错误]", e.cause?.message ?? e.message);
  throw e;
}
