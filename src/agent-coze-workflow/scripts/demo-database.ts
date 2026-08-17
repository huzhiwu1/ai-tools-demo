/**
 * 数据库能力演示脚本：创建"空姐列表"数据库并导入数据
 *
 * 复现 2026-08-17 平台抓包流程（hzw_1 表：url + song 字段）。
 *
 * 用法：
 *   cd agent-coze-workflow
 *   npx tsx scripts/demo-database.ts <space_id> <xlsx_path>
 *
 * 示例：
 *   npx tsx scripts/demo-database.ts 7560621359533916160 /tmp/coze-probe/songs.xlsx
 */
import * as fs from "node:fs";
import { DatabaseClient } from "../apps/api/src/coze/database-client";

// 手动解析 .env（tsx 的 dotenvx 注入会干扰 dotenv.config，直接读文件最稳）
function loadEnv() {
  const paths = [
    "/Users/huzhiwu/workspace/ai-tools-demo/src/agent-coze-workflow/.env",
    "./.env",
    "../.env",
  ];
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    const env: Record<string, string> = {};
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (m) env[m[1]] = m[2].trim();
    }
    return env;
  }
  return {};
}
const envFile = loadEnv();

async function main() {
  const spaceId = process.argv[2];
  const xlsxPath = process.argv[3];
  if (!spaceId || !xlsxPath) {
    console.error("用法: npx tsx scripts/demo-database.ts <space_id> <xlsx_path>");
    process.exit(1);
  }
  // 优先扫码凭证（~/.coze/credentials.json，skill 统一凭证），fallback .env
  let baseUrl = envFile.COZE_API_BASE_URL ?? process.env.COZE_API_BASE_URL ?? "";
  let sessionKey = envFile.COZE_SESSION_KEY ?? process.env.COZE_SESSION_KEY ?? "";
  const credPath = "/Users/huzhiwu/.coze/credentials.json";
  if (fs.existsSync(credPath)) {
    const cred = JSON.parse(fs.readFileSync(credPath, "utf8"));
    if (cred?.session_key && cred?.origin) {
      baseUrl = cred.origin;
      sessionKey = cred.session_key;
      console.log("ℹ️ 使用扫码凭证（~/.coze/credentials.json）");
    }
  }
  if (!baseUrl || !sessionKey) {
    console.error("❌ 缺少 COZE_API_BASE_URL / COZE_SESSION_KEY");
    process.exit(1);
  }

  const db = new DatabaseClient({ baseUrl, sessionKey });

  console.log("0) 可用空间:");
  for (const s of await db.listSpaces()) {
    console.log(`   ${s.id}  ${s.name}  [${s.role_name ?? ""}]`);
  }

  console.log(`\n1) 创建数据库（space=${spaceId}）...`);
  const { databaseId, actualTableName } = await db.createDatabase({
    spaceId,
    tableName: "hzw_" + Date.now().toString().slice(-4),
    tableDesc: "空姐列表（url + song）",
    fields: [
      { name: "url", desc: "音频链接", type: 1, must_required: true },
      { name: "song", desc: "歌曲名", type: 1, must_required: true },
    ],
  });
  console.log(`   ✅ database_id=${databaseId} table=${actualTableName}`);

  console.log("2) 上传文件...");
  const tosUri = await db.uploadFile(xlsxPath);
  console.log(`   ✅ tos_uri=${tosUri}`);

  console.log("3) 校验 + 导入...");
  const r = await db.importData(databaseId, tosUri);
  console.log(`   ✅ 提交: ${JSON.stringify(r)}`);

  console.log("4) 轮询进度...");
  for (let i = 0; i < 20; i++) {
    await new Promise((res) => setTimeout(res, 3000));
    const { progress } = await db.getProgress(databaseId);
    console.log(`   进度: ${progress}%`);
    if (progress >= 100) { console.log("🎉 导入完成"); break; }
  }

  console.log("\n5) 数据库列表:");
  for (const d of await db.listDatabases(spaceId)) {
    console.log(`   ${d.id}  ${d.table_name}`);
  }
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
