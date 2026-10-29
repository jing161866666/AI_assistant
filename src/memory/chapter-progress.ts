import type { DatabaseSync } from "node:sqlite";

/**
 * 章节进度：连续过程学习的真相来源。
 *
 * 与 `progress`（知识点掌握度，离散、由做题推断）的分工：
 *   本表回答"学到第几章"，门控检索只认本表。
 *   未学章节的教材正文不进上下文，模型见不到，就用不出来——
 *   这比在提示词里写"不要用泰勒公式"可靠得多。
 */

export type ChapterStatus = "not_started" | "learning" | "done";

export interface ChapterProgress {
  id: number;
  course_code: string;
  chapter_no: number;
  chapter_title: string | null;
  status: ChapterStatus;
  confidence: number;
  source: string;
  evidence: string | null;
  updated_at: string;
}

export function listChapterProgress(db: DatabaseSync, courseCode: string): ChapterProgress[] {
  return db
    .prepare("SELECT * FROM chapter_progress WHERE course_code = ? ORDER BY chapter_no")
    .all(courseCode) as unknown as ChapterProgress[];
}

/**
 * 清空一门课的章节进度：整行删除，而不是逐章写 not_started。
 *
 * 逐章写会留下 1..40 的空行，界面上就成了"默认 34/40 章"——
 * 用户点一次清空，反而凭空多出一堆不存在的章节。
 * 这里直接删掉该科目的全部行；event 只记一条，可追溯。
 */
export function clearChapterProgress(db: DatabaseSync, courseCode: string): number {
  const r = db.prepare("DELETE FROM chapter_progress WHERE course_code = ?").run(courseCode);
  db.prepare("INSERT INTO event (type, ref_type, payload) VALUES (?,?,?)").run(
    "progress_cleared",
    "chapter_progress",
    JSON.stringify({ course: courseCode, removed: Number(r.changes) }),
  );
  return Number(r.changes);
}

export interface SetProgressInput {
  courseCode: string;
  chapterNo: number;
  chapterTitle?: string | null;
  status: ChapterStatus;
  source?: string;
  evidence?: string | null;
  confidence?: number;
}

export function setChapterProgress(db: DatabaseSync, input: SetProgressInput): void {
  // 同课程只允许一条 learning（M2.md 约束）：置 learning 前先把别的 learning 降为 done
  if (input.status === "learning") {
    db.prepare(
      `UPDATE chapter_progress SET status = 'done', updated_at = datetime('now')
       WHERE course_code = ? AND status = 'learning' AND chapter_no != ?`,
    ).run(input.courseCode, input.chapterNo);
  }
  db.prepare(
    `INSERT INTO chapter_progress
       (course_code, chapter_no, chapter_title, status, confidence, source, evidence, updated_at)
     VALUES (?,?,?,?,?,?,?, datetime('now'))
     ON CONFLICT(course_code, chapter_no) DO UPDATE SET
       chapter_title = COALESCE(excluded.chapter_title, chapter_progress.chapter_title),
       status        = excluded.status,
       confidence    = excluded.confidence,
       source        = excluded.source,
       evidence      = excluded.evidence,
       updated_at    = datetime('now')`,
  ).run(
    input.courseCode,
    input.chapterNo,
    input.chapterTitle ?? null,
    input.status,
    input.confidence ?? 0.8,
    input.source ?? "manual",
    input.evidence ?? null,
  );
}

/**
 * 一次性把进度推进到第 N 章。
 * 语义：「学到第 N 章」= 前 N-1 章已学完，第 N 章正在学。
 * 这样画像能说清"当前在哪一章"，而不只是"上限是几"。
 */
export function advanceTo(db: DatabaseSync, courseCode: string, chapterNo: number): void {
  for (let n = 1; n <= chapterNo; n++) {
    setChapterProgress(db, {
      courseCode,
      chapterNo: n,
      status: n < chapterNo ? "done" : "learning",
      source: "manual",
      evidence: `用户确认学到第 ${chapterNo} 章`,
      confidence: 1,
    });
  }
  // N 之后的章节若曾被标成已学，一并回退，避免上限与实际不一致
  db.prepare(
    `UPDATE chapter_progress SET status = 'not_started', updated_at = datetime('now')
     WHERE course_code = ? AND chapter_no > ? AND status != 'not_started'`,
  ).run(courseCode, chapterNo);
}

/**
 * 门控用的上限：已学章节的最大编号。
 * 返回 null 表示"尚未设置进度"——此时不应静默放行，由调用方决定策略。
 */
export function maxLearnedChapter(db: DatabaseSync, courseCode: string): number | null {
  const r = db
    .prepare(
      `SELECT MAX(chapter_no) AS m FROM chapter_progress
       WHERE course_code = ? AND status IN ('learning','done')`,
    )
    .get(courseCode) as { m: number | null } | undefined;
  return r?.m ?? null;
}

/** 已学章节集合（用于画像描述与越界判定） */
export function learnedChapterSet(db: DatabaseSync, courseCode: string): Set<number> {
  const rows = db
    .prepare(
      `SELECT chapter_no FROM chapter_progress
       WHERE course_code = ? AND status IN ('learning','done')`,
    )
    .all(courseCode) as unknown as Array<{ chapter_no: number }>;
  return new Set(rows.map((r) => r.chapter_no));
}

/** 记录一次进度推断（来自对话或做题），走 event 追加 + 结论表重算的约定 */
export function recordProgressEvidence(
  db: DatabaseSync,
  courseCode: string,
  chapterNo: number,
  source: string,
  evidence: string,
): void {
  db.prepare("INSERT INTO event (type, ref_type, payload) VALUES (?,?,?)").run(
    "progress_inferred",
    "chapter_progress",
    JSON.stringify({ course: courseCode, chapter: chapterNo, source, evidence }),
  );
}
