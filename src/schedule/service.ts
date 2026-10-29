import type { DatabaseSync } from "node:sqlite";
import { parseWindowKey } from "../memory/study-window.js";
import type {
  CapacityRow,
  Category,
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
    course_code: (row.course_code ?? null) as string | null,
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

// ───────────────────────── 不想学的时段（硬排除） ─────────────────────────

export interface QuietWindow {
  /** 1-7 */
  weekday: number;
  /** 仅 listQuietWindows 填：偏好覆盖的最后一天（同一区间可跨多天） */
  weekdayTo?: number;
  startMin: number;
  endMin: number;
  /** 给人/给模型看的描述，如 "12:00-13:30（午休）" */
  label: string;
}

/**
 * 某天「用户明确说了不想学」的时段。
 *
 * `freeSlotsOn` 只给这些时段打惩罚分（软约束），排期校验需要硬排除，
 * 所以单独导出一个纯函数：谁能占用、谁不能，必须和提示词说的一致。
 */
export function quietWindowsFor(db: DatabaseSync, date: string): QuietWindow[] {
  const wdn = weekdayOf(date);
  const out: QuietWindow[] = [];
  for (const p of listPreferences(db)) {
    if (p.mode !== "avoid") continue;
    if (wdn < p.weekday_from || wdn > p.weekday_to) continue;
    if (p.applies_to !== "any" && p.applies_to !== "study") continue;
    const s = p.start_time ? toMin(p.start_time) : 0;
    const e = p.end_time ? toMin(p.end_time) : 1440;
    if (e <= s) continue;
    out.push({
      weekday: wdn,
      startMin: s,
      endMin: e,
      label: `${toTime(s)}-${p.end_time ?? "24:00"}${p.reason ? `（${p.reason}）` : ""}`,
    });
  }
  return out;
}

/** 不重复地列出所有「不想学」的时段（提示词用：按周几范围归并） */
export function listQuietWindows(db: DatabaseSync): QuietWindow[] {
  const out: QuietWindow[] = [];
  for (const p of listPreferences(db)) {
    if (p.mode !== "avoid") continue;
    if (p.applies_to !== "any" && p.applies_to !== "study") continue;
    const s = p.start_time ? toMin(p.start_time) : 0;
    const e = p.end_time ? toMin(p.end_time) : 1440;
    if (e <= s) continue;
    out.push({
      weekday: p.weekday_from,
      weekdayTo: p.weekday_to,
      startMin: s,
      endMin: e,
      label: `${toTime(s)}-${p.end_time ?? "24:00"}${p.reason ? `（${p.reason}）` : ""}`,
    });
  }
  return out;
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
  maxChunk?: number; // 单个块最长；不传则取「单次学习上限」设置
  /** 单次学习上限（分钟）；不传则读 capacity_rule，默认 60 */
  maxBlockMinutes?: number;
  /** 单次休息上限（分钟）；不传则读 capacity_rule，默认 5 */
  maxBreakMinutes?: number;
  allowPenalty?: boolean; // 是否允许占用有 avoid 偏好的时段，默认不允许
  /** 按偏好时段排序空档 + 按投入占比分配科目（默认 true；没有偏好数据时等于不生效） */
  usePreferences?: boolean;
  /** 参与排期的科目；不传则用 subject.ai_enabled，再退化为 investment 里出现的课 */
  courses?: string[];
  /** 投入占比为 0 的课不排（"避开水课"），默认 true */
  skipZeroInvestment?: boolean;
  /** 科目代码 → 显示名（前端传进来，服务端没有也能跑） */
  courseNames?: Record<string, string>;
}

/** 排期里一个任务的归属：哪门课、干什么 */
export interface PlannedBlock {
  date: string;
  start: string;
  end: string;
  minutes: number;
  /** 以下三项由偏好排期填充；旧调用方可以不看 */
  course_code?: string | null;
  kind?: "review" | "practice" | "netcourse" | "study";
  label?: string;
}

/** 学习时长相关的两个上限：用户在界面上改，存 capacity_rule，排期直接读 */
export interface StudyLimits {
  maxBlockMinutes: number;
  maxBreakMinutes: number;
}

export const DEFAULT_STUDY_LIMITS: StudyLimits = {
  maxBlockMinutes: 60,
  maxBreakMinutes: 5,
};

/**
 * 读「单次学习 / 单次休息」上限。
 * 存在 capacity_rule 里（period='day'），没配过就返回默认值——不能因为没配就把排期卡死。
 */
export function readStudyLimits(db: DatabaseSync): StudyLimits {
  const rows = listCapacity(db);
  const pick = (metric: string, fallback: number): number => {
    const v = rows.find(
      (r) => r.period === "day" && r.metric === metric && r.max_value != null,
    )?.max_value;
    return v == null ? fallback : Number(v);
  };
  return {
    maxBlockMinutes: pick("study_block_minutes", DEFAULT_STUDY_LIMITS.maxBlockMinutes),
    maxBreakMinutes: pick("break_minutes", DEFAULT_STUDY_LIMITS.maxBreakMinutes),
  };
}

// ───────────────────────── 偏好：时段 / 投入占比 / 资源 ─────────────────────────

export interface PlanWindow {
  startMin: number;
  endMin: number;
  /** 该时段是不是专属于某门课 */
  course_code: string | null;
  what: string;
}

export interface PlanWeight {
  course_code: string;
  /** 0-1；0 = 水课，不排 */
  weight: number;
}

const CODE_RE = /^[A-Z][A-Z0-9_-]{1,15}$/;

/**
 * 投入占比的写法用户不会统一：0.4 / 40% / 高 / 中 / 低 / 一般。
 * 这里做归一化；读不出来就返回 null（当作没配，不猜）。
 */
export function parseInvestment(value: string): number | null {
  const s = value.trim();
  const pct = s.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (pct) return Math.max(0, Math.min(1, Number(pct[1]) / 100));
  const num = s.match(/^(\d+(?:\.\d+)?)$/);
  if (num) return Math.max(0, Math.min(1, Number(num[1])));
  const word = s.match(/(高|多|中|一般|低|少|水)/);
  if (word) {
    const map: Record<string, number> = {
      高: 0.6,
      多: 0.6,
      中: 0.3,
      一般: 0.2,
      低: 0.1,
      少: 0.1,
      水: 0,
    };
    return map[word[1]!] ?? null;
  }
  return null;
}

/**
 * 读偏好时段（自述优先，模型观察的也认）。
 *
 * `courses` 传了 = 只读「这些科目 + 个人共用」的时段；不传 = 全部（含各科目专属）。
 * 以前这里恒不传 course，SQL 里又只放行 `course_code IS NULL`，
 * 结果**科目专属时段从来没参与过排期**——画像里能看到，排期里当它不存在。
 */
export function loadPlanWindows(db: DatabaseSync, courses?: string[] | null): PlanWindow[] {
  const only = [...new Set((courses ?? []).map((c) => c.trim().toUpperCase()).filter(Boolean))];
  const rows = db
    .prepare(
      `SELECT key, value, course_code, source FROM habit
       WHERE dimension IN ('study_window','study_time') AND status='active'
         ${
           only.length > 0
             ? `AND (course_code IS NULL OR UPPER(course_code) IN (${only.map(() => "?").join(",")}))`
             : ""
         }
       ORDER BY source='manual' DESC, key`,
    )
    .all(...only) as unknown as Array<{
    key: string;
    value: string;
    course_code: string | null;
    source: string;
  }>;

  const out: PlanWindow[] = [];
  for (const r of rows) {
    // key 写法不统一（全角冒号 / 时段:21-24 / 21点-23点），统一解析，解析不出来就跳过
    const w = parseWindowKey(r.key);
    if (!w) continue;
    out.push({ startMin: w.startMin, endMin: w.endMin, course_code: r.course_code, what: r.value });
  }
  return out;
}

/** 读课下投入占比：按科目存（跟着该科目进度一起），0 = 水课不排 */
export function loadPlanWeights(db: DatabaseSync, only?: string[]): PlanWeight[] {
  const rows = db
    .prepare(
      `SELECT key, value, course_code FROM habit
       WHERE dimension = 'investment' AND status='active'`,
    )
    .all() as unknown as Array<{ key: string; value: string; course_code: string | null }>;

  const out: PlanWeight[] = [];
  for (const r of rows) {
    const code = (r.course_code ?? (CODE_RE.test(r.key) ? r.key.toUpperCase() : "")).toUpperCase();
    if (!code) continue;
    if (only && only.length > 0 && !only.includes(code)) continue;
    const w = parseInvestment(r.value);
    if (w == null) continue;
    const hit = out.find((x) => x.course_code === code);
    if (hit) hit.weight = w;
    else out.push({ course_code: code, weight: w });
  }
  return out;
}

/** 哪些科目有可用的网课（本地/线上已有，或已上传）→ 排"看网课"而不是"做作业" */
export function loadNetcourseCourses(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT course_code FROM course_resource
       WHERE kind='netcourse' AND local_status IN ('available','uploaded') AND course_code IS NOT NULL`,
    )
    .all() as unknown as Array<{ course_code: string }>;
  return new Set(rows.map((r) => r.course_code.toUpperCase()));
}

/** 按权重把分钟数分给若干科目（最大余数法，保证总和精确） */
export function splitMinutes(
  weights: PlanWeight[],
  total: number,
): Array<PlanWeight & { minutes: number }> {
  const list = weights.filter((w) => w.weight > 0);
  if (list.length === 0 || total <= 0) return [];
  const sum = list.reduce((n, w) => n + w.weight, 0);
  const raw = list.map((w) => ({ ...w, minutes: Math.floor((total * w.weight) / sum) }));
  let left = total - raw.reduce((n, x) => n + x.minutes, 0);
  for (let i = 0; left > 0 && i < raw.length * 10; i++) {
    raw[i % raw.length]!.minutes += 1;
    left--;
  }
  return raw;
}

export interface PlanTask {
  course_code: string | null;
  kind: "review" | "practice" | "netcourse" | "study";
  label: string;
  minutes: number;
}

export interface DayTaskOptions {
  /** 参与排期的科目白名单（有教材库或有投入占比的课）；null = 不限 */
  allow?: Set<string> | null;
  /** 之前有课但没排上复习的科目（今天优先补） */
  pending?: string[];
  /** 科目显示名（覆盖默认解析） */
  names?: Record<string, string>;
  /** 最小块（用来把"复习最多占一半"取整到块） */
  minChunk?: number;
}

/**
 * 科目显示名：**课表官方名优先**，其次科目注册表，最后才退回代码。
 * 日程里要能看到「温习课上内容：大学物理(B)II」，而不是「PHY2」。
 */
export function loadCourseNames(db: DatabaseSync): Record<string, string> {
  const out: Record<string, string> = {};
  const subj = db
    .prepare("SELECT course_code, course_name FROM subject")
    .all() as unknown as Array<{ course_code: string; course_name: string }>;
  for (const r of subj) out[r.course_code.toUpperCase()] = r.course_name;

  // 课表官方名：同一科目出现最多的标题胜出
  const rows = db
    .prepare(
      `SELECT course_code, title, COUNT(*) AS n FROM schedule
       WHERE category='academic' AND course_code IS NOT NULL AND title IS NOT NULL AND title <> ''
       GROUP BY course_code, title ORDER BY n DESC`,
    )
    .all() as unknown as Array<{ course_code: string; title: string; n: number }>;
  const seen = new Set<string>();
  for (const r of rows) {
    const code = r.course_code.toUpperCase();
    if (seen.has(code)) continue;
    seen.add(code);
    out[code] = r.title; // 课表官方名覆盖注册表里的写法
  }
  return out;
}

/**
 * 当天该排什么：
 * - 当天有课 → 优先"温习课上内容"（按那天上的课，投入占比决定各科分多少）
 * - 当天没课 → 作业 / 看网课（有可用网课的科目排"看网课"，否则"做作业"）
 */
export function tasksForDay(
  db: DatabaseSync,
  occs: Array<{ date: string; category: string; title: string; course_code?: string | null }>,
  date: string,
  minutes: number,
  opts: DayTaskOptions = {},
): PlanTask[] {
  if (minutes <= 0) return [];
  const minChunk = opts.minChunk ?? 25;
  const allow = opts.allow ?? null;
  const inAllow = (code: string): boolean => !allow || allow.has(code.toUpperCase());

  // 显示名：课表官方名优先，其次科目注册表，最后才退回代码
  const names: Record<string, string> = { ...loadCourseNames(db), ...(opts.names ?? {}) };
  const label = (code: string): string => names[code.toUpperCase()] ?? code;

  const weights = loadPlanWeights(db);
  const weightOf = (code: string): number =>
    weights.find((w) => w.course_code === code.toUpperCase())?.weight ?? 1;

  const todayClasses = occs.filter((o) => o.date === date && o.category === "academic");
  const netcourses = loadNetcourseCourses(db);

  // 今天要复习哪些课：当天有课的 + 欠账的（前一天没排上的）
  const reviewCodes: string[] = [];
  for (const o of todayClasses) {
    const c = (o.course_code ?? "").toUpperCase();
    if (c && inAllow(c) && !reviewCodes.includes(c)) reviewCodes.push(c);
  }
  for (const c of opts.pending ?? []) {
    const code = c.toUpperCase();
    if (inAllow(code) && !reviewCodes.includes(code)) reviewCodes.push(code);
  }

  // 有课（或有欠账）→ 排温习，但**最多占当天一半**；剩下给做题/网课，
  // 否则会出现"一天排两块温习"的怪现象（用户反馈过）。
  if (reviewCodes.length > 0) {
    const weighted = reviewCodes
      .map((code) => ({ course_code: code, weight: weightOf(code) }))
      .filter((x) => x.weight > 0);
    if (weighted.length > 0) {
      const reviewBudget = Math.max(0, Math.floor(minutes / 2 / minChunk) * minChunk);
      const rest = minutes - reviewBudget;
      const tasks: PlanTask[] = splitMinutes(weighted, reviewBudget).map((s) => ({
        course_code: s.course_code,
        kind: "review" as const,
        label: `温习课上内容：${label(s.course_code)}`,
        minutes: s.minutes,
      }));
      if (rest >= minChunk) {
        const others = weights.filter((w) => w.weight > 0 && inAllow(w.course_code));
        if (others.length > 0) {
          tasks.push(
            ...splitMinutes(others, rest).map((s) => ({
              course_code: s.course_code,
              kind: netcourses.has(s.course_code) ? ("netcourse" as const) : ("practice" as const),
              label: netcourses.has(s.course_code)
                ? `看网课 + 做配套练习：${label(s.course_code)}`
                : `做作业 / 刷题：${label(s.course_code)}`,
              minutes: s.minutes,
            })),
          );
        }
      }
      return tasks;
    }
  }

  // 没课（或复习都排不上）→ 按投入占比排作业/网课
  const parts = weights.filter((w) => w.weight > 0 && inAllow(w.course_code));
  if (parts.length === 0) {
    return [{ course_code: null, kind: "study", label: "自主学习（未设置科目投入占比）", minutes }];
  }
  return splitMinutes(parts, minutes).map((s) => ({
    course_code: s.course_code,
    kind: netcourses.has(s.course_code) ? ("netcourse" as const) : ("practice" as const),
    label: netcourses.has(s.course_code)
      ? `看网课 + 做配套练习：${label(s.course_code)}`
      : `做作业 / 刷题：${label(s.course_code)}`,
    minutes: s.minutes,
  }));
}
export function slotSegments(
  slotStart: number,
  slotEnd: number,
  windows: PlanWindow[],
  minChunk: number,
): Array<{ s: number; e: number; pref: boolean }> {
  if (windows.length === 0 || slotEnd <= slotStart) {
    return [{ s: slotStart, e: slotEnd, pref: false }];
  }
  const prefs = windows
    .map((w) => ({ s: Math.max(slotStart, w.startMin), e: Math.min(slotEnd, w.endMin) }))
    .filter((x) => x.e - x.s >= minChunk)
    .sort((a, b) => a.s - b.s);

  // 重叠的偏好段先取并集：共用 8-9 点 + 本课也 8-9 点时，
  // 不合并会排出两段一模一样的"偏好段"，同一个空档被重复消费
  const merged: Array<{ s: number; e: number }> = [];
  for (const p of prefs) {
    const last = merged[merged.length - 1];
    if (last && p.s <= last.e) last.e = Math.max(last.e, p.e);
    else merged.push({ ...p });
  }

  const all: Array<{ s: number; e: number; pref: boolean }> = [];
  let cur = slotStart;
  for (const p of merged) {
    if (p.s > cur) all.push({ s: cur, e: p.s, pref: false });
    all.push({ s: p.s, e: p.e, pref: true });
    cur = Math.max(cur, p.e);
  }
  if (cur < slotEnd) all.push({ s: cur, e: slotEnd, pref: false });

  // 偏好段在前，其余段在后（其余段之间仍保持时间顺序）
  return [...all.filter((x) => x.pref), ...all.filter((x) => !x.pref)];
}

/**
 * 把学习任务塞进空闲时段。
 * 硬规则：绝不占用 flexibility=0 的块（上课/睡觉/考试），绝不占用 avoid 偏好时段。
 * 软规则：
 *   - 单次学习不超过用户设的上限（默认 60 分钟）；
 *   - 同一段空闲里连排多个块时，块之间按用户设的休息上限断开（默认 5 分钟）；
 *   - 「课间」不算休息：不同空闲段之间的间隔由课程/其它安排本身产生，不受休息上限约束。
 *   - 每天总量不超过 perDayMinutes 与 week capacity 上限。
 *   - 有偏好时段时，空档按"是否落在偏好时段里"排序，优先在偏好时段学（需求 1）。
 */
export function planStudy(db: DatabaseSync, opts: PlanOptions): PlannedBlock[] {
  const minChunk = opts.minChunk ?? 25;
  const limits = readStudyLimits(db);
  const blockCap = Math.max(minChunk, opts.maxBlockMinutes ?? limits.maxBlockMinutes);
  const maxChunk = Math.max(minChunk, Math.min(opts.maxChunk ?? blockCap, blockCap));
  const breakMin = Math.max(0, opts.maxBreakMinutes ?? limits.maxBreakMinutes);
  const occs = expandOccurrences(db, opts.from, opts.to);
  const caps = listCapacity(db);
  const weekCap = caps.find(
    (c) => c.period === "week" && c.metric === "study_minutes" && c.max_value != null,
  )?.max_value;

  const out: PlannedBlock[] = [];
  const weekUsed = new Map<number, number>();
  const term = getActiveTerm(db);

  // 偏好：没配过就等于空数组，排期行为与以前完全一致
  const usePrefs = opts.usePreferences !== false;
  // 只取「本次参与排期的科目 + 共用」的时段：科目专属时段现在真的会参与排序
  const windows = usePrefs ? loadPlanWindows(db, opts.courses) : [];
  const names = opts.courseNames ?? {};
  // 白名单：只给"有教材库或有投入占比"的科目排任务（体育/班会这类不该出现"温习"）
  const allow =
    opts.courses && opts.courses.length > 0
      ? new Set(opts.courses.map((c) => c.toUpperCase()))
      : null;
  /**
   * 复习欠账：某天有课但没排上（空档不够/分钟数被占满），
   * 记下来，第二天优先补——否则"有课却没复习"会一直发生。
   */
  const pendingReview = new Set<string>();

  for (let d = opts.from; parseDate(d) <= parseDate(opts.to); d = addDays(d, 1)) {
    // 寒暑假不排学习
    if (!isStudyAllowed(db, d)) continue;
    const wk = resolveWeek(d, term.start_date);
    const usedThisWeek = weekUsed.get(wk) ?? 0;
    let remaining = opts.perDayMinutes;
    if (weekCap != null) remaining = Math.min(remaining, weekCap - usedThisWeek);
    if (remaining <= 0) continue;

    // 空档按时间顺序；偏好时段靠「段」体现（见 slotSegments），不靠改变空档顺序
    const slots = freeSlotsOn(db, occs, d, { minMinutes: minChunk })
      .filter((s) => (opts.allowPenalty ? true : s.penalty === 0))
      .sort((a, b) => toMin(a.start) - toMin(b.start));

    // 今天排哪些任务：有课→温习（含欠账）；没课→作业/网课（按投入占比分）
    const tasks: PlanTask[] = usePrefs
      ? tasksForDay(db, occs, d, remaining, {
          allow,
          pending: [...pendingReview],
          names,
          minChunk,
        })
      : [{ course_code: null, kind: "study", label: "", minutes: remaining }];
    if (tasks.length === 0) continue;

    let placed = 0;
    let ti = 0;
    for (const s of slots) {
      const slotStart = toMin(s.start);
      const slotEnd = toMin(s.end);
      // 同一段空闲先排偏好时段，再排其余部分；没配偏好时就是一个整段
      for (const seg of slotSegments(slotStart, slotEnd, windows, minChunk)) {
        let cursor = seg.s;
        // 一段空闲里可以连排多个「学 X 分钟 + 休 Y 分钟」，按任务顺序消费
        while (cursor + minChunk <= seg.e && ti < tasks.length) {
          const task = tasks[ti]!;
          const room = Math.min(seg.e - cursor, maxChunk, task.minutes);
          if (room < minChunk) break;
          const block: PlannedBlock = {
            date: d,
            start: toTime(cursor),
            end: toTime(cursor + room),
            minutes: room,
          };
          if (usePrefs) {
            block.course_code = task.course_code;
            block.kind = task.kind;
            block.label = task.label;
          }
          out.push(block);
          placed += room;
          task.minutes -= room;
          cursor += room + breakMin;
          if (task.minutes < minChunk) ti++;
        }
        if (ti >= tasks.length) break;
      }
      weekUsed.set(wk, usedThisWeek + placed);
      if (ti >= tasks.length) break;
    }

    // 没排完的复习任务记成欠账，第二天优先补（有课却没复习不能就这么过去）
    for (const t of tasks) {
      if (t.kind !== "review" || !t.course_code) continue;
      if (t.minutes >= minChunk) pendingReview.add(t.course_code.toUpperCase());
      else pendingReview.delete(t.course_code.toUpperCase());
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
  teacher?: string | null;
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
       (title, type, category, source, course_code, teacher, weekday, date, start_time, end_time,
        location, recurring, week_start, week_end, week_parity, flexibility, intent, energy,
        locked, priority)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      input.title,
      input.type ?? "course",
      input.category ?? "academic",
      input.source ?? "manual",
      input.course_code ?? null,
      input.teacher ?? null,
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

// ───────────────────────── 用户手动增删改（M1 日程表编辑） ─────────────────────────
/**
 * 这里只做"确定性"的事：格式校验、周次边界、冲突提示。
 * 用户想加什么、怎么命名，属于用户的判断，代码不替他决定。
 *
 * 与模型侧的 schedule_add/update/remove 的区别：
 *   模型侧受 locked 约束（用户手改过的行不许模型覆盖），
 *   用户侧不受约束——UI 上点了删除就是用户本人的决定。
 */

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CATEGORIES: Category[] = ["academic", "life", "work", "rest", "plan"];
const PARITIES: Parity[] = ["all", "odd", "even"];

/**
 * `2026-13-40` 也符合 `\d{4}-\d{2}-\d{2}`，但 `Date.UTC` 会把它滚成 2027-02-09，
 * 于是"用户以为排在某天"和"实际落在另一天"静默分叉。必须回读校验。
 */
export function isRealDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d;
}

/** 一行日程的全部可写字段（不含 id / raw_text / created_at） */
export type ScheduleValues = Omit<ScheduleRow, "id" | "raw_text" | "start_time" | "end_time"> & {
  /** 校验过的日程开始/结束时间必然存在，与表上的可空列区分开 */
  start_time: string;
  end_time: string;
};

export function getSchedule(db: DatabaseSync, id: number): ScheduleRow | null {
  const row = db.prepare("SELECT * FROM schedule WHERE id = ?").get(id) as ScheduleRow | undefined;
  return row ?? null;
}

/** 校验失败返回人话，空数组表示通过 */
export function validateScheduleValues(values: ScheduleValues, totalWeeks: number): string[] {
  const errs: string[] = [];
  const title = values.title?.trim() ?? "";
  if (!title) errs.push("标题不能为空");
  else if (title.length > 40) errs.push("标题最多 40 个字");

  if (!TIME_RE.test(values.start_time ?? "")) errs.push("开始时间要写成 HH:MM（00:00–23:59）");
  if (!TIME_RE.test(values.end_time ?? "")) errs.push("结束时间要写成 HH:MM（00:00–23:59）");
  if (values.start_time && values.start_time === values.end_time) {
    errs.push("开始时间与结束时间不能相同（跨午夜请让结束时间早于开始时间）");
  }

  if (values.recurring) {
    if (!Number.isInteger(values.weekday) || values.weekday! < 1 || values.weekday! > 7) {
      errs.push("每周重复的日程必须指定星期几（1=周一 … 7=周日）");
    }
    const ws = Number(values.week_start);
    const we = Number(values.week_end);
    if (!Number.isInteger(ws) || !Number.isInteger(we)) errs.push("周次范围必须是整数");
    else {
      if (ws < 1) errs.push("起始周不能小于第 1 周");
      if (we > totalWeeks) errs.push(`结束周不能超过本学期总周数（${totalWeeks}）`);
      if (ws > we) errs.push("起始周不能大于结束周");
    }
  } else if (!isRealDate(values.date ?? "")) {
    errs.push("一次性日程必须指定真实日期 YYYY-MM-DD（例如 2026-09-07）");
  }

  if (!CATEGORIES.includes(values.category)) {
    errs.push(`类别只能是 ${CATEGORIES.join(" / ")}`);
  }
  if (!PARITIES.includes(values.week_parity)) errs.push("单双周只能是 all / odd / even");
  if (![0, 1, 2].includes(Number(values.flexibility))) errs.push("可动性只能是 0 / 1 / 2");
  return errs;
}

/** 这条日程实际会落到的日期窗口：用于冲突提示 */
export function windowOf(db: DatabaseSync, row: ScheduleRow): { from: string; to: string } {
  if (!row.recurring) {
    const d = row.date ?? "";
    return { from: d, to: d };
  }
  const term = getActiveTerm(db);
  const ws = Math.max(1, row.week_start);
  const we = Math.min(term.total_weeks, row.week_end);
  return {
    from: dateOfWeek(term.start_date, ws, 1),
    to: dateOfWeek(term.start_date, we, 7),
  };
}

/** 写入/修改后自检：这条日程与别的日程重了多少次（不阻止保存，只提示） */
export function conflictsFor(db: DatabaseSync, id: number, limit = 5): Conflict[] {
  const row = getSchedule(db, id);
  if (!row) return [];
  const { from, to } = windowOf(db, row);
  if (!from || !to || from > to) return [];
  return detectConflicts(expandOccurrences(db, from, to))
    .filter((c) => c.a === id || c.b === id)
    .slice(0, limit);
}
