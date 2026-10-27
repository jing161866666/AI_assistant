/**
 * 东南大学 2026—2027 学年校历（先验知识，随应用内置）
 *
 * 来源：学校官方校历图片。这些规则无法从任何一张课表截图推导出来，
 * 必须作为常量内置，否则每次算"某天有没有课"都会错。
 *
 * 关键概念：
 *   holiday    放假日 → 当天无课
 *   suspended  停课日 → 当天无课且不补（校运会、停课复习考试）
 *   makeup     调休日 → 当天按「第 week 周星期 weekday」的课表上课
 */

export interface ClassSlot {
  period: number;
  start: string;
  end: string;
}

export type OverrideKind = "holiday" | "suspended" | "makeup";

export interface DayOverride {
  date: string;
  kind: OverrideKind;
  /** makeup 时必填：跟哪一教学周 */
  week?: number;
  /** makeup 时必填：跟星期几（1=周一） */
  weekday?: number;
  note?: string;
}

export interface PeriodEvent {
  kind: "holiday" | "sports" | "exam_period" | "vacation";
  start: string;
  end: string;
  name: string;
  /** 这段时间是否允许安排学习。寒假为 false */
  studyAllowed: boolean;
  /** 是否自动生成"停课"教学日 */
  suppressClasses: boolean;
  /** 生成的 teaching_day.kind */
  dayKind?: OverrideKind;
}

export interface AcademicTerm {
  name: string;
  startDate: string; // 第 1 周周一
  totalWeeks: number;
  events: PeriodEvent[];
  overrides: DayOverride[];
  notes: string[];
}

/** 作息时间：节次 → 起止（与教务系统一致） */
export const SEU_CLASS_SLOTS: ClassSlot[] = [
  { period: 1, start: "08:00", end: "08:45" },
  { period: 2, start: "08:50", end: "09:35" },
  { period: 3, start: "09:50", end: "10:35" },
  { period: 4, start: "10:40", end: "11:25" },
  { period: 5, start: "11:30", end: "12:15" },
  { period: 6, start: "14:00", end: "14:45" },
  { period: 7, start: "14:50", end: "15:35" },
  { period: 8, start: "15:50", end: "16:35" },
  { period: 9, start: "16:40", end: "17:25" },
  { period: 10, start: "17:30", end: "18:15" },
  { period: 11, start: "19:00", end: "19:45" },
  { period: 12, start: "19:50", end: "20:35" },
  { period: 13, start: "20:40", end: "21:25" },
];

export const SEU_AUTUMN_2026: AcademicTerm = {
  name: "2026-2027-1",
  startDate: "2026-09-21", // 校历第 1 周周一
  totalWeeks: 18,
  events: [
    {
      kind: "holiday",
      start: "2026-09-25",
      end: "2026-09-27",
      name: "中秋节（放假，不调休）",
      studyAllowed: true,
      suppressClasses: true,
      dayKind: "holiday",
    },
    {
      kind: "holiday",
      start: "2026-10-01",
      end: "2026-10-07",
      name: "国庆节（放假；9/20、10/10 调休补课）",
      studyAllowed: true,
      suppressClasses: true,
      dayKind: "holiday",
    },
    {
      kind: "sports",
      start: "2026-11-05",
      end: "2026-11-07",
      name: "校运会（停课，不补）",
      studyAllowed: true,
      suppressClasses: true,
      dayKind: "suspended",
    },
    {
      kind: "exam_period",
      start: "2027-01-11",
      end: "2027-01-24",
      name: "停课复习考试（第 17-18 周）",
      studyAllowed: true,
      suppressClasses: true,
      dayKind: "suspended",
    },
    {
      kind: "vacation",
      start: "2027-01-25",
      end: "2027-02-21",
      name: "学生寒假",
      studyAllowed: false,
      suppressClasses: true,
      dayKind: "holiday",
    },
  ],
  overrides: [
    {
      date: "2026-09-20",
      kind: "makeup",
      week: 3,
      weekday: 2,
      note: "国庆调休：周日补 10/6（第3周周二）的课",
    },
    {
      date: "2026-10-10",
      kind: "makeup",
      week: 3,
      weekday: 3,
      note: "国庆调休：周六补 10/7（第3周周三）的课",
    },
  ],
  notes: [
    "本科生暑期学校 2026.8.24–9.19",
    "在校生注册 8 月 24–28 日",
    "秋季学期上课 9 月 20 日（当日为调休补课日）",
    "中秋节 9/25–27 放假，不调休",
    "国庆节 10/1–7 放假；9/20 补 10/6 的课，10/10 补 10/7 的课",
    "校运会 11/5–7，停课不补",
    "停课复习考试 1/11–24；学生寒假 1/25–2/21",
  ],
};

export const SEU_SPRING_2027: AcademicTerm = {
  name: "2026-2027-2",
  startDate: "2027-02-22",
  totalWeeks: 18,
  events: [
    {
      kind: "exam_period",
      start: "2027-06-14",
      end: "2027-06-27",
      name: "停课复习考试",
      studyAllowed: true,
      suppressClasses: true,
      dayKind: "suspended",
    },
    {
      kind: "vacation",
      start: "2027-06-28",
      end: "2027-08-15",
      name: "学生暑假",
      studyAllowed: false,
      suppressClasses: true,
      dayKind: "holiday",
    },
  ],
  overrides: [],
  notes: ["春季学期上课 2 月 22 日", "毕业典礼 6 月 22–23 日"],
};

export const SEU_CALENDAR = {
  school: "东南大学",
  academicYear: "2026-2027",
  terms: [SEU_AUTUMN_2026, SEU_SPRING_2027],
};

/** 把日期区间展开成逐日列表 */
export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  const ms = (s: string): number => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y!, (m ?? 1) - 1, d ?? 1);
  };
  const fmt = (n: number): string => {
    const d = new Date(n);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  };
  for (let t = ms(from); t <= ms(to); t += 86_400_000) out.push(fmt(t));
  return out;
}

/** 由 periodEvents + overrides 生成逐日 teaching_day 记录 */
export function buildTeachingDays(term: AcademicTerm): DayOverride[] {
  const map = new Map<string, DayOverride>();
  for (const ev of term.events) {
    if (!ev.suppressClasses) continue;
    for (const d of eachDate(ev.start, ev.end)) {
      map.set(d, { date: d, kind: ev.dayKind ?? "holiday", note: ev.name });
    }
  }
  // 显式 overrides 优先级更高（调休日会覆盖掉误生成的停课）
  for (const o of term.overrides) map.set(o.date, o);
  return [...map.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}
