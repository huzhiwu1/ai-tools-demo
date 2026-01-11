import { tool } from "@langchain/core/tools";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import z from "zod";

export const readFileTool = tool(
  async ({ filePath }) => {
    const content = await fs.readFile(filePath, "utf-8");
    console.log(
      `[工具调用] readFileTool("${filePath}") 成功读取${content.length}个字符`
    );
    return `文件内容:\n ${content}`;
  },
  {
    name: "read_file",
    description:
      "用此工具来读取文件内容。当用户需要查看文件内容，读取代码，分析文件内容时使用。可以传入文件的绝对路径和相对路径。",
    schema: z.object({
      filePath: z.string().describe("文件路径"),
    }),
  }
);

// 修复说明: 之前使用 fs.readdir 获取目录是错误的，这会导致写入失败。
// 现在改用 path.dirname(filePath) 正确获取目录路径，确保文件写入功能的稳定性。
// filePath如果是不存在的，使用fs.readdir会报错，所以使用path.dirnname
export const writeFileTool = tool(
  async ({ filePath, content }) => {
    try {
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, content, "utf-8");
    } catch (error) {
      return `写入文件${filePath}失败，错误信息：${error.message}`;
    }
    console.log(
      `[工具调用] writeFileTool("${filePath}") 成功写入${content.length}个字符`
    );
    return `文件${filePath}写入成功`;
  },
  {
    name: "write_file",
    description:
      "用此工具来写入文件内容。当用户需要创建文件，写入代码，修改文件内容时使用。可以传入文件的绝对路径和相对路径。",
    schema: z.object({
      filePath: z.string().describe("文件路径"),
      content: z.string().describe("要写入的内容"),
    }),
  }
);

// 修复说明: 之前 stdio: "inherit" 导致命令输出直接打印到控制台，AI 无法读取。
// 现在通过监听 stdout 和 stderr 捕获输出并返回给 AI，使其能看到命令执行结果（如错误信息或文件列表）。
export const execCommandTool = tool(
  async ({ command, workingDirectory }) => {
    const cwd = process.cwd() || workingDirectory;
    console.log(
      ` [工具调用] execCommandTool(${command})${
        workingDirectory ? `- 工具目录：${workingDirectory}` : ""
      }`
    );
    return new Promise((resolve, reject) => {
      const [cmd, ...args] = command.split(" ");
      const child = spawn(cmd, args, {
        cwd,
        shell: true,
        stdio: "pipe",
      });
      let output = "";

      child.stdout.on("data", (data) => {
        const str = data.toString();
        output += str;
        process.stdout.write(str);
      });

      child.stderr.on("data", (data) => {
        const str = data.toString();
        output += str;
        process.stderr.write(str);
      });

      child.on("error", (err) => {
        output += err.message;
      });
      child.on("close", (code) => {
        if (code === 0) {
          const cwdInfo = workingDirectory
            ? `\n\n重要提示：命令在目录 "${workingDirectory}" 中执行成功。如果需要在这个项目目录中继续执行命令，请使用 workingDirectory: "${workingDirectory}" 参数，不要使用 cd 命令。`
            : "";
          resolve(`命令执行成功:\n${output}\n${cwdInfo}`);
        } else {
          console.log(
            `[工具调用] execCommandTool("${command}") 执行失败，退出码${code}`
          );
          resolve(`命令执行失败，退出码: ${code}\n输出:\n${output}`);
        }
      });
    });
  },
  {
    name: "exec_command",
    description:
      "用此工具来执行 shell 命令。当用户需要在命令行中执行任意命令时使用。可以传入任意 shell 命令，包括但不限于 ls, cd, pwd, git, npm, yarn 等。",
    schema: z.object({
      command: z.string().describe("要执行的 shell 命令"),
      workingDirectory: z
        .string()
        .optional()
        .describe("命令执行的工作目录，默认使用当前目录"),
    }),
  }
);

export const listDirectoryTool = tool(
  async ({ directoryPath }) => {
    try {
      const files = await fs.readdir(directoryPath);
      console.log(
        `[工具调用] listDirectoryTool("${directoryPath}") 成功读取${files.length}个文件`
      );
      return `目录 ${directoryPath} 中的文件列表:\n${files
        .map((f) => `- ${f}`)
        .join("\n")}`;
    } catch (error) {
      return `读取目录 ${directoryPath} 失败，错误信息：${error.message}`;
    }
  },
  {
    name: "list_directory",
    description:
      "用此工具来列出目录中的文件和子目录。当用户需要查看目录结构，检查文件是否存在时使用。可以传入目录的绝对路径和相对路径。",
    schema: z.object({
      directoryPath: z.string().describe("目录路径"),
    }),
  }
);
