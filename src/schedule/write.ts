import type { DatabaseSync } from "node:sqlite";
import {
  busyIntervalsOf,
  expandOccurrences,
  getActiveTerm,
  getSchedule,
  insertSchedule,
  isRealDate,
  type NewScheduleInput,
  readStudyLimits,
  type ScheduleValues,
  toMin,
  validateScheduleValues,
} from "./service.js";
import type { Category, Flexibility, Parity, ScheduleRow } from "./types.js";

/**
 * 日程的写入口（用户手动增删改 + 模型工具共用）。
 *
 * 按 ARCHITECTURE 的分工：`service.ts` 只放纯函数与只读查询，写库放这一层。
 * 这里只做"确定性"的事：格式校验、周次边界、一次性/每周互斥归一。
 * 用户想加什么、怎么命名，属于用户的判断，代码不替他决定。
 *
 * `locked` 的语义：
 *   用户在界面上改过 → locked=1，模型后续不得覆盖；
 *   模型自己加的 → locked=0，用户仍可自由编辑。
 */

/** 默认值 + 入参拼成完整的一行，供校验和写入共用 */
function toValues(input: NewScheduleInput): ScheduleValues {
  const recurring = input.recurring ?? (input.weekday != null ? 1 : 0);
  return {
    title: (input.title ?? "").trim(),
    type: input.type ?? "other",
    category: (input.category ?? "life") as Category,
    source: input.source ?? "manual",
    course_code: input.course_code ?? null,
    teacher: input.teacher ?? null,
    weekday: input.weekday ?? null,
    date: input.date ?? null,
    start_time: input.start_time,
    end_time: input.end_time,
    location: input.location ?? null,
    recurring,
    week_start: input.week_start ?? 1,
    week_end: input.week_end ?? 1,
    week_parity: (input.week_parity ?? "all") as Parity,
    flexibility: (input.flexibility ?? 0) as Flexibility,
    intent: input.intent ?? null,
    energy: input.energy ?? null,
    locked: input.locked ?? 1,
    priority: input.priority ?? 0,
  };
}

/** 带校验的新增：失败时抛错（HTTP 层转 400），成功返回新 id */
export function createSchedule(db: DatabaseSync, input: NewScheduleInput): number {
  const term = getActiveTerm(db);
  const recurring = input.recurring ?? (input.weekday != null ? 1 : 0);
  const values = toValues({
    ...input,
    recurring,
    week_start: input.week_start ?? 1,
    // 每周重复默认覆盖整学期；一次性日程周次无意义
    week_end: input.week_end ?? (recurring ? term.total_weeks : 1),
  });
  if (recurring && values.weekday != null) values.date = null;
  if (!recurring) {
    // 一次性日程的周次没有意义，统一归一，免得前端表单显示 1~16 误导
    values.weekday = null;
    values.week_start = 1;
    values.week_end = 1;
  }
  const errs = validateScheduleValues(values, term.total_weeks);
  if (errs.length > 0) throw new Error(errs.join("；"));
  return insertSchedule(db, values);
}

