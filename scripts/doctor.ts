import "dotenv/config";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { paths } from "../src/db/index.js";
import { checkEnv } from "../src/llm/models.js";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fatal: boolean;
}

const checks: Check[] = [];
function check(name: string, fatal: boolean, fn: () => string): void {
  try {
    checks.push({ name, ok: true, detail: fn(), fatal });
  } catch (e) {
    checks.push({ name, ok: false, detail: (e as Error).message, fatal });
  }
}

check("Node.js 版本", true, () => {
  const major = Number(process.version.slice(1).split(".")[0]);
  if (major < 22) throw new Error(`需要 >= 22.5，当前 ${process.version}`);
  return process.version;
});

check("内置 sqlite", true, () => {
  const db = new DatabaseSync(":memory:");
  const v = (db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
  db.close();
  return `SQLite ${v}`;
});

check("FTS5 全文检索", true, () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE t USING fts5(body)");
  db.exec("INSERT INTO t(body) VALUES ('二叉查找树 binary search tree')");
  const n = db.prepare("SELECT COUNT(*) AS c FROM t WHERE t MATCH 'search'").get() as {
    c: number;
  };
  db.close();
  if (n.c !== 1) throw new Error("FTS5 匹配异常");
  return "可用";
});

check("Float32 向量 BLOB", true, () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE v(id INTEGER PRIMARY KEY, vec BLOB)");
  const f = new Float32Array([0.25, -0.5]);
  db.prepare("INSERT INTO v VALUES (1, ?)").run(Buffer.from(f.buffer, f.byteOffset, f.byteLength));
  const r = db.prepare("SELECT vec FROM v").get() as { vec: Uint8Array };
  const back = new Float32Array(new Uint8Array(r.vec).buffer, 0, 2);
  db.close();
  if (Math.abs(back[0]! - 0.25) > 1e-6) throw new Error("回读不一致");
  return "可用（无需 sqlite-vec）";
});

check("数据目录可写", true, () => {
  mkdirSync(paths.data, { recursive: true });
  const probe = resolve(paths.data, ".write-probe");
  writeFileSync(probe, "ok");
  if (!existsSync(probe)) throw new Error("写入失败");
  unlinkSync(probe);
  return paths.data;
});

check("schema 文件", true, () => {
  const files = ["learner.sql", "textbook.sql"];
  const missing = files.filter((f) => !existsSync(resolve(paths.schemaDir, f)));
  if (missing.length) throw new Error(`缺少 ${missing.join(", ")}`);
  return files.join(", ");
});

// 模型配置缺失不阻塞运行时，但要明确提示
{
  const env = checkEnv();
  checks.push({
    name: "模型环境变量",
    ok: env.ok,
    detail: env.ok ? "已配置" : `缺少 ${env.missing.join(", ")}（无法调用模型）`,
    fatal: false,
  });
  for (const w of env.warns) {
    checks.push({ name: "提示", ok: true, detail: w, fatal: false });
  }
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
console.log("\n环境自检\n" + "─".repeat(64));
for (const c of checks) {
  console.log(`${c.ok ? "✓" : c.fatal ? "✗" : "!"} ${pad(c.name, 18)} ${c.detail}`);
}
console.log("─".repeat(64));

const fatalFail = checks.filter((c) => !c.ok && c.fatal);
console.log(
  fatalFail.length === 0
    ? "运行时环境就绪。填好 .env 中的 Key 即可开始使用模型功能。"
    : `有 ${fatalFail.length} 项运行时依赖不满足，需先修复。`,
);
process.exit(fatalFail.length === 0 ? 0 : 1);
