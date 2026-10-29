import type { DatabaseSync } from "node:sqlite";

/**
 * 课程资源：用户正在看的网课、在用的教辅书（需求 3）。
 *
 * 为什么要单独一张表而不是塞进 habit：
 * 资源是有 URL、有"本地有没有"、有"看到第几讲"的对象，
 * 用 key/value 存储会把这三件事糊成一句话，排期时用不上。
 *
 * local_status 的三种状态对应需求里的处理顺序：
 *   available —— 本地/网站已有，直接用
 *   missing   —— 没有，请求用户上传（当前先标记，上传流程预留）
 *   uploaded  —— 用户已上传（落 artifact 表）
 */

export const RESOURCE_KINDS = ["netcourse", "guidebook", "textbook", "other"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export const RESOURCE_KIND_LABEL: Record<string, string> = {
  netcourse: "网课",
  guidebook: "教辅书",
  textbook: "教材",
  other: "其它",
};

export const LOCAL_STATUS = ["available", "missing", "uploaded", "unknown"] as const;
export type LocalStatus = (typeof LOCAL_STATUS)[number];

export const LOCAL_STATUS_LABEL: Record<string, string> = {
  available: "本地/线上已有",
  missing: "缺，待上传",
  uploaded: "已上传",
  unknown: "不确定",
};

export interface ResourceInput {
  course_code?: string | null;
  kind: ResourceKind;
  title: string;
  url?: string | null;
  local_status?: LocalStatus;
  /** 0-1：看到第几讲 / 用到哪一章 */
  progress?: number | null;
  note?: string | null;
}

export interface ResourceRow {
  id: number;
  course_code: string | null;
  kind: string;
  title: string;
  url: string | null;
  local_status: string;
  progress: number | null;
  note: string | null;
  source: string;
  created_at: string;
  updated_at: string | null;
}

export function validateResource(input: ResourceInput): string | null {
  if (!(RESOURCE_KINDS as readonly string[]).includes(input.kind)) {
    return `未知资源类型：${input.kind}（可用：${RESOURCE_KINDS.join(" / ")}）`;
  }
  if (!input.title?.trim()) return "title 不能为空";
  if (input.title.length > 200) return "title 太长（≤200）";
  if (input.url && !/^https?:\/\//i.test(input.url)) return "url 必须以 http(s):// 开头";
  const p = input.progress;
  if (p != null && (!Number.isFinite(p) || p < 0 || p > 1)) return "progress 必须是 0-1";
  if (input.local_status && !(LOCAL_STATUS as readonly string[]).includes(input.local_status)) {
    return `未知 local_status：${input.local_status}`;
  }
  return null;
}

/** 新增/更新一条资源（同科目+类型+标题视为同一条） */
export function upsertResource(db: DatabaseSync, input: ResourceInput): number {
  const course = input.course_code?.trim() || null;
  const title = input.title.trim();
  const existing = db
    .prepare(
      `SELECT id FROM course_resource
       WHERE kind = ? AND title = ? AND COALESCE(course_code,'') = COALESCE(?,'')`,
    )
    .get(input.kind, title, course) as { id: number } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE course_resource SET
         url = COALESCE(?, url),
         local_status = COALESCE(?, local_status),
         progress = COALESCE(?, progress),
         note = COALESCE(?, note),
         updated_at = datetime('now')
       WHERE id = ?`,
    ).run(
      input.url?.trim() || null,
      input.local_status ?? null,
      input.progress ?? null,
      input.note?.trim() || null,
      existing.id,
    );
    return existing.id;
  }

  const r = db
    .prepare(
      `INSERT INTO course_resource
         (course_code, kind, title, url, local_status, progress, note, source)
       VALUES (?,?,?,?,?,?,?,'user')`,
    )
    .run(
      course,
      input.kind,
      title,
      input.url?.trim() || null,
      input.local_status ?? "unknown",
      input.progress ?? null,
      input.note?.trim() || null,
    );
  return Number(r.lastInsertRowid);
}

/** 资源清单：指定科目时带上通识资源（course_code IS NULL） */
export function listResources(db: DatabaseSync, course?: string | null): ResourceRow[] {
  if (course) {
    return db
      .prepare(
        `SELECT * FROM course_resource
         WHERE course_code IS NULL OR course_code = ?
         ORDER BY course_code IS NULL, kind, title`,
      )
      .all(course) as unknown as ResourceRow[];
  }
  return db
    .prepare("SELECT * FROM course_resource ORDER BY course_code IS NULL, kind, title")
    .all() as unknown as ResourceRow[];
}

export function deleteResource(db: DatabaseSync, id: number): boolean {
  return db.prepare("DELETE FROM course_resource WHERE id = ?").run(id).changes > 0;
}

/**
 * 缺资源提醒：哪些课的学习资源还没到位。
 * 需求 3 的处理顺序是"本地有就先用，没有就请求用户上传"，这里给出后者名单。
 */
export function missingResources(db: DatabaseSync, course?: string | null): ResourceRow[] {
  return listResources(db, course).filter((r) => r.local_status === "missing");
}
