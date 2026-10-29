export type Category = "academic" | "life" | "work" | "rest" | "plan";
export type Parity = "all" | "odd" | "even";
/** 0 不可动 / 1 可微调 / 2 可被占用 */
export type Flexibility = 0 | 1 | 2;

export interface Term {
  id: number;
  name: string;
  start_date: string; // 第 1 周周一
  total_weeks: number;
  is_active: number;
}

export interface ScheduleRow {
  id: number;
  title: string;
  type: string;
  category: Category;
  source: string;
  course_code: string | null;
  teacher: string | null;
  weekday: number | null;
  date: string | null;
  start_time: string | null;
  end_time: string | null;
  location: string | null;
  recurring: number;
  week_start: number;
  week_end: number;
  week_parity: Parity;
  flexibility: Flexibility;
  intent: string | null;
  energy: string | null;
  locked: number;
  priority: number;
  raw_text: string | null;
}

export interface ExceptionRow {
  id: number;
  schedule_id: number | null;
  date: string;
  kind: "cancel" | "reschedule" | "extra";
  new_date: string | null;
  new_start: string | null;
  new_end: string | null;
  note: string | null;
}

/** 展开到具体某一天的一个时间块 */
export interface Occurrence {
  scheduleId: number;
  date: string;
  start: string;
  end: string;
  minutes: number;
  title: string;
  /** 所属科目代码（排期按课程分配分钟数要用） */
  course_code: string | null;
  type: string;
  category: Category;
  flexibility: Flexibility;
  locked: number;
  intent: string | null;
  /** 来自 cancel/reschedule/extra 时为 true，便于排查 */
  fromException?: boolean;
  /** 来自调休日（如周日补周二的课）时为 true */
  fromMakeup?: boolean;
}

export interface Slot {
  start: string;
  end: string;
  minutes: number;
  /** 命中 avoid 偏好时的惩罚分，0 表示完全可用 */
  penalty: number;
  reason: string | null;
}

export interface PreferenceRow {
  id: number;
  weekday_from: number;
  weekday_to: number;
  start_time: string | null;
  end_time: string | null;
  mode: "avoid" | "prefer";
  applies_to: string;
  strength: number;
  reason: string | null;
}

export interface CapacityRow {
  id: number;
  period: "day" | "week";
  metric: string;
  min_value: number | null;
  max_value: number | null;
  note: string | null;
}

export interface Conflict {
  a: number;
  b: number;
  date: string;
  overlapStart: string;
  overlapEnd: string;
  detail: string;
}

export interface TeachingDay {
  id?: number;
  date: string;
  kind: "holiday" | "makeup" | "suspended";
  week: number | null;
  weekday: number | null;
  note: string | null;
}

export interface TermEventRow {
  id?: number;
  term_id: number | null;
  kind: string;
  start_date: string;
  end_date: string;
  name: string | null;
  study_allowed: number;
}
