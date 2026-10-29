import "dotenv/config";
import { readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/** 一次性维护脚本：删掉「教材库里已不存在」的章节进度行（换库/重建后清理残留） */

const { getLearnerDb } = await import("../src/db/index.js");
const db = getLearnerDb();

type CourseRow = {
  code: string;
};
type ChapterRow = {
  chapter_no: number;
};
type ProgressRow = {
  id: number;
  course_code: string;
  chapter_no: number;
};
type CountRow = {
  course_code: string;
  n: number;
};

const kb = new Map<string, Set<number>>();
for (const f of readdirSync("data/textbook").filter((x) => x.endsWith(".db"))) {
  try {
    const t = new DatabaseSync(`data/textbook/${f}`, { readOnly: true });
    const code = (t.prepare("SELECT code FROM course LIMIT 1").get() as CourseRow | undefined)
      ?.code;
    if (code)
      kb.set(
        String(code),
        new Set(
          (
            t
              .prepare("SELECT chapter_no FROM chapter WHERE chapter_no IS NOT NULL")
              .all() as ChapterRow[]
          ).map((r) => Number(r.chapter_no)),
        ),
      );
    t.close();
  } catch {
    /* 坏库跳过 */
  }
}

let del = 0;
for (const r of db
  .prepare("SELECT id, course_code, chapter_no FROM chapter_progress")
  .all() as ProgressRow[]) {
  const set = kb.get(String(r.course_code));
  if (!set) continue; // 没有知识库的科目先不动
  if (!set.has(Number(r.chapter_no))) {
    db.prepare("DELETE FROM chapter_progress WHERE id = ?").run(r.id);
    del++;
  }
}

console.log(`DELETE_STALE=${del}`);
for (const s of db
  .prepare(
    "SELECT course_code, COUNT(*) n FROM chapter_progress GROUP BY course_code ORDER BY course_code",
  )
  .all() as CountRow[])
  console.log(`  ${s.course_code}: ${s.n}`);
db.close();
