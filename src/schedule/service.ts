import type { DatabaseSync } from "node:sqlite";
import type {
  CapacityRow,
  Conflict,
  ExceptionRow,
  Occurrence,
  Parity,
  PreferenceRow,
  ScheduleRow,
  Slot,
  TeachingDay,
  Term,
  TermEventRow,
} from "./types.js";

// ───────────────────────── 时间工具（纯函数，可单测） ─────────────────────────

const pad = (n: number): string => String(n).padStart(2, "0");

export function parseDate(s: string): number {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y!, (m ?? 1) - 1, d ?? 1);
}

export function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function addDays(s: string, n: number): string {
  return fmtDate(parseDate(s) + n * 86_400_000);
}

/** 周一=1 … 周日=7 */
export function weekdayOf(s: string): number {
  const g = new Date(parseDate(s)).getUTCDay();
  return g === 0 ? 7 : g;
}

export function toMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function toTime(m: number): string {
  const c = Math.max(0, Math.min(1440, m));
  return `${pad(Math.floor(c / 60))}:${pad(c % 60)}`;
}

export function resolveWeek(date: string, termStart: string): number {
  return Math.floor((parseDate(date) - parseDate(termStart)) / 86_400_000 / 7) + 1;
}

export function dateOfWeek(termStart: string, week: number, weekday: number): string {
  return addDays(termStart, (week - 1) * 7 + (weekday - 1));
}

export function parityOk(parity: Parity, week: number): boolean {
  if (parity === "all") return true;
  if (parity === "odd") return week % 2 === 1;
  return week % 2 === 0;
}

/** 合并重叠/相接区间 */
export function mergeIntervals(list: Array<[number, number]>): Array<[number, number]> {
  const s = [...list].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const cur of s) {
    const last = out[out.length - 1];
    if (last && cur[0] <= last[1]) {
      last[1] = Math.max(last[1], cur[1]);
    } else {
      out.push([cur[0], cur[1]]);
    }
  }
  return out;
}

/** 从窗口里挖掉 busy，得到空档 */
export function subtractIntervals(
  window: Array<[number, number]>,
  busy: Array<[number, number]>,
): Array<[number, number]> {
  let cur = [...window];
  for (const [bs, be] of mergeIntervals(busy)) {
    const next: Array<[number, number]> = [];
    for (const [ws, we] of cur) {
      if (be <= ws || bs >= we) {
        next.push([ws, we]);
        continue;
      }
      if (bs > ws) next.push([ws, bs]);
      if (be < we) next.push([be, we]);
    }
    cur = next;
  }
  return cur.filter(([s, e]) => e > s);
}

// ───────────────────────── 读取 ─────────────────────────

export function getActiveTerm(db: DatabaseSync): Term {
  const t = db.prepare("SELECT * FROM term WHERE is_active = 1 ORDER BY id DESC LIMIT 1").get() as
    | Term
    | undefined;
  if (!t) {
    throw new Error("未设置学期。日程表需要学期起始日才能把「第 N 周」换算成日期。");
  }
  return t;
}

export function listSchedule(db: DatabaseSync): ScheduleRow[] {
  return db
    .prepare("SELECT * FROM schedule ORDER BY weekday, start_time")
    .all() as unknown as ScheduleRow[];
}

export function listPreferences(db: DatabaseSync): PreferenceRow[] {
  return db
    .prepare("SELECT * FROM time_preference ORDER BY weekday_from, start_time")
    .all() as unknown as PreferenceRow[];
}

export function listCapacity(db: DatabaseSync): CapacityRow[] {
  return db.prepare("SELECT * FROM capacity_rule").all() as unknown as CapacityRow[];
}

export function listExceptions(db: DatabaseSync): ExceptionRow[] {
  return db.prepare("SELECT * FROM schedule_exception").all() as unknown as ExceptionRow[];
}

