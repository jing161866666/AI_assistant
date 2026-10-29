import "dotenv/config";
import { readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/**
 * 把知识库里的**所有章节**写进 chapter_progress（没学到的也建行，状态 not_started）。
 *
 * 为什么需要：进度页只渲染 chapter_progress 里存在的章，没学到的章就不会显示章节名。
 * 这里用知识库的 chapter 表当唯一来源，标题和章号都照抄，不编内容。
 */
const { getLearnerDb } = await import("../src/db/index.js");
const db = getLearnerDb();

type KbChapter = { no: number; title: string };
const kb = new Map<string, KbChapter[]>();
for (const f of readdirSync("data/textbook").filter((x) => x.endsWith(".db"))) {
  try {
    const t = new DatabaseSync(`data/textbook/${f}`, { readOnly: true });
    const code = (t.prepare("SELECT code FROM course LIMIT 1").get() as { code?: string })?.code;
    if (code) {
      const rows = t
        .prepare(
          "SELECT chapter_no, title FROM chapter WHERE chapter_no IS NOT NULL ORDER BY chapter_no",
        )
        .all() as Array<{ chapter_no: number; title: string | null }>;
      kb.set(
        String(code),
        rows
          .map((r) => ({ no: Number(r.chapter_no), title: String(r.title ?? "").trim() }))
          .filter((r) => r.title.length > 0),
      );
    }
    t.close();
  } catch {
    /* 坏库跳过，不影响其它科目 */
  }
}

const upsert = db.prepare(
  `INSERT INTO chapter_progress
     (course_code, chapter_no, chapter_title, status, confidence, source, evidence, updated_at)
   VALUES (?,?,?,'not_started',1,'kb','来自知识库章节表', datetime('now'))
   ON CONFLICT(course_code, chapter_no) DO UPDATE SET
     chapter_title = excluded.chapter_title`,
);

let inserted = 0;
let existing = 0;
for (const [code, chapters] of kb) {
  for (const ch of chapters) {
    const before = db
      .prepare("SELECT id FROM chapter_progress WHERE course_code = ? AND chapter_no = ?")
      .get(code, ch.no);
    upsert.run(code, ch.no, ch.title);
    if (before) existing++;
    else inserted++;
  }
}

const summary = db
  .prepare(
    `SELECT course_code, COUNT(*) n, SUM(CASE WHEN status != 'not_started' THEN 1 ELSE 0 END) learned
       FROM chapter_progress GROUP BY course_code ORDER BY course_code`,
  )
  .all() as Array<{ course_code: string; n: number; learned: number | null }>;

console.log(`SEED inserted=${inserted} already=${existing}`);
for (const s of summary)
  console.log(`  ${s.course_code}: ${s.n} 章（已学/在学 ${s.learned ?? 0}）`);
db.close();
