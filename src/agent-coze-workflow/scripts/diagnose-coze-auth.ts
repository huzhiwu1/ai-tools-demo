/**
 * Coze 认证诊断脚本 —— 在运行环境直接执行，定位 700012006 问题
 *
 * 用法：
 *   cd agent-coze-workflow/apps/api
 *   npx tsx ../../scripts/diagnose-coze-auth.ts
 *
 * 输出说明：
 * 1. 打印实际读取的 COZE_SESSION_KEY（脱敏：前 20 字符）
 * 2. 用该 key 直接调 createWorkflow（绕过 Agent，直测凭证）
 *    - 成功 → 凭证有效，问题在 Agent 工具链（coze-client.ts 单例）
 *    - 失败 → 凭证无效或网络问题，检查 .env 内容
 */
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

async function main() {
  // 1. 找 .env（与 main.ts 同逻辑）
  const candidates = [
    path.resolve(process.cwd(), "../../.env"), // apps/api -> 项目根
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "../.env"),
  ];
  let loadedPath = "";
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      dotenv.config({ path: p });
      loadedPath = p;
      break;
    }
  }
  console.log("1) 加载 .env 路径:", loadedPath || "❌ 未找到 .env");

  const key = process.env.COZE_SESSION_KEY ?? "";
  const baseUrl = process.env.COZE_API_BASE_URL ?? "";
  const spaceId = process.env.COZE_SPACE_ID ?? "";
  console.log("2) key 长度:", key.length, "| 前 20 字符:", key.slice(0, 20) + (key.length > 20 ? "…" : ""));
  console.log("   baseUrl:", baseUrl, "| spaceId:", spaceId);

  if (!key || !baseUrl || !spaceId) {
    console.log("❌ 配置缺失，请检查 .env");
    return;
  }

  // 2. 直接调 createWorkflow 测凭证
  const { CozeClient } = await import("../apps/api/src/coze/coze.client");
  const client = new CozeClient({ baseUrl, sessionKey: key, spaceId });

  console.log("3) 直接调用 createWorkflow 测试凭证…");
  try {
    const wfId = await client.createWorkflow("diag_auth_test", "认证诊断");
    console.log("   ✅ createWorkflow 成功:", wfId);
    // 清理
    try {
      await client.updateMeta(wfId, "diag_auth_test_done", "已废弃");
    } catch {}
    console.log("   👉 结论：凭证有效！问题在 Agent 工具链的 coze-client.ts 单例");
  } catch (e) {
    console.log("   ❌ createWorkflow 失败:", (e as Error).message);
    console.log("   👉 结论：凭证无效或网络问题。检查：");
    console.log("      a) .env 的 key 是否和最新的一致（长度应 214）");
    console.log("      b) 是否带引号/前缀/换行（应为纯 key）");
    console.log("      c) 网络能否访问 " + baseUrl);
  }
}

main();