export function listTeachingDays(db: DatabaseSync, from: string, to: string): TeachingDay[] {
  return db
    .prepare("SELECT * FROM teaching_day WHERE date BETWEEN ? AND ?")
    .all(from, to) as unknown as TeachingDay[];
}

export function listTermEvents(db: DatabaseSync, from: string, to: string): TermEventRow[] {
  return db
    .prepare("SELECT * FROM term_event WHERE end_date >= ? AND start_date <= ? ORDER BY start_date")
    .all(from, to) as unknown as TermEventRow[];
}

/** 该日期是否允许安排学习（寒暑假返回 false） */
export function isStudyAllowed(db: DatabaseSync, date: string): boolean {
  const ev = listTermEvents(db, date, date);
  return !ev.some((e) => e.study_allowed === 0);
}

// ───────────────────────── 展开到具体日期 ─────────────────────────

function materialize(row: ScheduleRow, date: string, start: string, end: string): Occurrence {
  return {
    scheduleId: row.id,
    date,
    start,
    end,
    minutes: toMin(end) - toMin(start),
    title: row.title,
    type: row.type,
    category: row.category,
    flexibility: row.flexibility,
    locked: row.locked,
    intent: row.intent,
  };
}

/**
 * 把重复日程展开成 [from, to] 区间内每天的具体时间块。
 * 依次处理：周次范围 → 单双周 → 例外（停课/调课/加课）。
 */
export function expandOccurrences(db: DatabaseSync, from: string, to: string): Occurrence[] {
  const term = getActiveTerm(db);
  const rows = listSchedule(db);
  const excs = listExceptions(db);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: Occurrence[] = [];

  // 调休日表：调休日不在学期周范围内（如 9/20 是周日、在开学前），
  // 所以必须先查 override，再决定"今天算第几周、按星期几上课"。
  const days = new Map<string, TeachingDay>();
  for (const t of listTeachingDays(db, from, to)) days.set(t.date, t);

  for (let d = from; parseDate(d) <= parseDate(to); d = addDays(d, 1)) {
    const ov = days.get(d);
    // 放假 / 停课：当天没有任何课
    if (ov && (ov.kind === "holiday" || ov.kind === "suspended")) continue;

    let wk: number;
    let wdn: number;
    if (ov && ov.kind === "makeup") {
      if (ov.week == null || ov.weekday == null) continue;
      wk = ov.week;
      wdn = ov.weekday;
    } else {
      wk = resolveWeek(d, term.start_date);
      wdn = weekdayOf(d);
      if (wk < 1 || wk > term.total_weeks) continue;
    }

    for (const r of rows) {
      if (!r.start_time || !r.end_time) continue;

      if (r.recurring) {
        if (r.weekday !== wdn) continue;
        if (wk < r.week_start || wk > r.week_end) continue;
        if (!parityOk(r.week_parity, wk)) continue;
        const ex = excs.find((e) => e.schedule_id === r.id && e.date === d);
        if (ex && (ex.kind === "cancel" || ex.kind === "reschedule")) continue;
        out.push({
          ...materialize(r, d, r.start_time, r.end_time),
          ...(ov?.kind === "makeup" ? { fromMakeup: true } : {}),
        });
      } else if (r.date === d) {
        out.push(materialize(r, d, r.start_time, r.end_time));
      }
    }

    // 例外：调课到这一天 / 额外加课
    for (const e of excs) {
      if (e.kind === "cancel") continue;
      const landsHere =
        (e.kind === "reschedule" && e.new_date === d) || (e.kind === "extra" && e.date === d);
      if (!landsHere) continue;
      const base = e.schedule_id != null ? byId.get(e.schedule_id) : undefined;
      const start = e.new_start ?? base?.start_time ?? null;
      const end = e.new_end ?? base?.end_time ?? null;
      if (!start || !end) continue;
      const row: ScheduleRow =
        base ??
        ({
          id: -1,
          title: e.note ?? "临时安排",
          type: "other",
          category: "life",
          source: "manual",
          course_code: null,
          teacher: null,
          weekday: null,
          date: d,
          start_time: start,
          end_time: end,
          location: null,
          recurring: 0,
          week_start: 1,
          week_end: 1,
          week_parity: "all",
          flexibility: 0,
          intent: null,
          energy: null,
          locked: 1,
          priority: 0,
          raw_text: null,
        } satisfies ScheduleRow);
      out.push({ ...materialize(row, d, start, end), fromException: true });
    }
  }

  return out.sort((a, b) =>
    a.date === b.date ? toMin(a.start) - toMin(b.start) : a.date < b.date ? -1 : 1,
  );
}

