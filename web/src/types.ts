export interface Block {
  title: string;
  start: string;
  end: string;
  category: string;
  intent: string | null;
}

export interface FreeSlot {
  start: string;
  end: string;
  minutes: number;
  warning: string | null;
}

export interface Teaching {
  kind: "holiday" | "suspended" | "makeup";
  note: string | null;
}

export interface Day {
  date: string;
  weekday: string;
  week: number;
  blocks: Block[];
  free: FreeSlot[];
  teaching: Teaching | null;
  events: Array<{ name: string; kind: string }>;
}

export interface CourseStat {
  title: string;
  count: number;
}

export interface WeekResponse {
  term: { name: string; start_date: string; total_weeks: number };
  week: number;
  from: string;
  to: string;
  today: string;
  days: Day[];
  context: {
    today: string;
    currentWeek: number;
    courses: CourseStat[];
    preferences: Array<{
      weekday_from: number;
      weekday_to: number;
      start_time: string | null;
      end_time: string | null;
      mode: string;
      strength: number;
      reason: string | null;
    }>;
    capacities: Array<{
      period: string;
      metric: string;
      min_value: number | null;
      max_value: number | null;
      note: string | null;
    }>;
  };
}

export interface PlanBlock {
  date: string;
  start: string;
  end: string;
  minutes: number;
}

export interface PlanResponse {
  blocks: PlanBlock[];
  totalMinutes: number;
  perDayMinutes: number;
}

export interface Citation {
  index: number;
  textbook: string;
  chapter: string;
  page: number | null;
  excerpt: string;
}

export interface AskResponse {
  ok: boolean;
  answer: string;
  citations: Citation[];
  model: string;
  ms: number;
}

export interface ReviewResponse {
  ok: boolean;
  verdict: "correct" | "partially" | "wrong";
  error_type: string;
  errorTypeLabel: string;
  cause: string;
  correction: string;
  hints: string[];
  related_kps: string[];
  references: Citation[];
}

export interface Mistake {
  id: number;
  title: string;
  my_answer: string | null;
  correct_answer: string | null;
  error_type: string | null;
  error_detail: string | null;
  kp_codes: string | null;
  resolved: number;
  saved_at: string;
  attempts: number;
  last_attempt_at: string | null;
}

export interface MistakeStats {
  total: number;
  unresolved: number;
  byErrorType: Array<{ error_type: string; n: number }>;
}

export const CATEGORY_LABEL: Record<string, string> = {
  academic: "课程",
  life: "生活",
  work: "工作",
  rest: "休息",
  plan: "学习计划",
};

export const METRIC_LABEL: Record<string, string> = {
  study_minutes: "学习时长",
  sleep_minutes: "睡眠时长",
  exercise_minutes: "运动时长",
};

export const ERROR_LABEL: Record<string, string> = {
  none: "无错误",
  concept: "概念不清",
  misread: "审题出错",
  boundary: "边界条件漏判",
  formula: "公式记错/用错",
  unit: "单位或量纲",
  logic: "推导逻辑断裂",
  careless: "计算粗心",
  unknown: "无法判断",
};

export function toMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function hm(min: number): string {
  const c = Math.max(0, Math.round(min));
  return `${String(Math.floor(c / 60)).padStart(2, "0")}:${String(c % 60).padStart(2, "0")}`;
}

export function durationLabel(min: number): string {
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`;
}
