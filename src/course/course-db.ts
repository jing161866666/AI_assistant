import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { paths } from "../db/index.js";

/**
 * 建一个空的只读教材库（只有 course + meta，没有正文）。
 *
 * 用途：课表导入后，"这门课有身份、有库文件、但还没资料"。
 * 空库不会被检索误用（chunk 为 0），但科目可以立即绑定它，
 * 之后 build-course 建好真库时直接替换同一路径。
 */
export function textbookDbPath(code: string): string {
  return resolve(paths.textbook, `course-${code.toLowerCase()}.db`);
}

export interface EmptyCourseDb {
  file: string;
  created: boolean;
}

export function createEmptyTextbookDb(
  code: string,
  name: string,
  school = "",
  term = "",
): EmptyCourseDb {
  const out = textbookDbPath(code);
  const fileName = `course-${code.toLowerCase()}.db`;
  if (existsSync(out)) return { file: fileName, created: false };

  mkdirSync(paths.textbook, { recursive: true });
  const work = `${out}.building`;
  for (const suffix of ["", "-wal", "-shm"]) rmSync(work + suffix, { force: true });

  const db = new DatabaseSync(work);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(readFileSync(resolve(paths.schemaDir, "textbook.sql"), "utf8"));
    db.prepare("INSERT INTO course (code, name, school, term, description) VALUES (?,?,?,?,?)").run(
      code,
      name,
      school,
      term,
      "由课表导入自动建的空库，等待 build-course 填充资料",
    );
    const meta = db.prepare("INSERT INTO meta (key, value) VALUES (?,?)");
    meta.run("version", new Date().toISOString().slice(0, 16).replace("T", " "));
    meta.run("course_code", code);
    meta.run("chunk_count", "0");
    meta.run("builder", "empty");
  } finally {
    db.close();
  }
  for (const suffix of ["", "-wal", "-shm"]) rmSync(out + suffix, { force: true });
  renameSync(work, out);
  for (const suffix of ["-wal", "-shm"]) rmSync(work + suffix, { force: true });
  return { file: fileName, created: true };
}
