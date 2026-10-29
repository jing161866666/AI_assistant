export interface Block {
  /** 日程行 id；调课/补课产生的临时块可能为 -1 */
  id: number;
  title: string;
  start: string;
  end: string;
  category: string;
  intent: string | null;
  flexibility: number | null;
  recurring: number | null;
  weekday_no: number | null;
  date: string | null;
  week_start: number | null;
  week_end: number | null;
  week_parity: string | null;
  location: string | null;
  source: string | null;
  locked: number | null;
  fromException: boolean;
  fromMakeup: boolean;
}

/** 写入日程的载荷（新建给全量，编辑给部分） */
export interface ScheduleWrite {
  title: string;
  category: string;
  type?: string;
  start_time: string;
  end_time: string;
  recurring: number;
  weekday?: number | null;
  date?: string | null;
  week_start?: number;
  week_end?: number;
  week_parity?: string;
  flexibility?: number;
  location?: string | null;
  intent?: string | null;
}

export interface ScheduleWriteResponse {
  ok: boolean;
  id: number;
  message: string;
  /** 与已有安排重叠的提示（只提示，不阻止保存） */
  conflicts: string[];
}

/** 可被学习计划占用的日程（flexibility=2）：批量清理前先给用户看清单 */
export interface OccupiableRow {
  id: number;
  title: string;
  /** 已格式化的时间，如 "每周一 08:00–09:00" / "2026-11-02 20:00–20:30" */
  when: string;
  category: string;
  source: string;
  locked: number;
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
  /** 排期依据：属于哪门课 / 干什么（偏好排期才有） */
  course_code?: string | null;
  kind?: "review" | "practice" | "netcourse" | "study";
  label?: string;
  /** 材料来源：existing 已有 / ai_generated AI 生成 / reference_book 建议参考书 / none */
  source_kind?: "existing" | "ai_generated" | "reference_book" | "none";
  /** 具体材料名与位置 */
  source_ref?: string;
}

export interface PlanResponse {
  blocks: PlanBlock[];
  totalMinutes: number;
  perDayMinutes: number;
  /** 本次排期实际使用的上限（单次学习 / 单次休息） */
  limits: StudyLimits;
  /** llm = 模型方案；rule = 用户主动要的规则版；failed = 模型没排出来（不冒充规则版） */
  source?: "llm" | "rule" | "failed";
  model?: string | null;
  /** 模型给了但被代码拒掉的块与原因 */
  dropped?: Array<{ date: string; start: string; end: string; why: string }>;
  /** 这次排期用到的偏好（偏好时段 / 投入占比），用来解释"为什么排在这儿" */
  preferences?: {
    windows: Array<{
      start: string;
      end: string;
      what: string;
      course_code: string | null;
    }>;
    weights: Array<{ course_code: string; weight: number }>;
  };
}

/** 学习习惯：单次学习、单次休息的上限（分钟） */
export interface StudyLimits {
  maxBlockMinutes: number;
  maxBreakMinutes: number;
}

export interface PlanApplyResponse {
  ok: boolean;
  written: number;
  skipped: Array<{ date: string; start: string; end: string; reason: string }>;
  ids: number[];
  message: string;
}

export interface Citation {
  index: number;
  textbook: string;
  chapter: string;
  page: number | null;
  excerpt: string;
}

export interface BeyondItem {
  topic: string;
  chapter_no: number | null;
  why: string;
}

/** 可用科目（每个教材库一个）；后端没有隐式默认科目，前端必须显式选 */
export interface CourseInfo {
  code: string;
  name: string;
  /** 教材库文件名；null = 还没构建知识库 */
  file: string | null;
  /** 参与进度门控的章节数 */
  chapters: number;
  textbookReady: boolean;
  active: boolean;
  /** 用户是否勾选「允许 AI 辅助」；进度与错题本只列 true 的科目 */
  aiEnabled: boolean;
}