/** 带校验的修改：patch 只需给要改的字段，其余沿用原值 */
export function updateSchedule(
  db: DatabaseSync,
  id: number,
  patch: Partial<NewScheduleInput>,
): ScheduleRow {
  const cur = getSchedule(db, id);
  if (!cur) throw new Error(`不存在 id=${id} 的日程`);
  const term = getActiveTerm(db);
  const merged = toValues({
    title: patch.title ?? cur.title,
    type: patch.type ?? cur.type,
    category: patch.category ?? cur.category,
    source: patch.source ?? cur.source,
    course_code: patch.course_code === undefined ? cur.course_code : patch.course_code,
    teacher: patch.teacher === undefined ? cur.teacher : patch.teacher,
    weekday: patch.weekday === undefined ? cur.weekday : patch.weekday,
    date: patch.date === undefined ? cur.date : patch.date,
    start_time: patch.start_time ?? cur.start_time ?? "",
    end_time: patch.end_time ?? cur.end_time ?? "",
    location: patch.location === undefined ? cur.location : patch.location,
    recurring: patch.recurring ?? cur.recurring,
    week_start: patch.week_start ?? cur.week_start,
    week_end: patch.week_end ?? cur.week_end,
    week_parity: patch.week_parity ?? cur.week_parity,
    flexibility: patch.flexibility ?? cur.flexibility,
    intent: patch.intent === undefined ? cur.intent : patch.intent,
    energy: patch.energy === undefined ? cur.energy : patch.energy,
    // 用户手改过 → 锁定，模型后续不得覆盖
    locked: patch.locked ?? 1,
    priority: patch.priority ?? cur.priority,
  });
  // 从"一次性"改成"每周"时，旧日期会残留；反之旧星期几会残留，二者互斥
  if (merged.recurring) {
    merged.date = null;
  } else {
    merged.weekday = null;
    // 一次性日程的周次没有意义
    merged.week_start = 1;
    merged.week_end = 1;
  }

  const errs = validateScheduleValues(merged, term.total_weeks);
  if (errs.length > 0) throw new Error(errs.join("；"));

  db.prepare(
    `UPDATE schedule SET
       title = ?, type = ?, category = ?, source = ?, course_code = ?, teacher = ?,
       weekday = ?, date = ?, start_time = ?, end_time = ?, location = ?,
       recurring = ?, week_start = ?, week_end = ?, week_parity = ?,
       flexibility = ?, intent = ?, energy = ?, locked = ?, priority = ?
     WHERE id = ?`,
  ).run(
    merged.title,
    merged.type,
    merged.category,
    merged.source,
    merged.course_code,
    merged.teacher,
    merged.weekday,
    merged.date,
    merged.start_time,
    merged.end_time,
    merged.location,
    merged.recurring,
    merged.week_start,
    merged.week_end,
    merged.week_parity,
    merged.flexibility,
    merged.intent,
    merged.energy,
    merged.locked,
    merged.priority,
    id,
  );
  return getSchedule(db, id)!;
}

/**
 * 删除一条日程。
 * requireUnlocked=true 是给模型用的（用户的锁定行要先问）；
 * UI 调用时不传，用户点了就是用户本人的决定。
 * schedule_exception 有 ON DELETE CASCADE，例外会一起清掉。
 */
export function deleteSchedule(
  db: DatabaseSync,
  id: number,
  opts: { requireUnlocked?: boolean } = {},
): boolean {
  const row = getSchedule(db, id);
  if (!row) return false;
  if (opts.requireUnlocked && row.locked) return false;
  const r = db.prepare("DELETE FROM schedule WHERE id = ?").run(id);
  return Number(r.changes) > 0;
}

/**
 * 「可被学习计划占用」的日程（flexibility = 2）。
 *
 * 这类块是**容器**不是安排：排期写进来的学习计划、用户留的空白意愿块都算。
 * 批量清空只清这一档，正课(0)、可微调(1)一律不动——那是用户真实的时间。
 */
export function listOccupiable(db: DatabaseSync): ScheduleRow[] {
  return db
    .prepare(
      `SELECT * FROM schedule WHERE flexibility = 2
       ORDER BY COALESCE(date, ''), weekday, start_time`,
    )
    .all() as unknown as ScheduleRow[];
}

/**
 * 批量删除可被占用的日程，返回被删掉的行（给界面回报"删了哪些"）。
 * 先查后删：删完就不知道删了什么了，而用户需要看到结果。
 */
export function deleteOccupiable(db: DatabaseSync): ScheduleRow[] {
  const rows = listOccupiable(db);
  if (rows.length === 0) return [];
  db.exec("DELETE FROM schedule WHERE flexibility = 2");
  return rows;
}

// ───────────────────────── 时段偏好（「我不想学」的时段） ─────────────────────────

