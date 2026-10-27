import type { DatabaseSync } from "node:sqlite";
import { openTextbookDb } from "../db/index.js";

/**
 * 从教材库读出真实章节表。
 *
 * 用途：越界检查必须知道"这个方法是第几章的"，而这个归属属于**先验知识**，
 * 不能让模型凭空猜——实测它会把握差章节（把"光程差"猜成第 12 章）。
 */

export interface ChapterOutlineItem {
  chapterNo: number;
  title: string;
  /** 该章抽取的代表性术语，帮助模型对齐方法名，取切片开头若干字 */
  sample: string;
}

export function listChapterOutline(file: string): ChapterOutlineItem[] {
  let db: DatabaseSync;
  try {
    db = openTextbookDb(file);
  } catch {
    return [];
  }
  const rows = db
    .prepare(
      `SELECT ch.chapter_no AS no, ch.title AS title,
              (SELECT GROUP_CONCAT(SUBSTR(c.text, 1, 60), ' / ')
               FROM (SELECT text FROM chunk WHERE chapter_id = ch.id ORDER BY seq LIMIT 3) c) AS sample
       FROM chapter ch
       WHERE ch.chapter_no IS NOT NULL
       ORDER BY ch.chapter_no`,
    )
    .all() as unknown as Array<{ no: number; title: string; sample: string | null }>;

  return rows.map((r) => ({
    chapterNo: r.no,
    title: r.title,
    sample: (r.sample ?? "").replace(/\s+/g, " ").slice(0, 160),
  }));
}

/** 压缩成提示词里的章节表 */
export function outlinePrompt(items: ChapterOutlineItem[]): string {
  if (items.length === 0) return "";
  return items
    .map((i) => `第${i.chapterNo}章 ${i.title}${i.sample ? `｜例：${i.sample}` : ""}`)
    .join("\n");
}
