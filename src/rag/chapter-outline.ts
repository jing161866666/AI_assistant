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
  /** 合并用户改名后的名称：界面与模型都用这个 */
  title: string;
  /** 教材库里的原名；「恢复原名」用 */
  libraryTitle: string;
  /** 是否被用户改过名 */
  edited: boolean;
  /** 该章抽取的代表性术语，帮助模型对齐方法名，取切片开头若干字 */
  sample: string;
}

/**
 * 把用户改的章名合进章节表。
 * 只改 title，不动章号与 sample：门控靠章号，名称只影响模型对"这方法属于哪章"的判断。
 */
export function applyChapterNames(
  items: ChapterOutlineItem[],
  names: Map<number, string>,
): ChapterOutlineItem[] {
  if (names.size === 0) return items;
  return items.map((i) => {
    const title = names.get(i.chapterNo);
    return title ? { ...i, title, edited: true } : i;
  });
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
    libraryTitle: r.title,
    edited: false,
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
