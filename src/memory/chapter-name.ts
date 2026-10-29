import type { DatabaseSync } from "node:sqlite";

/**
 * 章节名称的用户覆盖层。
 *
 * 教材库是只读、全校共享的，学生改名不能写回 textbook.db：
 *  - 一个学生的叫法不该影响别人；
 *  - 教材库换版本时覆盖要能保留；
 * 所以覆盖放 learner.db，读取时与教材库章节表合并后再给界面和模型。
 *
 * 为什么要让用户改名：教材里的章名常是编者口径（「第 4 章 静电场」），
 * 而学生/老师平时说的是约定俗成的叫法（「电场强度与电势」）。
 * 越界检查靠章节名对齐方法归属，名称越贴近习惯，模型越不容易把方法挂错章。
 */

export interface ChapterNameRow {
  course_code: string;
  chapter_no: number;
  title: string;
  source: string;
  updated_at: string;
}

/** 去掉「第9章」「第九章：」这类前缀，只留真正的章名 */
export function normalizeChapterTitle(raw: unknown): string {
  const s = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  const stripped = s
    .replace(/^第\s*[0-9一二两三四五六七八九十百]+\s*章\s*[：:、.．-]?\s*/, "")
    .replace(/^[：:、.．-]\s*/, "")
    .trim();
  const title = stripped || s;
  if (title.length > 60) throw new Error("章节名称最多 60 字");
  return title;
}

/** 某科目的全部改名；键是章号 */
export function listChapterNames(db: DatabaseSync, courseCode: string): Map<number, string> {
  const rows = db
    .prepare("SELECT chapter_no, title FROM chapter_name WHERE course_code = ? ORDER BY chapter_no")
    .all(courseCode.trim().toUpperCase()) as unknown as Array<{
    chapter_no: number;
    title: string;
  }>;
  return new Map(rows.map((r) => [Number(r.chapter_no), r.title]));
}

/** 写入/覆盖一个章名；标题为空等价于删除（恢复教材原名） */
export function setChapterName(
  db: DatabaseSync,
  courseCode: string,
  chapterNo: number,
  rawTitle: unknown,
): string | null {
  const course = courseCode.trim().toUpperCase();
  if (!Number.isInteger(chapterNo) || chapterNo < 1 || chapterNo > 40) {
    throw new Error("chapterNo 必须是 1-40 的整数");
  }
  const title = normalizeChapterTitle(rawTitle);
  if (!title) {
    clearChapterName(db, course, chapterNo);
    return null;
  }

  const prev = db
    .prepare("SELECT title FROM chapter_name WHERE course_code = ? AND chapter_no = ?")
    .get(course, chapterNo) as { title: string } | undefined;
  db.prepare(
    `INSERT INTO chapter_name (course_code, chapter_no, title, source, updated_at)
     VALUES (?,?,?, 'user', datetime('now'))
     ON CONFLICT(course_code, chapter_no) DO UPDATE SET
       title = excluded.title, source = excluded.source, updated_at = excluded.updated_at`,
  ).run(course, chapterNo, title);
  db.prepare("INSERT INTO event (type, ref_type, payload) VALUES (?,?,?)").run(
    "chapter_renamed",
    "chapter_name",
    JSON.stringify({
      course,
      chapterNo,
      title,
      previous: prev?.title ?? null,
    }),
  );
  return title;
}

/** 删除覆盖，恢复教材库里的原名；返回是否真的删掉了 */
export function clearChapterName(db: DatabaseSync, courseCode: string, chapterNo: number): boolean {
  const course = courseCode.trim().toUpperCase();
  const prev = db
    .prepare("SELECT title FROM chapter_name WHERE course_code = ? AND chapter_no = ?")
    .get(course, chapterNo) as { title: string } | undefined;
  if (!prev) return false;
  db.prepare("DELETE FROM chapter_name WHERE course_code = ? AND chapter_no = ?").run(
    course,
    chapterNo,
  );
  db.prepare("INSERT INTO event (type, ref_type, payload) VALUES (?,?,?)").run(
    "chapter_name_cleared",
    "chapter_name",
    JSON.stringify({ course, chapterNo, previous: prev.title }),
  );
  return true;
}