/** 某一天的占用区间。跨午夜的块（如睡觉 23:30–07:00）会被正确拆分到两天 */
export function busyIntervalsOf(occs: Occurrence[], date: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const o of occs) {
    const s = toMin(o.start);
    const e = toMin(o.end);
    if (e > s) {
      if (o.date === date) out.push([s, e]);
    } else if (e < s) {
      if (o.date === date) out.push([s, 1440]);
      if (addDays(o.date, 1) === date) out.push([0, e]);
    }
  }
  return out;
}

export interface FreeSlotOptions {
  dayStart?: string; // 默认 07:00
  dayEnd?: string; // 默认 23:30
  minMinutes?: number; // 默认 25
}

/** 空闲时段：先挖掉所有占用（含睡觉、打球），再按偏好打惩罚分 */
export function freeSlotsOn(
  db: DatabaseSync,
  occs: Occurrence[],
  date: string,
  opts: FreeSlotOptions = {},
): Slot[] {
  const dayStart = toMin(opts.dayStart ?? "07:00");
  const dayEnd = toMin(opts.dayEnd ?? "23:30");
  const minMinutes = opts.minMinutes ?? 25;
  const gaps = subtractIntervals([[dayStart, dayEnd]], busyIntervalsOf(occs, date));
  const wdn = weekdayOf(date);
  const prefs = listPreferences(db);

  return gaps
    .map(([s, e]) => [s, e] as [number, number])
    .filter(([s, e]) => e - s >= minMinutes)
    .map(([s, e]) => {
      let penalty = 0;
      const reasons: string[] = [];
      for (const p of prefs) {
        if (p.mode !== "avoid") continue;
        if (wdn < p.weekday_from || wdn > p.weekday_to) continue;
        if (p.applies_to !== "any" && p.applies_to !== "study") continue;
        const ps = p.start_time ? toMin(p.start_time) : 0;
        const pe = p.end_time ? toMin(p.end_time) : 1440;
        const overlap = Math.min(e, pe) - Math.max(s, ps);
        if (overlap > 0) {
          penalty += p.strength * 10;
          reasons.push(p.reason ?? `${p.start_time ?? "全天"} 起不想学`);
        }
      }
      return {
        start: toTime(s),
        end: toTime(e),
        minutes: e - s,
        penalty,
        reason: reasons.length ? reasons.join("；") : null,
      };
    });
}

// ───────────────────────── 冲突检测 ─────────────────────────

export function detectConflicts(occs: Occurrence[]): Conflict[] {
  const out: Conflict[] = [];
  const byDate = new Map<string, Occurrence[]>();
  for (const o of occs) {
    const l = byDate.get(o.date) ?? [];
    l.push(o);
    byDate.set(o.date, l);
  }
  for (const [date, list] of byDate) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        const s = Math.max(toMin(a.start), toMin(b.start));
        const e = Math.min(toMin(a.end), toMin(b.end));
        if (e > s) {
          out.push({
            a: a.scheduleId,
            b: b.scheduleId,
            date,
            overlapStart: toTime(s),
            overlapEnd: toTime(e),
            detail: `「${a.title}」与「${b.title}」重叠 ${e - s} 分钟`,
          });
        }
      }
    }
  }
  return out;
}

// ───────────────────────── 学习计划排期 ─────────────────────────

