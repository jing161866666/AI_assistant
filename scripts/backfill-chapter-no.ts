import "dotenv/config";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { paths } from "../src/db/index.js";

/**
 * 一次性补列：给已有教材库加 chapter.chapter_no 并回填。
 *
 * 为什么不用 build:textbook 重建：那要重跑约 1500 次 embedding（几分钟），
 * 而且会重建整库、冲掉并行的题库功能可能依赖的数据。
 * 这里只 ALTER + UPDATE，几毫秒完成，数据不动。
 */

const COURSE = process.env.COURSE_CODE ?? "PHY2";
const FILE = resolve(paths.textbook, `course-${COURSE.toLowerCase()}.db`);

mkdirSync(dirname(FILE), { recursive: true });
const db = new DatabaseSync(FILE);
db.exec("PRAGMA journal_mode = WAL");

const cols = (db.prepare("PRAGMA table_info(chapter)").all() as Array<{ name: string }>).map(
  (r) => r.name,
);

if (!cols.includes("chapter_no")) {
  db.exec("ALTER TABLE chapter ADD COLUMN chapter_no INTEGER");
  console.log("已添加 chapter_no 列");
} else {
  console.log("chapter_no 已存在");
}

// 只给"课件/讲义"类回填章节号；题库类是练习题，不参与进度门控，保持 NULL
const r1 = db
  .prepare(
    `UPDATE chapter
       SET chapter_no = CAST(REPLACE(REPLACE(title, '第', ''), '章', '') AS INTEGER)
     WHERE chapter_no IS NULL
       AND title GLOB '第*章'
       AND textbook_id IN (SELECT id FROM textbook WHERE title NOT LIKE '%题库%')`,
  )
  .run();
console.log(`回填 ${Number(r1.changes)} 行`);

const rows = db
  .prepare(
    `SELECT ch.chapter_no AS no, ch.title AS title, tb.title AS book,
            (SELECT COUNT(*) FROM chunk c WHERE c.chapter_id = ch.id) AS n
     FROM chapter ch LEFT JOIN textbook tb ON tb.id = ch.textbook_id
     ORDER BY ch.chapter_no IS NULL, ch.chapter_no, ch.id`,
  )
  .all() as unknown as Array<{ no: number | null; title: string; book: string; n: number }>;

console.log("\n章节现状：");
for (const r of rows) {
  console.log(
    `  ${r.no == null ? "  —" : String(r.no).padStart(3)}  ${r.title.padEnd(28)} ${String(r.n).padStart(4)} 片  [${r.book}]`,
  );
}

const mapped = rows.filter((r) => r.no != null).length;
console.log(`\n可参与门控的章节 ${mapped} 个，不参与 ${rows.length - mapped} 个（题库）`);
db.close();
