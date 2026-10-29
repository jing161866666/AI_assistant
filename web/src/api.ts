async function req<T>(path: string, init?: RequestInit): Promise<T> {
  // 没有 body 的请求（DELETE 等）绝不能带 Content-Type: Fastify 会按"空 JSON body"
  // 直接回 400（FST_ERR_CTP_EMPTY_JSON_BODY），删除日程就是这么坏的。
  const headers: Record<string, string> = {};
  if (init?.body !== undefined && init.body !== null) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const j = JSON.parse(text) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      msg = text.slice(0, 200) || msg;
    }
    throw new Error(msg);
  }
  return JSON.parse(text) as T;
}

export const api = {
  /** 可用科目清单：后端不再有隐式默认科目，前端必须显式选一个传上去 */
  courses: () =>
    req<{
      ok: boolean;
      defaultCourse: string | null;
      courses: import("./types.ts").CourseInfo[];
      subjects: import("./types.ts").SubjectSummary[];
    }>("/api/courses"),

  /** 科目注册表（含每科进度/错题/习惯概况） */
  subjects: (includeArchived = false) =>
    req<{ ok: boolean; subjects: import("./types.ts").SubjectSummary[] }>(
      `/api/subjects${includeArchived ? "?includeArchived=1" : ""}`,
    ),

  /** 课表课名 → 教材库 的匹配（withModel=false 只看已确认映射，不调模型） */
  subjectMatches: (withModel = true) =>
    req<{ ok: boolean; courses: import("./types.ts").CourseMatchRow[] }>(
      `/api/subjects/match${withModel ? "" : "?model=0"}`,
    ),

  /** 确认/否决一条课名匹配；确认后写进别名表永久生效 */
  confirmAlias: (alias: string, code: string, accepted: boolean) =>
    req<{ ok: boolean; message: string }>("/api/subjects/alias", {
      method: "POST",
      body: JSON.stringify({ alias, code, accepted }),
    }),

  /** 自述习惯：一条就注入（不受模型证据阈值限制） */
  saveManualHabit: (body: {
    dimension: string;
    key: string;
    value: string;
    course?: string;
    context?: string;
  }) =>
    req<{ ok: boolean; id: number; scope: string; message: string }>("/api/habits/manual", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  manualHabits: (course?: string) =>
    req<{ ok: boolean; habits: import("./types.ts").ManualHabit[] }>(
      `/api/habits/manual${course ? `?course=${encodeURIComponent(course)}` : ""}`,
    ),

  /** 修改一条自述习惯（只有自己填的能改） */
  updateManualHabit: (
    id: number,
    body: {
      dimension?: string;
      key?: string;
      value?: string;
      context?: string | null;
      course?: string | null;
    },
  ) =>
    req<{ ok: boolean; habit: import("./types.ts").ManualHabit; message: string }>(
      `/api/habits/manual/${id}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),

  deleteManualHabit: (id: number) =>
    req<{ ok: boolean }>(`/api/habits/manual/${id}`, { method: "DELETE" }),

  /** 偏好时段（排期优先级依据） */
  studyWindows: (course?: string) =>
    req<{ ok: boolean; windows: import("./types.ts").StudyWindow[] }>(
      `/api/habits/windows${course ? `?course=${encodeURIComponent(course)}` : ""}`,
    ),

  /** 在用资源：网课 / 教辅 / 教材；missing = 待上传 */
  saveResource: (body: {
    course?: string;
    kind: string;
    title: string;
    url?: string;
    local_status?: string;
    progress?: number;
  }) =>
    req<{ ok: boolean; id: number; message: string }>("/api/resources", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  resources: (course?: string) =>
    req<{
      ok: boolean;
      resources: import("./types.ts").CourseResource[];
      missing: import("./types.ts").CourseResource[];
    }>(`/api/resources${course ? `?course=${encodeURIComponent(course)}` : ""}`),

  /** 增加科目：只登记科目本身，知识库要另外用 build:textbook 构建 */
  addSubject: (body: { code: string; name?: string; note?: string; textbookFile?: string }) =>
    req<{ ok: boolean; message: string; subject: import("./types.ts").SubjectSummary }>(
      "/api/courses",
      { method: "POST", body: JSON.stringify(body) },
    ),

  /** 改科目名/备注/启用停用；course_code 不可改 */
  updateSubject: (code: string, body: { name?: string; note?: string | null; active?: boolean }) =>
    req<{ ok: boolean; subject: import("./types.ts").SubjectSummary }>(
      `/api/courses/${encodeURIComponent(code)}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),

  /** 停用科目（软删除）：进度/错题/习惯都保留 */
  archiveSubject: (code: string) =>
    req<{ ok: boolean; message: string; subject: import("./types.ts").SubjectSummary }>(
      `/api/courses/${encodeURIComponent(code)}`,
      { method: "DELETE" },
    ),

  /** 全部科目的进度总览（"我的进度"页顶部卡片） */
  progressOverview: () =>
    req<{
      ok: boolean;
      subjects: import("./types.ts").SubjectSummary[];
      totals: { subjects: number; ready: number; mistakes: number; unresolved: number };
    }>("/api/progress/overview"),

  /** 学习路径的科目范围预检：要不要调用多科目知识库 */
  roadmapScope: (body: { course: string; courses: string[]; intent?: string }) =>
    req<import("./types.ts").CourseScopeResponse>("/api/roadmap/scope", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** AI 辅助科目的候选（来自课程表）与勾选状态 */
  aiSubjects: () =>
    req<{
      ok: boolean;
      courses: import("./types.ts").TimetableCourse[];
      selected: string[];
      candidates: Array<{ code: string; name: string; chapters: number; textbookReady: boolean }>;
    }>("/api/subjects/ai"),

  /** 保存勾选：只有勾的科目允许 qwen 分流；未勾的不参与候选 */
  setAiSubjects: (codes: string[]) =>
    req<{
      ok: boolean;
      message: string;
      courses: import("./types.ts").TimetableCourse[];
      selected: string[];
    }>("/api/subjects/ai", { method: "PUT", body: JSON.stringify({ codes }) }),

  /** 首次设置状态：没有课程日程 = 需要导入课表 */
  setupStatus: () =>
    req<{
      ok: boolean;
      needsSetup: boolean;
      scheduleCourses: number;
      subjects: number;
      textbookDbs: number;
      corpusFolders: string[];
    }>("/api/setup/status"),

  /** 课表（图片或文字）→ 结构化课程行 */
  parseTimetable: (body: { text?: string; image?: string }) =>
    req<{
      ok: boolean;
      rows: import("./types.ts").TimetableRow[];
      dropped: Array<{ reason: string; raw: unknown }>;
      model: string;
      ms: number;
    }>("/api/timetable/parse", { method: "POST", body: JSON.stringify(body) }),

  /** 课表课程名 → 课程代码（qwen 判断，代码校验） */
  matchTimetable: (titles: string[]) =>
    req<{
      ok: boolean;
      matches: import("./types.ts").CourseMatch[];
      candidates: Array<{ code: string; name: string; from: string }>;
      model: string;
    }>("/api/timetable/match", { method: "POST", body: JSON.stringify({ titles }) }),

  /** 确认导入：写日程 + 登记科目 + 建空库 */
  applyTimetable: (body: {
    rows: import("./types.ts").TimetableRow[];
    matches?: import("./types.ts").CourseMatch[];
    weekStart?: number;
    weekEnd?: number;
  }) =>
    req<{
      ok: boolean;
      scheduleAdded: number;
      subjects: Array<{
        code: string;
        name: string;
        subjectCreated: boolean;
        dbCreated: boolean;
        file: string;
        textbookReady: boolean;
      }>;
      unmatched: string[];
      model?: string;
    }>("/api/timetable/apply", { method: "POST", body: JSON.stringify(body) }),

  week: (week?: number) =>
    req<import("./types.ts").WeekResponse>(`/api/week${week == null ? "" : `?week=${week}`}`),

  plan: (
    week: number,
    perDayMinutes: number,
    limits?: import("./types.ts").StudyLimits,
    mode: "llm" | "rule" = "llm",
  ) =>
    req<import("./types.ts").PlanResponse>("/api/plan", {
      method: "POST",
      body: JSON.stringify({
        week,
        perDayMinutes,
        mode,
        maxBlockMinutes: limits?.maxBlockMinutes,
        maxBreakMinutes: limits?.maxBreakMinutes,
      }),
    }),

  /** 投入占比：每门课一个 0-100 的数（0 = 水课） */
  investments: () =>
    req<{ ok: boolean; subjects: import("./types.ts").InvestmentSubject[] }>(
      "/api/habits/investment",
    ),

  setInvestment: (course: string, percent: number) =>
    req<{ ok: boolean; course: string; weight: number; message: string }>(
      "/api/habits/investment",
      {
        method: "PUT",
        body: JSON.stringify({ course, weight: percent }),
      },
    ),

  /** 把排期建议写进日程；冲突块后端会跳过并回报 */
  applyPlan: (blocks: import("./types.ts").PlanBlock[]) =>
    req<import("./types.ts").PlanApplyResponse>("/api/plan/apply", {
      method: "POST",
      body: JSON.stringify({ blocks }),
    }),

  studyLimits: () => req<{ ok: boolean } & import("./types.ts").StudyLimits>("/api/study-limits"),

  saveStudyLimits: (limits: Partial<import("./types.ts").StudyLimits>) =>
    req<{ ok: boolean } & import("./types.ts").StudyLimits>("/api/study-limits", {
      method: "PUT",
      body: JSON.stringify(limits),
    }),

  /** 新增日程（用户自己输入） */
  scheduleCreate: (body: import("./types.ts").ScheduleWrite) =>
    req<import("./types.ts").ScheduleWriteResponse>("/api/schedule", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** 修改日程：只传改动过的字段 */
  scheduleUpdate: (id: number, body: Partial<import("./types.ts").ScheduleWrite>) =>
    req<import("./types.ts").ScheduleWriteResponse>(`/api/schedule/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  scheduleDelete: (id: number) =>
    req<{ ok: boolean; message?: string }>(`/api/schedule/${id}`, { method: "DELETE" }),

  /** 可被学习计划占用的日程（flexibility=2）的清单：批量删除前先预览 */
  scheduleOccupiable: () =>
    req<{ ok: boolean; count: number; rows: import("./types.ts").OccupiableRow[] }>(
      "/api/schedule/occupiable",
    ),

  /** 批量删除所有「可被学习计划占用」的日程（全学期） */
  scheduleDeleteOccupiable: () =>
    req<{ ok: boolean; deleted: number; titles: string[]; message: string }>(
      "/api/schedule/occupiable",
      { method: "DELETE" },
    ),

  ask: (question: string, images: string[] | undefined, course: string) =>
    req<import("./types.ts").AskResponse>("/api/ask", {
      method: "POST",
      body: JSON.stringify({ question, images, course }),
    }),

  review: (
    question: string,
    myAnswer: string | undefined,
    course: string,
    opts?: { correctAnswer?: string; images?: string[]; answerImages?: string[] },
  ) =>
    req<import("./types.ts").ReviewResponse>("/api/review", {
      method: "POST",
      body: JSON.stringify({
        question,
        myAnswer,
        course,
        correctAnswer: opts?.correctAnswer,
        images: opts?.images,
        answerImages: opts?.answerImages,
      }),
    }),

  /** 错题本：传 course 就只看该科目（统计同口径）；不传看全部 */
  mistakes: (course?: string) =>
    req<{
      ok: boolean;
      course: string | null;
      mistakes: import("./types.ts").Mistake[];
      stats: import("./types.ts").MistakeStats;
    }>(`/api/mistakes${course ? `?course=${encodeURIComponent(course)}` : ""}`),

  /** 错题本"全部科目"视图：按科目归类（含未归类） */
  mistakeGroups: () =>
    req<{
      ok: boolean;
      groups: import("./types.ts").MistakeGroup[];
      total: number;
    }>("/api/mistakes/groups"),

  saveMistake: (body: {
    title: string;
    /** 不传 = 未归类（模型也判不出科目），照样入库 */
    course?: string;
    /** 模型预测、但不在勾选科目里的课程名，随未归类错题记下 */
    predictedCourse?: string;
    raw_text?: string;
    my_answer?: string;
    correct_answer?: string;
    error_type?: string;
    error_detail?: string;
    kp_codes?: string[];
    /** 题目截图（data URL）：存了原图，错题本优先显示截图 */
    images?: string[];
  }) =>
    req<{ ok: boolean; id: number; hasImage?: boolean }>("/api/mistakes", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  deleteMistake: (id: number) => req<{ ok: boolean }>(`/api/mistakes/${id}`, { method: "DELETE" }),

  attempt: (id: number, correct: boolean) =>
    req<{ ok: boolean; attempts: number; resolved: boolean }>(`/api/mistakes/${id}/attempt`, {
      method: "POST",
      body: JSON.stringify({ correct }),
    }),

  /** 给旧错题补传截图：挂上后卡片优先显示原图 */
  attachMistakeImage: (id: number, image: string) =>
    req<{ ok: boolean; id: number; artifactId: number }>(`/api/mistakes/${id}/image`, {
      method: "POST",
      body: JSON.stringify({ image }),
    }),

  /** 读回某一轮的完整记录：刷新页面后恢复上一次结果 */
  turn: (id: number) =>
    req<{ ok: boolean; turn: import("./types.ts").StoredTurn }>(`/api/turns/${id}`),

  /** 最近若干轮 */
  turns: (course: string, limit = 20) =>
    req<{ ok: boolean; turns: import("./types.ts").StoredTurn[] }>(
      `/api/turns?course=${encodeURIComponent(course)}&limit=${limit}`,
    ),

  /** 用日程/错题/进度这些行为摘要刷新习惯（后台抽取，立即返回） */
  refreshHabits: (course: string, days = 30) =>
    req<{ ok: boolean; queued: boolean; reason?: string; queue: { pending: number } }>(
      "/api/habits/refresh",
      { method: "POST", body: JSON.stringify({ course, days }) },
    ),
};
