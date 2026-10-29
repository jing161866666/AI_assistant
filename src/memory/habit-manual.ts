import type { DatabaseSync } from "node:sqlite";
import { HABIT_DIMENSIONS, type HabitDimension } from "./habit-extract.js";
import { parseWindowKey } from "./study-window.js";

/**
 * 用户自己填的学习习惯 / 日程偏好。
 *
 * 与模型抽取的区别（必须分开）：
 * - 模型抽取：从行为里归纳，需要证据≥2 才算可信，写 source='model'
 * - 用户自述：他明确说了偏好，写 source='manual'、confidence=1，**一条就注入**
 *
 * 作用域规则（需求明确要求，别混）：
 * - course_code = NULL  → 个人共用习惯，所有界面、所有科目都能用
 * - course_code = 'DS'  → 只对数据结构成立（跟着该科目进度一起存）
 * 只有错题本 / 举一反三 / 进度这三个界面可以指定科目；
 * 其他界面写进来的默认是共用习惯，不许冒充某门课的习惯。
 */

export interface ManualHabitInput {
  dimension: HabitDimension;
  key: string;
  value: string;
  /** 作用域：科目代码；为空 = 个人共用 */
  course_code?: string | null;
  /** 补充场景：章节名 / 题型 / 星期几等 */
  context?: string | null;
}

export interface ManualHabitRow {
  id: number;
  dimension: string;
  key: string;
  value: string;
  course_code: string | null;
  context: string | null;
  confidence: number;
  evidence_count: number;
  source: string;
  status: string;
  updated_at: string;
}

const isDimension = (d: string): d is HabitDimension =>
  (HABIT_DIMENSIONS as readonly string[]).includes(d);

export function validateManualHabit(input: ManualHabitInput): string | null {
  if (!isDimension(input.dimension)) {
    return `未知维度：${input.dimension}（可用：${HABIT_DIMENSIONS.join(" / ")}）`;
  }
  if (!input.key.trim()) return "key 不能为空";
  if (!input.value.trim()) return "value 不能为空";
  if (input.key.length > 80 || input.value.length > 400) return "内容太长（key≤80，value≤400）";
  return null;
}

/**
 * 写入一条自述习惯。
 * 同一 (维度, key, 科目, 场景) 覆盖旧值——用户改主意时不该留两条互相矛盾的习惯。
 */
export function saveManualHabit(db: DatabaseSync, input: ManualHabitInput): number {
  const course = input.course_code?.trim() || null;
  const context = input.context?.trim() || null;

  const existing = db
    .prepare(
      `SELECT id FROM habit
       WHERE dimension = ? AND key = ?
         AND COALESCE(course_code,'') = COALESCE(?,'')
         AND COALESCE(context,'') = COALESCE(?,'')`,
    )
    .get(input.dimension, input.key.trim(), course, context) as { id: number } | undefined;

  let id: number;
  if (existing) {
    db.prepare(
      `UPDATE habit SET value=?, confidence=1, status='active', source='manual',
         updated_at=datetime('now') WHERE id=?`,
    ).run(input.value.trim(), existing.id);
    id = existing.id;
  } else {
    const r = db
      .prepare(
        `INSERT INTO habit
           (dimension, key, value, course_code, context, confidence, evidence_count, status, source)
         VALUES (?,?,?,?,?,1,1,'active','manual')`,
      )
      .run(input.dimension, input.key.trim(), input.value.trim(), course, context);
    id = Number(r.lastInsertRowid);
  }

  // 自述也要留证据，否则界面上"你凭什么这么认为"说不清
  db.prepare(
    `INSERT INTO habit_evidence (habit_id, source_type, source_id, snippet, weight)
     VALUES (?, 'user', NULL, ?, 1.0)`,
  ).run(id, `用户自述：${input.value.trim().slice(0, 120)}`);

  return id;
}

/** 自述习惯清单（界面用）：可按科目过滤，带出共用那部分 */
export function listManualHabits(db: DatabaseSync, course?: string | null): ManualHabitRow[] {
  if (course) {
    return db
      .prepare(
        `SELECT * FROM habit
         WHERE source = 'manual' AND status = 'active'
           AND (course_code IS NULL OR course_code = ?)
         ORDER BY course_code IS NULL, dimension, updated_at DESC`,
      )
      .all(course) as unknown as ManualHabitRow[];
  }
  return db
    .prepare(
      `SELECT * FROM habit
       WHERE source = 'manual' AND status = 'active'
       ORDER BY course_code IS NULL, dimension, updated_at DESC`,
    )
    .all() as unknown as ManualHabitRow[];
}

/** 删除一条自述习惯（用户填错了） */
export function deleteManualHabit(db: DatabaseSync, id: number): boolean {
  const row = db.prepare("SELECT source FROM habit WHERE id = ?").get(id) as
    | { source: string }
    | undefined;
  if (row?.source !== "manual") return false;
  db.prepare("DELETE FROM habit_evidence WHERE habit_id = ?").run(id);
  db.prepare("DELETE FROM habit WHERE id = ?").run(id);
  return true;
}