export interface NewPreferenceInput {
  weekday_from: number;
  weekday_to: number;
  /** 留空 = 全天 */
  start_time?: string | null;
  end_time?: string | null;
  mode: "avoid" | "prefer";
  applies_to?: "study" | "life" | "any";
  strength?: number;
  reason?: string | null;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * 新增一条时段偏好。
 *
 * 「午休 12:00-13:30 不想学」这类需求就是靠它落库的：排期时
 *   - 提示词里【不能学习的时段】明确列出（模型看得见）
 *   - `quietWindowsFor()` 在代码里硬排除（模型说了不算）
 * 时间格式与区间在这里校验，越界即抛错（HTTP 层转 400）。
 */
export function createPreference(db: DatabaseSync, input: NewPreferenceInput): number {
  const from = Number(input.weekday_from);
  const to = Number(input.weekday_to);
  if (!Number.isInteger(from) || from < 1 || from > 7) throw new Error("weekday_from 必须是 1-7");
  if (!Number.isInteger(to) || to < 1 || to > 7) throw new Error("weekday_to 必须是 1-7");
  if (to < from) throw new Error("结束星期不能早于开始星期");
  if (input.mode !== "avoid" && input.mode !== "prefer")
    throw new Error("mode 只能是 avoid / prefer");

  const start = input.start_time?.trim() || null;
  const end = input.end_time?.trim() || null;
  for (const t of [start, end]) {
    if (t != null && !TIME_RE.test(t)) throw new Error(`时间格式必须是 HH:MM：${t}`);
  }
  if ((start == null) !== (end == null))
    throw new Error("开始和结束时间要么都给，要么都不给（都不给=全天）");
  if (start && end && toMin(end) <= toMin(start)) throw new Error("结束时间必须晚于开始时间");

  const strength = Math.min(3, Math.max(1, Math.round(Number(input.strength ?? 2))));
  const r = db
    .prepare(
      `INSERT INTO time_preference
         (weekday_from, weekday_to, start_time, end_time, mode, applies_to, strength, reason)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(
      from,
      to,
      start,
      end,
      input.mode,
      input.applies_to ?? "study",
      strength,
      input.reason ?? null,
    );
  const id = Number(r.lastInsertRowid);
  db.prepare("INSERT INTO event (type, ref_type, ref_id, payload) VALUES (?,?,?,?)").run(
    "preference_added",
    "time_preference",
    id,
    JSON.stringify({
      weekday_from: from,
      weekday_to: to,
      start,
      end,
      mode: input.mode,
      reason: input.reason ?? null,
    }),
  );
  return id;
}

export function deletePreference(db: DatabaseSync, id: number): boolean {
  const r = db.prepare("DELETE FROM time_preference WHERE id = ?").run(id);
  const ok = Number(r.changes) > 0;
  if (ok) {
    db.prepare("INSERT INTO event (type, ref_type, ref_id, payload) VALUES (?,?,?,?)").run(
      "preference_removed",
      "time_preference",
      id,
      null,
    );
  }
  return ok;
}

// ───────────────────────── 学习时长上限（学习习惯） ─────────────────────────

/**
 * 保存「单次学习不超过 X 分钟」「单次休息不超过 Y 分钟」。
 * 存 capacity_rule（period='day'），排期时由 readStudyLimits 读回。
 * 范围校验放这里：小于 10 分钟的学习块没有意义，超过 4 小时也不算"单次"。
 */
export function saveStudyLimits(
  db: DatabaseSync,
  patch: { maxBlockMinutes?: number; maxBreakMinutes?: number },
): ReturnType<typeof readStudyLimits> {
  const cur = readStudyLimits(db);
  const block = Math.round(Number(patch.maxBlockMinutes ?? cur.maxBlockMinutes));
  const rest = Math.round(Number(patch.maxBreakMinutes ?? cur.maxBreakMinutes));
  if (!Number.isFinite(block) || block < 10 || block > 240) {
    throw new Error("单次学习上限要在 10–240 分钟之间");
  }
  if (!Number.isFinite(rest) || rest < 0 || rest > 60) {
    throw new Error("单次休息上限要在 0–60 分钟之间");
  }

  const upsert = (metric: string, value: number, note: string): void => {
    db.prepare("DELETE FROM capacity_rule WHERE period = 'day' AND metric = ?").run(metric);
    db.prepare(
      "INSERT INTO capacity_rule (period, metric, min_value, max_value, note) VALUES (?,?,?,?,?)",
    ).run("day", metric, null, value, note);
  };
  upsert("study_block_minutes", block, "每次学习不超过这么多分钟");
  upsert("break_minutes", rest, "每次休息不超过这么多分钟（课间除外）");
  return { maxBlockMinutes: block, maxBreakMinutes: rest };
}

// ───────────────────────── 把排期建议写入日程 ─────────────────────────

export interface PlanBlockInput {
  date: string;
  start: string;
  end: string;
  /** 具体任务名；不传才落成「学习计划」 */
  title?: string;
  course_code?: string | null;
}

export interface SavedPlan {
  /** 成功写入的日程 id */
  written: number[];
  /** 被跳过的块及原因（冲突/格式错误），要原样告诉用户，不能默默丢 */
  skipped: Array<{ date: string; start: string; end: string; reason: string }>;
}

const TIME_ONLY = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * 用户确认后，把「排期建议」写成真实日程行。
 *
 * 写入前再校验一次冲突：建议是生成那一刻的世界状态，用户看的时候可能已经被别的安排占了。
 * 冲突块跳过并回报，绝不硬塞。
 */
export function savePlanBlocks(db: DatabaseSync, blocks: PlanBlockInput[]): SavedPlan {
  const written: number[] = [];
  const skipped: SavedPlan["skipped"] = [];
  if (blocks.length === 0) return { written, skipped };

  const dates = blocks.map((b) => b.date).filter(isRealDate);
  if (dates.length === 0) {
    return { written, skipped: blocks.map((b) => ({ ...b, reason: "日期格式不对" })) };
  }
  // ISO 日期字符串按字典序即时间序
  const sorted = [...dates].sort();
  const from = sorted[0]!;
  const to = sorted[sorted.length - 1]!;
  const occs = expandOccurrences(db, from, to);

  // 同一批里已经写进去的块也要参与冲突判断，否则一批重叠的块会全部落地
  const batch = new Map<string, Array<[number, number]>>();

  for (const b of blocks) {
    if (!isRealDate(b.date)) {
      skipped.push({ ...b, reason: "日期格式不对" });
      continue;
    }
    if (!TIME_ONLY.test(b.start) || !TIME_ONLY.test(b.end)) {
      skipped.push({ ...b, reason: "时间格式不对（要 HH:MM）" });
      continue;
    }
    const s = toMin(b.start);
    const e = toMin(b.end);
    if (e <= s) {
      skipped.push({ ...b, reason: "结束时间必须晚于开始时间" });
      continue;
    }
    const busy = [...busyIntervalsOf(occs, b.date), ...(batch.get(b.date) ?? [])];
    const clash = busy.some(([bs, be]) => s < be && e > bs);
    if (clash) {
      skipped.push({ ...b, reason: "与已有安排重叠" });
      continue;
    }
    try {
      const id = createSchedule(db, {
        title: b.title?.trim() || "学习计划",
        type: "plan",
        category: "plan",
        course_code: b.course_code?.trim().toUpperCase() || null,
        date: b.date,
        start_time: b.start,
        end_time: b.end,
        recurring: 0,
        flexibility: 2,
        source: "manual",
        // 用户点过保存，就是用户的决定：模型之后不得覆盖
        locked: 1,
      });
      written.push(id);
      const list = batch.get(b.date) ?? [];
      list.push([s, e]);
      batch.set(b.date, list);
    } catch (err) {
      skipped.push({ ...b, reason: (err as Error).message });
    }
  }
  return { written, skipped };
}
