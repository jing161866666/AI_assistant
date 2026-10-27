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
