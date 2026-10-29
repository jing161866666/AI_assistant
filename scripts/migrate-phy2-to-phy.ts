import "dotenv/config";
import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 把旧科目代码 PHY2 的记忆迁到 PHY（大学物理）。
 *
 * 用法：
 *   npx tsx scripts/migrate-phy2-to-phy.ts          # 只看影响行数（默认 dry-run）
 *   npx tsx scripts/migrate-phy2-to-phy.ts --apply  # 真执行（先备份 learner.db）
 *
 * 只改 course_code 这一个字段，不动章号与内容：
 * 新库章号是 9–16，旧进度也是 9–15 体系，直接对得上。
 */

const FROM = "PHY2";
const TO = "PHY";
const APPLY = process.argv.includes("--apply");

/** 带 course_code 的表（schedule 也迁：课表里那门课同样是大学物理） */
const TABLES = [
  "chapter_progress",
  "progress",
  "mistake",
  "habit",
  "goal",
  "conversation",
  "exercise_set",
  "roadmap_item",
  "schedule",
];

const { getLearnerDb, paths } = await import("../src/db/index.js");
const db = getLearnerDb();

function cols(table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

const counts: Array<{ table: string; rows: number }> = [];
for (const t of TABLES) {
  if (!cols(t).has("course_code")) continue;
  const r = db.prepare(`SELECT COUNT(*) c FROM "${t}" WHERE course_code = ?`).get(FROM) as {
    c: number;
  };
  counts.push({ table: t, rows: Number(r.c) });
}

console.log(`\n迁移 ${FROM} → ${TO}（${APPLY ? "执行" : "dry-run"}）`);
console.log(`库：${paths.learnerDb}`);
for (const c of counts) console.log(`  ${c.table.padEnd(16)} ${c.rows} 行`);

if (counts.every((c) => c.rows === 0)) {
  console.log("\n没有需要迁移的行（可能已经迁过）。");
  db.close();
  process.exit(0);
}

if (!APPLY) {
  console.log("\n这是 dry-run：确认无误后加 --apply 执行。");
  db.close();
  process.exit(0);
}

// 备份：只备份主文件；WAL 会一起合并进备份（先 checkpoint）
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const backup = resolve(paths.data, `learner.db.bak-${stamp}`);
db.exec("PRAGMA wal_checkpoint(FULL)");
copyFileSync(paths.learnerDb, backup);
console.log(`\n已备份到 ${backup}`);

db.exec("BEGIN");
try {
  /**
   * chapter_progress 有 UNIQUE(course_code, chapter_no)：
   * 两套进度同章号会撞车，必须按章号合并——保留"更靠后/更强的状态"，而不是整批改名。
   */
  const rank = (s: string): number => (s === "done" ? 2 : s === "learning" ? 1 : 0);
  const target = db
    .prepare("SELECT * FROM chapter_progress WHERE course_code = ?")
    .all(TO) as Array<Record<string, unknown>>;
  const byNo = new Map(target.map((r) => [Number(r.chapter_no), r]));
  let merged = 0;
  let moved = 0;
  const oldRows = db
    .prepare("SELECT * FROM chapter_progress WHERE course_code = ?")
    .all(FROM) as Array<Record<string, unknown>>;
  for (const o of oldRows) {
    const no = Number(o.chapter_no);
    const hit = byNo.get(no);
    if (!hit) {
      db.prepare("UPDATE chapter_progress SET course_code = ? WHERE id = ?").run(TO, Number(o.id));
      moved++;
      continue;
    }
    // 同章号：取更强的 status；标题缺的空位用旧的补
    const keepNew = rank(String(hit.status)) >= rank(String(o.status));
    db.prepare(
      "UPDATE chapter_progress SET status = ?, chapter_title = COALESCE(chapter_title, ?), updated_at = datetime('now') WHERE id = ?",
    ).run(
      keepNew ? String(hit.status) : String(o.status),
      (hit.chapter_title ?? o.chapter_title ?? null) as string | null,
      Number(hit.id),
    );
    db.prepare("DELETE FROM chapter_progress WHERE id = ?").run(Number(o.id));
    merged++;
  }
  console.log(`  chapter_progress 迁移 ${moved} 行、合并重复 ${merged} 行`);

  // habit 的唯一键是 (dimension,key,course_code,context)：同维度同 key 也要合并
  const habitKey = (r: Record<string, unknown>): string =>
    `${String(r.dimension)}|${String(r.key)}|${String(r.context ?? "")}`;
  const phyHabits = new Map(
    (
      db.prepare("SELECT * FROM habit WHERE course_code = ?").all(TO) as Array<
        Record<string, unknown>
      >
    ).map((r) => [habitKey(r), r]),
  );
  let hMoved = 0;
  let hMerged = 0;
  for (const o of db.prepare("SELECT * FROM habit WHERE course_code = ?").all(FROM) as Array<
    Record<string, unknown>
  >) {
    const hit = phyHabits.get(habitKey(o));
    if (!hit) {
      db.prepare("UPDATE habit SET course_code = ? WHERE id = ?").run(TO, Number(o.id));
      hMoved++;
      continue;
    }
    // 合并：自述优先，其次证据多的；保留 PHY 那一行
    const takeOld =
      (String(o.source) === "manual" && String(hit.source) !== "manual") ||
      Number(o.evidence_count ?? 0) > Number(hit.evidence_count ?? 0);
    db.prepare(
      "UPDATE habit SET value = ?, source = ?, confidence = ?, evidence_count = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(
      takeOld ? String(o.value) : String(hit.value),
      takeOld ? String(o.source) : String(hit.source),
      Math.max(Number(o.confidence ?? 0), Number(hit.confidence ?? 0)),
      Math.max(Number(o.evidence_count ?? 0), Number(hit.evidence_count ?? 0)),
      Number(hit.id),
    );
    db.prepare("DELETE FROM habit WHERE id = ?").run(Number(o.id));
    hMerged++;
  }
  console.log(`  habit 迁移 ${hMoved} 行、合并重复 ${hMerged} 行`);

  for (const t of TABLES) {
    if (t === "chapter_progress" || t === "habit") continue;
    if (!cols(t).has("course_code")) continue;
    const r = db.prepare(`UPDATE "${t}" SET course_code = ? WHERE course_code = ?`).run(TO, FROM);
    console.log(`  ${t.padEnd(16)} 更新 ${r.changes} 行`);
  }
  db.exec("COMMIT");
  console.log("\n迁移完成。");
} catch (e) {
  db.exec("ROLLBACK");
  console.error(`迁移失败，已回滚：${(e as Error).message}`);
  process.exitCode = 1;
}

// 迁移后自检：新科目下还剩多少行、章号范围
const left = db
  .prepare("SELECT COUNT(*) c FROM chapter_progress WHERE course_code = ?")
  .get(FROM) as {
  c: number;
};
const now = db
  .prepare(
    "SELECT COUNT(*) c, MIN(chapter_no) a, MAX(chapter_no) b FROM chapter_progress WHERE course_code = ?",
  )
  .get(TO) as { c: number; a: number | null; b: number | null };
console.log(
  `自检：${FROM} 剩余 ${left.c} 行；${TO} 现有 ${now.c} 行（章号 ${now.a ?? "-"}–${now.b ?? "-"}）`,
);
if (existsSync(backup)) console.log(`如需回滚：复制 ${backup} 覆盖 ${paths.learnerDb}`);
db.close();
