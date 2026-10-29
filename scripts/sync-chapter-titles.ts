import "dotenv/config";
import { readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const { getLearnerDb } = await import("../src/db/index.js");
const db = getLearnerDb();

type CourseRow = {
  code: string;
};
type ChapterRow = {
  chapter_no: number;
  title: string | null;
};
type ProgressRow = {
  id: number;
  course_code: string;
  chapter_no: number;
  chapter_title: string | null;
};

// 1) 从各教材库读出 course_code -> {章号: 章名}
const kb = new Map<string, Map<number, string>>();
for (const f of readdirSync("data/textbook").filter((x) => x.endsWith(".db"))) {
  try {
    const t = new DatabaseSync(`data/textbook/${f}`, { readOnly: true });
    const code = (t.prepare("SELECT code FROM course LIMIT 1").get() as CourseRow | undefined)
      ?.code;
    if (!code) {
      t.close();
      continue;
    }
    const m = new Map<number, string>();
    for (const r of t
      .prepare("SELECT chapter_no, title FROM chapter WHERE chapter_no IS NOT NULL")
      .all() as ChapterRow[]) {
      m.set(Number(r.chapter_no), String(r.title ?? "").trim());
    }
    kb.set(code, m);
    t.close();
  } catch {
    /* 坏库跳过 */
  }
}
// 2) 回填 chapter_progress.chapter_title
let updated = 0,
  missing = 0;
const rows = db
  .prepare("SELECT id, course_code, chapter_no, chapter_title FROM chapter_progress")
  .all() as ProgressRow[];
const upd = db.prepare(
  "UPDATE chapter_progress SET chapter_title = ?, updated_at = datetime('now') WHERE id = ?",
);
for (const r of rows) {
  const title = kb.get(String(r.course_code))?.get(Number(r.chapter_no));
  if (!title) {
    missing++;
    continue;
  }
  if (r.chapter_title !== title) {
    upd.run(title, r.id);
    updated++;
  }
}
console.log(`SYNC rows=${rows.length} updated=${updated} noTitleInKb=${missing}`);
for (const r of db
  .prepare(
    "SELECT course_code, chapter_no, chapter_title FROM chapter_progress ORDER BY course_code, chapter_no LIMIT 20",
  )
  .all() as Array<Pick<ProgressRow, "course_code" | "chapter_no" | "chapter_title">>) {
  console.log(`  ${r.course_code} 第${r.chapter_no}章 ${r.chapter_title ?? "(无名称)"}`);
}
db.close();
// 3) 知识库里所有章节都写进 chapter_progress（没学到的也建行，状态 not_started）
let inserted = 0;
const ins = db.prepare(
  "INSERT INTO chapter_progress (course_code, chapter_no, chapter_title, status, confidence, source, evidence, updated_at) VALUES (?,?,?,'not_started',1,'kb','来自知识库章节表',datetime('now')) ON CONFLICT(course_code, chapter_no) DO UPDATE SET chapter_title = excluded.chapter_title",
);
for (const [code, chapters] of kb) {
  for (const [no, title] of chapters) {
    if (!title) continue;
    const r = ins.run(code, no, title);
    if (r.changes > 0) inserted++;
  }
}
console.log(`SEED inserted=${inserted}`);