export interface ManualHabitPatch {
  dimension?: HabitDimension;
  key?: string;
  value?: string;
  /** 传 null 表示改成"个人共用" */
  course_code?: string | null;
  context?: string | null;
}

/**
 * 修改一条自述习惯（只有 source='manual' 能改）。
 *
 * 为什么不复用 saveManualHabit：那个按 (维度,key,科目,场景) 做覆盖，
 * 用户想改的恰恰可能是 key 本身（"21-24" 写成 "20-22"），按新 key 覆盖只会多出一条。
 * 这里按 id 改，并检查改名后不会与另一条撞键（撞了给出可读错误，不静默合并）。
 */
export function updateManualHabit(
  db: DatabaseSync,
  id: number,
  patch: ManualHabitPatch,
): ManualHabitRow {
  const row = db.prepare("SELECT * FROM habit WHERE id = ?").get(id) as ManualHabitRow | undefined;
  if (!row) throw new Error(`习惯 ${id} 不存在`);
  if (row.source !== "manual") {
    throw new Error("只能修改你自己填写的习惯；模型推断的可以「否决」");
  }

  const next: ManualHabitInput = {
    dimension: patch.dimension ?? (row.dimension as HabitDimension),
    key: patch.key === undefined ? row.key : patch.key.trim(),
    value: patch.value === undefined ? row.value : patch.value.trim(),
    course_code:
      patch.course_code === undefined ? row.course_code : patch.course_code?.trim() || null,
    context: patch.context === undefined ? row.context : patch.context?.trim() || null,
  };
  const bad = validateManualHabit(next);
  if (bad) throw new Error(bad);

  const dup = db
    .prepare(
      `SELECT id FROM habit
        WHERE id <> ? AND dimension = ? AND key = ?
          AND COALESCE(course_code,'') = COALESCE(?,'')
          AND COALESCE(context,'') = COALESCE(?,'')`,
    )
    .get(id, next.dimension, next.key, next.course_code ?? null, next.context ?? null) as
    | { id: number }
    | undefined;
  if (dup) {
    throw new Error(`已经有同维度同 key 的习惯（#${dup.id}），请直接改那一条`);
  }

  db.prepare(
    `UPDATE habit
        SET dimension = ?, key = ?, value = ?, course_code = ?, context = ?,
            confidence = 1, status = 'active', source = 'manual',
            updated_at = datetime('now')
      WHERE id = ?`,
  ).run(next.dimension, next.key, next.value, next.course_code ?? null, next.context ?? null, id);

  // 自述证据跟着改：界面上"你凭什么这么说我"要能对上新内容
  db.prepare("DELETE FROM habit_evidence WHERE habit_id = ? AND source_type = 'user'").run(id);
  db.prepare(
    `INSERT INTO habit_evidence (habit_id, source_type, source_id, snippet, weight)
     VALUES (?, 'user', NULL, ?, 1.0)`,
  ).run(id, `用户自述：${next.value.slice(0, 120)}`);

  return db.prepare("SELECT * FROM habit WHERE id = ?").get(id) as unknown as ManualHabitRow;
}

/** 偏好时段（日程排期要读它）：返回按开始时间排序的窗口 */
export interface StudyWindow {
  id: number;
  /** 形如 "20:00-22:00"，读不出来就是 null */
  start: string | null;
  end: string | null;
  /** 这个时段想做什么（学什么/怎么学） */
  what: string;
  course_code: string | null;
  source: string;
}

/**
 * 偏好时段清单。
 * - 传了 course：返回「该科目专属 + 个人共用」的时段；
 * - 不传：返回全部（含各科目专属），界面据此显示「仅 XX」，不隐藏只看得到共用的假象。
 */
export function listStudyWindows(db: DatabaseSync, course?: string | null): StudyWindow[] {
  const only = course?.trim().toUpperCase() || null;
  const rows = db
    .prepare(
      `SELECT id, key, value, course_code, source FROM habit
       WHERE dimension IN ('study_window','study_time') AND status='active'
         ${only ? "AND (course_code IS NULL OR UPPER(course_code) = ?)" : ""}
       ORDER BY key`,
    )
    .all(...(only ? [only] : [])) as unknown as Array<{
    id: number;
    key: string;
    value: string;
    course_code: string | null;
    source: string;
  }>;

  // key 的写法交给 parseWindowKey 归一化：全角冒号、时段:21-24、21点-23点 都能认
  return rows.map((r) => {
    const w = parseWindowKey(r.key);
    return {
      id: r.id,
      start: w?.start ?? null,
      end: w?.end ?? null,
      what: r.value,
      course_code: r.course_code,
      source: r.source,
    };
  });
}
