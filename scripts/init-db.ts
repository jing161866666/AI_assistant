import "dotenv/config";
import { mkdirSync } from "node:fs";
import { getLearnerDb, inspectTables, paths } from "../src/db/index.js";

function main(): void {
  console.log("→ 初始化学生本地记忆库");
  for (const d of [paths.data, paths.textbook, paths.uploads, paths.exports]) {
    mkdirSync(d, { recursive: true });
  }

  const db = getLearnerDb();
  db.exec("SELECT 1");

  const tables = inspectTables(db);
  const expected = [
    "artifact",
    "consent",
    "conversation",
    "event",
    "exercise_set",
    "goal",
    "habit",
    "habit_evidence",
    "message",
    "mistake",
    "mistake_attempt",
    "profile",
    "progress",
    "roadmap",
    "roadmap_item",
    "schedule",
    "subject",
    "sync_log",
  ];

  const got = new Set(tables.map((t) => t.name));
  const missing = expected.filter((t) => !got.has(t));
  const extra = tables.map((t) => t.name).filter((t) => !expected.includes(t));

  console.log(`\n   数据库: ${paths.learnerDb}`);
  console.log(`   表数量: ${tables.length}（预期 ${expected.length}）`);

  for (const t of tables) {
    const flag = expected.includes(t.name) ? " " : "?";
    console.log(`   ${flag} ${t.name.padEnd(18)} ${String(t.rows).padStart(6)} 行`);
  }

  if (extra.length) console.log(`\n   额外表: ${extra.join(", ")}`);

  if (missing.length) {
    console.error(`\n✗ 缺少表: ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log("\n✓ 表结构完整");
}

main();