/** 用户自述的习惯（source='manual'，一条即生效） */
export interface ManualHabit {
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

/** 偏好时段：排期优先放在这些时间 */
export interface StudyWindow {
  id: number;
  start: string | null;
  end: string | null;
  what: string;
  course_code: string | null;
  source: string;
}

/** 投入占比：某门课课下投入 0-1（0 = 水课，排期不分时间） */
export interface InvestmentSubject {
  code: string;
  name: string;
  textbook_ready: boolean;
  /** null = 没设过 */
  weight: number | null;
}

/** 在用的网课 / 教辅；local_status='missing' = 待上传 */
export interface CourseResource {
  id: number;
  course_code: string | null;
  kind: string;
  title: string;
  url: string | null;
  local_status: string;
  progress: number | null;
  note: string | null;
  source: string;
}

/** 课表课名 → 教材库 的匹配结果（三档来源 + 是否需要用户确认） */
export interface CourseMatchRow {
  name: string;
  code: string | null;
  tier: "exact" | "alias" | "short" | "model" | "none";
  confidence: number;
  reason: string;
  needs_confirm: boolean;
  ai_enabled: boolean;
  library: {
    code: string;
    name: string;
    file: string;
    chunks: number;
    chapters: number;
    chapter_nos: number;
    level: "L2" | "L3";
  } | null;
}

/** 科目注册表里的一门课 + 该科目的记忆概况（进度/错题/习惯） */
export interface SubjectSummary {
  code: string;
  name: string;
  active: boolean;
  textbook_file: string | null;
  textbook_ready: boolean;
  chapters: number;
  chunks: number;
  version: string;
  /** 预留：记忆库文件；null = 现在写在共享 learner.db 里 */
  learner_file: string | null;
  note: string | null;
  /** 用户是否勾选「允许 AI 辅助这门课」 */
  ai_enabled: boolean;
  progress: {
    maxChapterNo: number | null;
    learned: number[];
    learnedCount: number;
    gaps: number[];
    current: number | null;
  };
  mistakes: MistakeStats;
  habits: number;
}

/** 错题本按科目归类后的一组 */
export interface MistakeGroup {
  course_code: string | null;
  course_name: string;
  stats: MistakeStats;
  mistakes: Mistake[];
}

/** 课程表里的一门课（AI 辅助科目的候选来源） */
export interface TimetableCourse {
  code: string;
  name: string;
  /** 一周几节课（课表里出现的次数） */
  periods: number;
  registered: boolean;
  active: boolean;
  /** 用户是否勾选允许 AI 辅助 */
  ai_enabled: boolean;
  textbook_ready: boolean;
}

/** 课表解析出的一行课程 */
export interface TimetableRow {
  title: string;
  /** 1=周一 … 7=周日 */
  weekday: number;
  start: string;
  end: string;
  location: string | null;
}

/** 课表课程名 → 课程代码的对应（course-match：exact/alias/short 可用，model 需确认） */
export interface CourseMatch {
  title: string;
  /** 空串 = 没判断出来 */
  code: string;
  name: string;
  reason: string;
  isNew?: boolean;
  tier?: "exact" | "alias" | "short" | "model" | "none";
  confidence?: number;
  /** true = 模型猜的，必须用户确认后才采用 */
  needsConfirm?: boolean;
}

/** qwen 的科目分流结论（已过代码白名单校验） */
export interface SubjectRoute {
  raw: string;
  currentCode: string;
  currentName: string;
  /** 收敛到勾选白名单后的科目；null = 未归类 */
  code: string | null;
  name: string | null;
  /** true = 判成了别的科目 */
  mismatch: boolean;
  reason: string;
}

/** 学习路径的科目范围预检结果（要不要调用多科目知识库） */
export interface CourseScopeResponse {
  ok: boolean;
  intent: string;
  intentLabel: string;
  multiSubject: boolean;
  blocked: boolean;
  reason: string;
  warnings: string[];
  sources: Array<{ code: string; name: string; file: string; chapters: number }>;
  subjects: Array<{
    code: string;
    name: string;
    registered: boolean;
    status: "ready" | "no-textbook" | "unregistered";
    file: string | null;
    chapters: number;
    maxChapterNo: number | null;
    gaps: number[];
    note: string | null;
  }>;
  retrieval: Array<{ code: string; file: string; gatedChapters: number | null }>;
}

export interface AskResponse {
  ok: boolean;
  answer: string;
  citations: Citation[];
  model: string;
  ms: number;
  course?: string;
  question?: string;
  beyond?: BeyondItem[];
  /** 模型判为越界但定位不到章节：只能算"可能越界" */
  uncertain?: BeyondItem[];
  maxChapterNo?: number | null;
  /** 越界检查状态：no-outline 表示这次没生效 */
  guard?: "ok" | "no-progress" | "no-outline" | "failed";
  /** 科目分流：qwen 在用户勾选的科目里选出的最可能科目 */
  subject?: SubjectRoute;
}

export interface BankMatch {
  qno: string | null;
  kind: string;
  score: number;
  chapter: string;
  has_answer: boolean;
}

export type SolveSource = "bank-answer" | "bank-no-answer" | "model-only";

export interface ReviewView {
  mode: "solve" | "grade";
  verdict: "correct" | "partially" | "wrong" | "unsolved";
  error_type: string;
  errorTypeLabel: string;
  cause: string;
  correction: string;
  hints: string[];
  related_kps: string[];
  references: Citation[];
  /** 只解题时：答案来源（题库有答案 / 题库无答案 / 纯模型） */
  source?: SolveSource;
  /** 只解题时：题库匹配到的那道题 */
  bank?: BankMatch | null;
  /** 批改时：学生输入被判定成什么（答案 / 过程 / 提问） */
  input_kind?: "answer" | "process" | "question" | "empty" | "unknown";
  inputKindLabel?: string;
  /** M2：越界使用了未学知识点 */
  beyond?: BeyondItem[];
  /** 模型判为越界但定位不到章节 */
  uncertain?: BeyondItem[];
  maxChapterNo?: number | null;
  model?: string;
  ms?: number;
  /** 科目分流结论 */
  subject?: SubjectRoute;
}

export interface ReviewResponse {
  ok: boolean;
  mode: "solve" | "grade";
  view: ReviewView;
  question: string;
  myAnswer?: string;
  /** 这一轮在本地库里的 id（conversation + message） */
  turn?: { conversationId: number; userMessageId: number; assistantMessageId: number };
}

/** 从本地库读回的一轮对话：刷新页面后用它恢复上一次结果 */
export interface StoredTurn {
  conversationId: number;
  assistantMessageId: number;
  answer: string;
  createdAt: string;
  meta: {
    course: string;
    kind: "solve" | "grade" | "ask";
    question: string;
    studentInput?: string;
    detail?: "full" | "brief";
    source?: string;
    qno?: string | null;
    model?: string;
    ms?: number;
    citations?: number;
    answer_chars?: number;
    grade?: {
      verdict: string;
      input_kind: string;
      error_type: string;
      cause: string;
      hints: string[];
      related_kps: string[];
    };
    bank?: BankMatch | null;
  };
}

export interface Mistake {
  id: number;
  title: string;
  /** 所属科目；旧数据可能为 null */
  course_code?: string | null;
  /** photo / text：来自截图还是纯文字 */
  source?: string | null;
  /** 用户截图对应的 artifact.id；有值时界面优先显示原图 */
  artifact_id?: number | null;
  /** 题干原文（旧截图题 title 是占位的「图片题」，展示要用它） */
  raw_text?: string | null;
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
