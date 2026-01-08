import { spawn } from "node:child_process"; // 引入 Node.js 子进程模块中的 spawn 函数

const command =
  'echo "n\nn" | pnpm create vite react-to-do --template react-ts'; // 定义要执行的命令
const cwd = process.cwd(); // 获取当前工作目录

// 将命令字符串拆分为命令 (cmd) 和参数 (args)
const [cmd, ...args] = command.split(" ");

// 创建子进程执行命令
const child = spawn(cmd, args, {
  stdio: "inherit", // 让子进程直接使用父进程的 stdin/stdout/stderr，直接在终端显示输出
  cwd, // 指定子进程的工作目录
  shell: true, // 在 shell 中运行命令 (支持 shell 语法，如通配符 *)
});

let errMsg = ""; // 用于存储错误信息

// 监听错误事件 (例如无法生成进程时)
child.on("error", (err) => {
  errMsg = err.message;
  console.error(`子进程错误: ${err.message}`);
});

// 监听进程关闭事件
child.on("close", (code) => {
  if (code === 0) {
    // 成功退出
    process.exit(0);
  } else {
    // 异常退出
    if (errMsg) {
      console.error(`子进程退出，退出码 ${code}，错误信息: ${errMsg}`);
    }
    // 使用子进程的退出码退出，如果没有则默认为 1
    process.exit(code || 1);
  }
});