export interface PlanOptions {
  from: string;
  to: string;
  perDayMinutes: number; // 每天想学多少
  minChunk?: number; // 单个块最短，默认 25
  maxChunk?: number; // 单个块最长，默认 90
  allowPenalty?: boolean; // 是否允许占用有 avoid 偏好的时段，默认不允许
}

export interface PlannedBlock {
  date: string;
  start: string;
  end: string;
  minutes: number;
}

/**
 * 把学习任务塞进空闲时段。
 * 硬规则：绝不占用 flexibility=0 的块（上课/睡觉/考试），绝不占用 avoid 偏好时段。
 * 软规则：单个块不超过 maxChunk；每天总量不超过 perDayMinutes 与 week capacity 上限。
 */
export function planStudy(db: DatabaseSync, opts: PlanOptions): PlannedBlock[] {
  const minChunk = opts.minChunk ?? 25;
  const maxChunk = opts.maxChunk ?? 90;
  const occs = expandOccurrences(db, opts.from, opts.to);
  const caps = listCapacity(db);
  const weekCap = caps.find(
    (c) => c.period === "week" && c.metric === "study_minutes" && c.max_value != null,
  )?.max_value;

  const out: PlannedBlock[] = [];
  const weekUsed = new Map<number, number>();
  const term = getActiveTerm(db);

  for (let d = opts.from; parseDate(d) <= parseDate(opts.to); d = addDays(d, 1)) {
    // 寒暑假不排学习
    if (!isStudyAllowed(db, d)) continue;
    const wk = resolveWeek(d, term.start_date);
    const usedThisWeek = weekUsed.get(wk) ?? 0;
    let remaining = opts.perDayMinutes;
    if (weekCap != null) remaining = Math.min(remaining, weekCap - usedThisWeek);
    if (remaining <= 0) continue;

    const slots = freeSlotsOn(db, occs, d, { minMinutes: minChunk })
      .filter((s) => (opts.allowPenalty ? true : s.penalty === 0))
      .sort((a, b) => toMin(a.start) - toMin(b.start));

    let placed = 0;
    for (const s of slots) {
      if (remaining <= 0) break;
      let room = Math.min(s.minutes, maxChunk, remaining);
      if (room < minChunk) continue;
      // 整段够长就整段用，否则按剩余量截断
      room = Math.min(room, s.minutes);
      const startM = toMin(s.start);
      out.push({
        date: d,
        start: toTime(startM),
        end: toTime(startM + room),
        minutes: room,
      });
      placed += room;
      remaining -= room;
      weekUsed.set(wk, usedThisWeek + placed);
    }
  }
  return out;
}

// ───────────────────────── 写入 ─────────────────────────

export interface NewScheduleInput {
  title: string;
  type?: string;
  category?: string;
  source?: string;
  course_code?: string | null;
  weekday?: number | null;
  date?: string | null;
  start_time: string;
  end_time: string;
  location?: string | null;
  recurring?: number;
  week_start?: number;
  week_end?: number;
  week_parity?: Parity;
  flexibility?: number;
  intent?: string | null;
  energy?: string | null;
  locked?: number;
  priority?: number;
}

export function insertSchedule(db: DatabaseSync, input: NewScheduleInput): number {
  const r = db
    .prepare(
      `INSERT INTO schedule
       (title, type, category, source, course_code, weekday, date, start_time, end_time,
        location, recurring, week_start, week_end, week_parity, flexibility, intent, energy,
        locked, priority)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      input.title,
      input.type ?? "course",
      input.category ?? "academic",
      input.source ?? "manual",
      input.course_code ?? null,
      input.weekday ?? null,
      input.date ?? null,
      input.start_time,
      input.end_time,
      input.location ?? null,
      input.recurring ?? 0,
      input.week_start ?? 1,
      input.week_end ?? 16,
      input.week_parity ?? "all",
      input.flexibility ?? 0,
      input.intent ?? null,
      input.energy ?? null,
      input.locked ?? 0,
      input.priority ?? 0,
    );
  return Number(r.lastInsertRowid);
}
