import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 递归删除当前目录下所有 tsconfig.tsbuildinfo
 *
 * tsbuildinfo 是 TypeScript 增量编译缓存（composite 项目自动生成）。
 * 跨机器（如 Mac → Windows）拉代码时，旧缓存会导致 tsc 跳过声明文件
 * 重新生成，出现"新增字段不存在于类型"的诡异报错。
 * 因此每次 install / build 前先清掉，保证声明文件干净生成。
 */
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === ".turbo") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full);
    } else if (entry.endsWith(".tsbuildinfo")) {
      rmSync(full, { force: true });
      console.log(`removed ${full}`);
    }
  }
}

walk(process.cwd());
console.log("✓ tsbuildinfo 缓存已清理");
