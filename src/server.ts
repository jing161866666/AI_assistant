import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { resolve, sep } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { applyTimetable } from "./course/apply.js";
import { listCourseFolders } from "./course/corpus.js";
import { parseTimetable } from "./course/timetable.js";
import { getLearnerDb, inspectTables, listTextbookDbs, paths } from "./db/index.js";
import { checkEnv } from "./llm/models.js";
import { clearChapterName, listChapterNames, setChapterName } from "./memory/chapter-name.js";
import {
  advanceTo,
  type ChapterStatus,
  clearChapterProgress,
  listChapterProgress,
  setChapterProgress,
} from "./memory/chapter-progress.js";
import {
  type BankSnapshot,
  type GradeSnapshot,
  getTurn,
  listTurns,
  saveTurn,
} from "./memory/conversation.js";
import { confirmAlias, matchCourses } from "./memory/course-match.js";
import {
  extractHabits,
  INJECT_MIN_CONFIDENCE,
  INJECT_MIN_EVIDENCE,
  injectableHabits,
  rebuildHabitFromEvents,
  rejectHabit,
} from "./memory/habit-extract.js";
import {
  deleteManualHabit,
  listManualHabits,
  listStudyWindows,
  saveManualHabit,
  updateManualHabit,
  validateManualHabit,
} from "./memory/habit-manual.js";
import {
  enqueueHabitExtraction,
  habitQueueState,
  recentHabitRuns,
  recordAction,
  refreshHabitsFromActivity,
} from "./memory/habit-pipeline.js";
import {
  addAttempt,
  attachMistakeImage,
  deleteMistake,
  getMistake,
  getMistakeImage,
  listMistakes,
  mistakeGroups,
  mistakeStats,
  saveMistake,
} from "./memory/mistakes.js";
import {
  gapsOf,
  loadProfile,
  profilePrompt,
  profileSummary,
  progressFilter,
} from "./memory/profile.js";
import {
  deleteResource,
  listResources,
  missingResources,
  type ResourceInput,
  upsertResource,
  validateResource,
} from "./memory/resources.js";
import { formatMinute } from "./memory/study-window.js";
import {
  addSubject,
  aiCandidates,
  aiSubjectCodes,
  archiveSubject,
  getSubject,
  isAiSubject,
  listSubjects,
  normalizeCourseCode,
  setAiSubjects,
  subjectKnowledgePoints,
  syncSubjectsFromTextbooks,
  textbookFileOf,
  textbookMeta,
  timetableCourses,
  updateSubject,
} from "./memory/subjects.js";
import {
  ask,
  askGeneral,
  CITATION_LIMIT,
  type Detail,
  errorTypeLabel,
  INPUT_KIND_LABEL,
  review,
  solve,
} from "./rag/answer.js";
import { BANK_TITLE, bankSize } from "./rag/bank.js";
import {
  applyChapterNames,
  type ChapterOutlineItem,
  listChapterOutline,
} from "./rag/chapter-outline.js";
import {
  type CourseIntent,
  INTENT_LABEL,
  planCourseScope,
  scopeSources,
} from "./rag/course-scope.js";
import { guardProgress } from "./rag/progress-guard.js";
import { textbookInfo } from "./rag/search.js";
import { reviewStream, type StreamEvent, solveStream } from "./rag/stream.js";
import {
  buildRoutingContext,
  resolveRoute,
  routeQuestion,
  type SubjectRoute,
} from "./rag/subject-router.js";
import { proposePlanWithLlm } from "./schedule/plan-llm.js";
import {
  addDays,
  conflictsFor,
  dateOfWeek,
  expandOccurrences,
  freeSlotsOn,
  getActiveTerm,
  getSchedule,
  listCapacity,
  listPreferences,
  listSchedule,
  listTeachingDays,
  listTermEvents,
  loadPlanWeights,
  loadPlanWindows,
  type NewScheduleInput,
  parseInvestment,
  planStudy,
  readStudyLimits,
  resolveWeek,
} from "./schedule/service.js";
import { runTool } from "./schedule/tools.js";
import {
  createPreference,
  createSchedule,
  deleteOccupiable,
  deletePreference,
  deleteSchedule,
  listOccupiable,
  savePlanBlocks,
  saveStudyLimits,
  updateSchedule,
} from "./schedule/write.js";
import { extractImage, saveImageArtifact } from "./vision/extract.js";

const app = Fastify({
  logger: { level: "info" },
  // 图片以 base64 传入，默认 1MB 不够
  bodyLimit: 24 * 1024 * 1024,
});
const db = getLearnerDb();

/**
 * 空 body 的 JSON 请求不该算错：浏览器 `fetch` 发 DELETE / GET 时不带 body，
 * 但只要调用方带了 `Content-Type: application/json`，Fastify 默认解析器就会回
 * 400（FST_ERR_CTP_EMPTY_JSON_BODY）——删除日程点一下就是 Bad Request。
 * 这里只放宽"空 body 当作 {}"，非法 JSON 仍然按 400 报错，不吞掉真正的格式错误。
 */
app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
  const text = (body as string).trim();
  if (!text) return done(null, {});
  try {
    return done(null, JSON.parse(text));
  } catch {
    const err = new Error("Body 不是合法的 JSON") as Error & {
      statusCode: number;
      code: string;
    };
    err.statusCode = 400;
    err.code = "FST_ERR_CTP_INVALID_JSON_BODY";
    return done(err, undefined);
  }
});

// ───────────────────────── 行为 → 习惯：每个操作都留痕 ─────────────────────────

/** 显式配置的默认科目（读环境，避免依赖后面才初始化的常量） */
function envCourseCode(): string | null {
  const c = (process.env.COURSE_CODE ?? "").trim().toUpperCase();
  return c || null;
}

interface ActionMaterial {
  action: string;
  sourceType: string;
  sourceId: number | null;
  course: string | null;
  kind: "code" | "image" | "chat" | "answer";
  text: string;
}

/**
 * 把一次请求映射成「习惯材料」。
 *
 * 为什么集中成一张表而不是散在各 handler：散着写一定会漏，漏一个就意味着
 * 那个操作永远变不成习惯证据。GET 类接口不产生材料，返回 null。
 */
function habitMaterialOf(req: FastifyRequest): ActionMaterial | null {
  if (req.method === "GET") return null;
  const url = (req.url.split("?")[0] ?? "").replace(/\/+$/, "");
  const method = req.method;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const num = (v: unknown): number | null => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const course = str(body.course).toUpperCase() || envCourseCode();

  if (method === "POST" && url === "/api/mistakes") {
    const text = [
      `【错题】${str(body.title)}`,
      str(body.raw_text),
      str(body.my_answer) ? `【我的答案】${str(body.my_answer)}` : "",
      str(body.correct_answer) ? `【正确答案】${str(body.correct_answer)}` : "",
      str(body.error_type) ? `【错因】${str(body.error_type)} ${str(body.error_detail)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return {
      action: "保存错题",
      sourceType: "mistake",
      sourceId: null,
      course,
      kind: "answer",
      text,
    };
  }

  const attempt = url.match(/^\/api\/mistakes\/(\d+)\/attempt$/);
  if (method === "POST" && attempt) {
    const correct = body.correct === true;
    const text = [
      `【错题重做】第 ${attempt[1]} 道：${correct ? "这次做对了" : "还是错的"}`,
      str(body.myAnswer) ? `【这次的写法】${str(body.myAnswer)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return {
      action: "错题重做",
      sourceType: "mistake_attempt",
      sourceId: Number(attempt[1]),
      course,
      kind: "answer",
      text,
    };
  }

  const schedDel = url.match(/^\/api\/schedule\/(\d+)$/);
  if (method === "DELETE" && schedDel) {
    return {
      action: "删除日程",
      sourceType: "schedule",
      sourceId: Number(schedDel[1]),
      course,
      kind: "chat",
      text: `删除了日程第 ${schedDel[1]} 条`,
    };
  }
  if (method === "POST" && url === "/api/schedule") {
    const when = str(body.date) || (str(body.weekday) ? `每周${str(body.weekday)}` : "");
    const text = [
      `【新增日程】${str(body.title)}`,
      `${when} ${str(body.start_time)}-${str(body.end_time)}`,
      str(body.category) ? `分类：${str(body.category)}` : "",
      str(body.intent) ? `意愿：${str(body.intent)}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return {
      action: "新增日程",
      sourceType: "schedule",
      sourceId: null,
      course,
      kind: "chat",
      text,
    };
  }

  if (method === "POST" && url === "/api/plan/apply") {
    const blocks = Array.isArray(body.blocks) ? body.blocks.length : 0;
    return {
      action: "接受学习计划",
      sourceType: "plan",
      sourceId: null,
      course,
      kind: "chat",
      text: `接受了 ${blocks} 个学习计划块并写进日程`,
    };
  }

  if (method === "POST" && (url === "/api/progress" || url === "/api/progress/advance")) {
    const no = num(body.chapterNo);
    const isAdvance = url.endsWith("/advance");
    return {
      action: isAdvance ? "推进学习进度" : "设置章节状态",
      sourceType: "progress",
      sourceId: null,
      course,
      kind: "chat",
      text: isAdvance
        ? `把学习进度推进到第 ${no ?? "?"} 章（前面都算学完）`
        : `把第 ${no ?? "?"} 章标记为 ${str(body.status) || "done"}`,
    };
  }

  if (method === "PUT" && url === "/api/study-limits") {
    return {
      action: "设置学习上限",
      sourceType: "limits",
      sourceId: null,
      course,
      kind: "chat",
      text: `设定单次学习不超过 ${num(body.maxBlockMinutes) ?? "?"} 分钟、一次休息 ${num(body.maxBreakMinutes) ?? "?"} 分钟`,
    };
  }

  if (method === "POST" && url === "/api/preferences") {
    const WD = ["一", "二", "三", "四", "五", "六", "日"];
    const from = num(body.weekdayFrom) ?? 1;
    const to = num(body.weekdayTo) ?? 7;
    const days =
      from === to ? `周${WD[from - 1] ?? from}` : `周${WD[from - 1] ?? from}~周${WD[to - 1] ?? to}`;
    const span = str(body.start) && str(body.end) ? `${str(body.start)}-${str(body.end)}` : "全天";
    const want = body.mode === "prefer" ? "适合学" : "不想学";
    return {
      action: "设置时段偏好",
      sourceType: "preference",
      sourceId: null,
      course,
      kind: "chat",
      text: `设定时段偏好：${days} ${span} ${want}${str(body.reason) ? `（${str(body.reason)}）` : ""}`,
    };
  }

  return null;
}

/**
 * 每个操作结束后登记一次：材料够长就投给抽取，太短就写 habit_skip 并顺手刷新行为摘要。
 * 放在钩子里（而不是每个 handler 里手动调）是为了"新增一种操作只需改这张表"。
 * 必须注册在所有路由之前，否则对已注册路由不生效。
 */
app.addHook("onResponse", (req, reply, done) => {
  try {
    if (reply.statusCode < 400) {
      const m = habitMaterialOf(req);
      if (m) {
        const r = recordAction(db, {
          action: m.action,
          text: m.text,
          kind: m.kind,
          course: m.course,
          sourceType: m.sourceType,
          sourceId: m.sourceId,
        });
        app.log.info(`[habit] ${m.action} → ${r.queued ? "已投递抽取" : (r.reason ?? "已记录")}`);
      }
    }
  } catch (e) {
    app.log.warn(`[habit] 登记动作失败：${(e as Error).message}`);
  }
  done();
});

function localToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ───────────────────────── 基础 ─────────────────────────

app.get("/api/health", async () => {
  const env = checkEnv();
  return {
    ok: true,
    node: process.version,
    sqlite: (db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v,
    dbPath: paths.learnerDb,
    tables: inspectTables(db).length,
    textbooks: listTextbookDbs(),
    llm: env,
    /**
     * 运行中进程的能力自述。
     * 排查「前端请求 404」时先看这里：如果 stream 不是 true，
     * 说明这个进程是改代码之前启动的，需要重启——不是代码没写。
     */
    features: { stream: true, course: true, bank: true, subjects: true },
  };
});

app.get("/api/profile", async () => {
  const row = db.prepare("SELECT * FROM profile WHERE id = 1").get();
  return { profile: row ?? null };
});

app.post<{ Body: { nickname: string; studentNoTail?: string; school?: string } }>(
  "/api/profile",
  async (req) => {
    const { nickname, studentNoTail, school } = req.body ?? {};
    if (!nickname) return { ok: false, error: "nickname 必填" };
    db.prepare(
      `INSERT INTO profile (id, nickname, student_no_tail, school, updated_at)
       VALUES (1, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         nickname = excluded.nickname,
         student_no_tail = excluded.student_no_tail,
         school = excluded.school,
         updated_at = datetime('now')`,
    ).run(nickname, studentNoTail ?? null, school ?? null);
    return { ok: true };
  },
);

// 科目清单在「科目解析」一节统一提供（/api/courses 与 /api/subjects），此处不再重复注册。

// ───────────────────────── 周视图（前端主数据） ─────────────────────────

app.get<{ Querystring: { week?: string } }>("/api/week", async (req) => {
  const term = getActiveTerm(db);
  const today = localToday();
  const currentWeek = resolveWeek(today, term.start_date);

  let week = Number(req.query.week ?? currentWeek);
  if (!Number.isFinite(week) || week < 1) week = 1;
  if (week > term.total_weeks) week = term.total_weeks;

  const from = dateOfWeek(term.start_date, week, 1);
  const to = dateOfWeek(term.start_date, week, 7);

  const view = runTool(db, "schedule_view", { from, to }) as {
    days: Array<{
      date: string;
      weekday: string;
      week: number;
      blocks: Array<{
        title: string;
        start: string;
        end: string;
        category: string;
        intent: string | null;
      }>;
      free: Array<{ start: string; end: string; minutes: number; warning: string | null }>;
    }>;
  };

  const teachingMap = new Map(
    listTeachingDays(db, from, to).map((t) => [t.date, { kind: t.kind, note: t.note }]),
  );
  const events = listTermEvents(db, from, to);

  // 本周每门课上几次（按标题归并，一门课一周可能两次）
  const occs = expandOccurrences(db, from, to).filter((o) => o.category === "academic");
  const courseMap = new Map<string, { title: string; count: number }>();
  for (const o of occs) {
    const cur = courseMap.get(o.title) ?? { title: o.title, count: 0 };
    cur.count += 1;
    courseMap.set(o.title, cur);
  }

  return {
    term: { name: term.name, start_date: term.start_date, total_weeks: term.total_weeks },
    week,
    from,
    to,
    today,
    days: view.days.map((d) => ({
      ...d,
      teaching: teachingMap.get(d.date) ?? null,
      events: events
        .filter((e) => e.start_date <= d.date && d.date <= e.end_date)
        .map((e) => ({ name: e.name ?? e.kind, kind: e.kind })),
    })),
    context: {
      today,
      currentWeek,
      courses: [...courseMap.values()].sort((a, b) => b.count - a.count),
      preferences: listPreferences(db),
      capacities: listCapacity(db),
    },
  };
});

// ───────────────────────── 时段偏好（「这个点我不想学」） ─────────────────────────

/**
 * 新增时段偏好。典型用法：周一到周日 12:00-13:30 不想学（午休）。
 * 落 `time_preference`，排期时既进提示词（【不能学习的时段】），也在代码里硬排除。
 */
app.post<{
  Body: {
    weekdayFrom?: number;
    weekdayTo?: number;
    start?: string | null;
    end?: string | null;
    mode?: "avoid" | "prefer";
    appliesTo?: "study" | "life" | "any";
    strength?: number;
    reason?: string;
  };
}>("/api/preferences", async (req, reply) => {
  const b = req.body ?? {};
  try {
    const id = createPreference(db, {
      weekday_from: Number(b.weekdayFrom ?? 1),
      weekday_to: Number(b.weekdayTo ?? 7),
      start_time: b.start ?? null,
      end_time: b.end ?? null,
      mode: b.mode ?? "avoid",
      applies_to: b.appliesTo ?? "study",
      strength: b.strength,
      reason: b.reason ?? null,
    });
    return { ok: true, id, preferences: listPreferences(db) };
  } catch (e) {
    return reply.code(400).send({ ok: false, error: (e as Error).message });
  }
});

app.delete<{ Params: { id: string } }>("/api/preferences/:id", async (req, reply) => {
  const ok = deletePreference(db, Number(req.params.id));
  if (!ok) return reply.code(404).send({ ok: false, error: "不存在" });
  return { ok: true, preferences: listPreferences(db) };
});

app.get("/api/preferences", async () => ({ ok: true, preferences: listPreferences(db) }));

// ───────────────────────── 排期建议 ─────────────────────────

/** 单次学习 / 单次休息上限：用户的学习习惯，落 capacity_rule */
app.get("/api/study-limits", async () => ({ ok: true, ...readStudyLimits(db) }));

app.put<{ Body: { maxBlockMinutes?: number; maxBreakMinutes?: number } }>(
  "/api/study-limits",
  async (req, reply) => {
    try {
      const limits = saveStudyLimits(db, req.body ?? {});
      db.prepare("INSERT INTO event (type, ref_type, payload) VALUES (?,?,?)").run(
        "study_limits_set",
        "capacity_rule",
        JSON.stringify(limits),
      );
      return { ok: true, ...limits };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: (e as Error).message });
    }
  },
);

app.post<{
  Body: {
    week?: number;
    perDayMinutes?: number;
    maxBlockMinutes?: number;
    maxBreakMinutes?: number;
    /** llm = 让 qwen 出方案（默认）；rule = 只用代码规则版 */
    mode?: "llm" | "rule";
  };
}>("/api/plan", async (req) => {
  const term = getActiveTerm(db);
  const week = Number(req.body?.week ?? 1);
  const perDay = Number(req.body?.perDayMinutes ?? 120);
  // 界面上改了上限就直接记住，下次打开还是这个数
  if (req.body?.maxBlockMinutes != null || req.body?.maxBreakMinutes != null) {
    saveStudyLimits(db, {
      maxBlockMinutes: req.body?.maxBlockMinutes,
      maxBreakMinutes: req.body?.maxBreakMinutes,
    });
  }
  const limits = readStudyLimits(db);
  const from = dateOfWeek(term.start_date, week, 1);
  const to = dateOfWeek(term.start_date, week, 7);
  // 排期现在会读偏好：偏好时段优先占、按课下投入占比分科目、当天有课先排温习
  const subjects = listSubjects(db);
  const courseNames = Object.fromEntries(subjects.map((s) => [s.code.toUpperCase(), s.name]));
  // 只给"有教材库 或 设了投入占比"的科目排任务：
  // 体育/班会这类没库也没投入的课，不该出现"温习课上内容：体育"
  const invested = loadPlanWeights(db)
    .filter((w) => w.weight > 0)
    .map((w) => w.course_code.toUpperCase());
  const allowCodes = [
    ...new Set([
      ...subjects.filter((s) => s.textbook_ready).map((s) => s.code.toUpperCase()),
      ...invested,
    ]),
  ];
  const ruleBlocks = planStudy(db, {
    from,
    to,
    perDayMinutes: perDay,
    maxBlockMinutes: limits.maxBlockMinutes,
    maxBreakMinutes: limits.maxBreakMinutes,
    usePreferences: true,
    courseNames,
    courses: allowCodes,
  });

  /**
   * 默认让 qwen 排一版，代码只做硬约束校验（撞课/超上限/重叠一律丢回）。
   * 模型失败或一块都没通过时，回退到规则版——不能让用户点一下什么都没得到。
   */
  const wantLlm = req.body?.mode !== "rule";
  let blocks = ruleBlocks;
  /** llm = 模型方案；rule = 用户主动要的规则版；failed = 模型没排出来（不冒充规则版） */
  let source: "llm" | "rule" | "failed" = wantLlm ? "failed" : "rule";
  let dropped: Array<{ date: string; start: string; end: string; why: string }> = [];
  let model: string | null = null;

  if (wantLlm && allowCodes.length > 0) {
    // 把所有科目的画像合并成一段给模型看（习惯/进度/资源都在里面）
    const profiles = listSubjects(db)
      .filter((s) => allowCodes.includes(s.code.toUpperCase()))
      .map((s) => profilePrompt(loadProfile(db, s.code, s.name)));
    // 画像太长会拖慢模型：截到 3000 字，够它判断"谁占比高、谁有资源"
    const profileText = profiles.join("\n\n---\n\n").slice(0, 3000);
    try {
      const r = await proposePlanWithLlm(db, {
        from,
        to,
        perDayMinutes: perDay,
        profileText,
        minChunk: 25,
        maxChunk: limits.maxBlockMinutes,
      });
      model = r.model;
      if (r.ok && r.blocks.length > 0) {
        blocks = r.blocks.map((b) => ({
          date: b.date,
          start: b.start,
          end: b.end,
          minutes: b.minutes,
          course_code: b.course_code,
          kind: b.kind,
          label: b.task || b.reason || "",
          source_kind: b.source_kind,
          source_ref: b.source_ref,
        }));
        source = "llm";
      } else {
        // 模型没给出可用方案：**不偷偷用规则版冒充**。
        // 规则版只留给用户主动点「规则版」时用。
        source = "failed";
        blocks = [];
        dropped = r.dropped.map((d) => ({
          date: d.block.date,
          start: d.block.start,
          end: d.block.end,
          why: d.why,
        }));
      }
      if (r.ok || r.dropped.length > 0) {
        dropped = r.dropped.map((d) => ({
          date: d.block.date,
          start: d.block.start,
          end: d.block.end,
          why: d.why,
        }));
      }
    } catch (e) {
      // 出错同样不冒充：告诉用户"模型没排出来"，让他选规则版或重试
      console.error(`[plan] 模型排期失败：${(e as Error).message}`);
      source = "failed";
      blocks = [];
    }
  }

  // 失败时把原因说清楚：本周到底有没有空档（最常见的一种"排不出来"）
  let hint: string | null = null;
  if (source === "failed") {
    const occs = expandOccurrences(db, from, to);
    let slots = 0;
    for (let d = from; d <= to; d = addDays(d, 1)) {
      slots += freeSlotsOn(db, occs, d, { minMinutes: 25 }).filter((s) => s.penalty === 0).length;
    }
    hint =
      slots === 0
        ? "这一周已经没有可用空档了（被课程和你已保存的学习计划占满）。先删几天已保存的计划，或调小「每天学多少分钟」。"
        : "模型这次没给出合格方案（超时，或给的块都不合法）。点「让 qwen 排一版」重试。";
  }

  return {
    blocks,
    /** llm = 模型给的方案（已过硬约束校验）；rule = 规则版 */
    source,
    hint,
    model,
    /** 模型给了但被代码拒掉的块 + 原因，必须让用户看见 */
    dropped,
    totalMinutes: blocks.reduce((s, b) => s + b.minutes, 0),
    perDayMinutes: perDay,
    limits,
    /** 这次排期实际用到的偏好，前端可以一句话说明"为什么排在这个时间" */
    preferences: {
      // 与 planStudy 同一个过滤口径：参与排期的科目 + 共用时段
      windows: loadPlanWindows(db, allowCodes).map((w) => ({
        start: formatMinute(w.startMin),
        end: formatMinute(w.endMin),
        what: w.what,
        course_code: w.course_code,
      })),
      weights: loadPlanWeights(db),
    },
  };
});

/** 用户确认后，把排期建议真正写进日程（冲突块跳过并回报） */
app.post<{
  Body: {
    blocks?: Array<{
      date?: string;
      start?: string;
      end?: string;
      /** 具体任务名（如「温习课上内容：大学物理(B)II」），不传才退回「学习计划」 */
      title?: string;
      label?: string;
      course_code?: string | null;
    }>;
  };
}>("/api/plan/apply", async (req, reply) => {
  const raw = req.body?.blocks ?? [];
  if (!Array.isArray(raw) || raw.length === 0) {
    return reply.code(400).send({ ok: false, error: "没有可保存的建议块" });
  }
  if (raw.length > 200) {
    return reply.code(400).send({ ok: false, error: "一次最多保存 200 个块" });
  }
  const blocks = raw.map((b) => ({
    date: String(b.date ?? ""),
    start: String(b.start ?? ""),
    end: String(b.end ?? ""),
    // 保存后标题必须是"具体内容"，否则日程里全叫「学习计划」，看不出要干什么
    title: String(b.title ?? b.label ?? "").trim() || undefined,
  }));
  const r = savePlanBlocks(db, blocks);
  if (r.written.length > 0) {
    db.prepare("INSERT INTO event (type, ref_type, payload) VALUES (?,?,?)").run(
      "plan_apply",
      "schedule",
      JSON.stringify({ written: r.written.length, skipped: r.skipped.length }),
    );
  }
  return {
    ok: true,
    written: r.written.length,
    skipped: r.skipped,
    ids: r.written,
    message:
      r.skipped.length === 0
        ? `已把 ${r.written.length} 块学习计划写进日程`
        : `写入 ${r.written.length} 块，跳过 ${r.skipped.length} 块（${r.skipped[0]!.reason}）`,
  };
});

// ───────────────────────── 日程表增删改（用户自己输入日程） ─────────────────────────
/**
 * 与模型侧工具的区别：这里不做 locked 拦截——用户在界面上编辑，就是用户本人的决定。
 * 代码只负责确定性的事：时间/周次格式、边界、"是否与已有安排重叠"的提示。
 * 已存在的日程（含测试用的种子数据）不会被任何写接口自动改写，只有用户点了保存/删除才变。
 */

const WEEKDAY_NAME = ["一", "二", "三", "四", "五", "六", "日"];

function hasKey(b: Record<string, unknown>, k: string): boolean {
  return Object.hasOwn(b, k);
}

/** 只把请求里显式出现的字段放进 patch；缺省字段表示"沿用原值" */
function patchFromBody(b: Record<string, unknown>): Partial<NewScheduleInput> {
  const p: Partial<NewScheduleInput> = {};
  if (hasKey(b, "title")) p.title = String(b.title ?? "").trim();
  if (hasKey(b, "type")) p.type = String(b.type ?? "other");
  if (hasKey(b, "category")) p.category = String(b.category ?? "");
  if (hasKey(b, "start_time")) p.start_time = String(b.start_time ?? "");
  if (hasKey(b, "end_time")) p.end_time = String(b.end_time ?? "");
  if (hasKey(b, "recurring")) p.recurring = Number(b.recurring) ? 1 : 0;
  if (hasKey(b, "weekday")) {
    p.weekday = b.weekday == null || b.weekday === "" ? null : Number(b.weekday);
  }
  if (hasKey(b, "date")) p.date = typeof b.date === "string" && b.date ? b.date : null;
  if (hasKey(b, "week_start")) p.week_start = Number(b.week_start);
  if (hasKey(b, "week_end")) p.week_end = Number(b.week_end);
  if (hasKey(b, "week_parity")) p.week_parity = b.week_parity as NewScheduleInput["week_parity"];
  if (hasKey(b, "flexibility")) p.flexibility = Number(b.flexibility);
  if (hasKey(b, "location")) p.location = b.location ? String(b.location) : null;
  if (hasKey(b, "intent")) p.intent = b.intent ? String(b.intent) : null;
  return p;
}

/** 写操作统一记一条 event，日程变更可追溯（AGENTS：event 是唯一事实来源） */
function logScheduleEvent(type: string, id: number, title: string): void {
  db.prepare("INSERT INTO event (type, ref_type, ref_id, payload) VALUES (?,?,?,?)").run(
    type,
    "schedule",
    id,
    JSON.stringify({ id, title: title.slice(0, 60) }),
  );
}

/** 冲突摘要统一成前端能直接显示的短句 */
function conflictNotes(id: number): string[] {
  return conflictsFor(db, id, 5).map(
    (c) => `${c.date} ${c.overlapStart}-${c.overlapEnd}：${c.detail}`,
  );
}

/** 某一周涉及到的原始日程行（编辑用；块级数据在 /api/week 里） */
app.get<{ Querystring: { week?: string } }>("/api/schedule", async (req) => {
  const rows = listSchedule(db);
  const raw = req.query.week;
  if (raw == null || raw === "") return { ok: true, rows };
  const term = getActiveTerm(db);
  const week = Math.min(Math.max(Number(raw) || 1, 1), term.total_weeks);
  const from = dateOfWeek(term.start_date, week, 1);
  const to = dateOfWeek(term.start_date, week, 7);
  const ids = new Set(expandOccurrences(db, from, to).map((o) => o.scheduleId));
  return { ok: true, week, from, to, rows: rows.filter((r) => ids.has(r.id)) };
});

/** 新增一条日程：返回新 id、完整行和冲突提示（冲突只提示，不阻断用户） */
app.post<{ Body: Record<string, unknown> }>("/api/schedule", async (req, reply) => {
  const b = req.body ?? {};
  try {
    const p = patchFromBody(b);
    if (!p.title) return reply.code(400).send({ ok: false, error: "标题不能为空" });
    const input: NewScheduleInput = {
      ...p,
      title: p.title!,
      start_time: p.start_time ?? "",
      end_time: p.end_time ?? "",
      category: p.category ?? "life",
      type: p.type ?? "other",
      source: "manual",
      locked: 1,
    };
    const id = createSchedule(db, input);
    const row = getSchedule(db, id)!;
    logScheduleEvent("schedule_add", id, row.title);
    const where = row.recurring
      ? `每周${WEEKDAY_NAME[(row.weekday ?? 1) - 1]} ${row.start_time}–${row.end_time}`
      : `${row.date} ${row.start_time}–${row.end_time}`;
    return {
      ok: true,
      id,
      row,
      message: `已加入：${row.title}（${where}）`,
      conflicts: conflictNotes(id),
    };
  } catch (e) {
    return reply.code(400).send({ ok: false, error: (e as Error).message });
  }
});

/**
 * 「可被学习计划占用」的日程（flexibility=2）：批量删除的**预览**。
 *
 * 两步删是刻意的：这类块可能包含用户自己留的空白意愿块，删之前先让他看见
 * 到底有几条、都是什么，确认后才调 DELETE。列表顺序与界面一致。
 */
app.get("/api/schedule/occupiable", async () => {
  const rows = listOccupiable(db);
  return {
    ok: true,
    count: rows.length,
    rows: rows.map((r) => ({
      id: r.id,
      title: r.title,
      when: r.recurring
        ? `每周${WEEKDAY_NAME[(r.weekday ?? 1) - 1]} ${r.start_time}–${r.end_time}`
        : `${r.date ?? "（无日期）"} ${r.start_time}–${r.end_time}`,
      category: r.category,
      source: r.source,
      locked: r.locked,
    })),
  };
});

/**
 * 批量删除可被占用的日程（全学期，不只当前周）。
 * 正课(0) / 可微调(1) 不动；每条被删的行都记 event，日后可追溯。
 */
app.delete("/api/schedule/occupiable", async () => {
  const removed = deleteOccupiable(db);
  for (const r of removed) logScheduleEvent("schedule_remove", r.id, r.title);
  db.prepare("INSERT INTO event (type, ref_type, payload) VALUES (?,?,?)").run(
    "schedule_bulk_remove",
    "schedule",
    JSON.stringify({ flexibility: 2, deleted: removed.length }),
  );
  return {
    ok: true,
    deleted: removed.length,
    titles: removed.slice(0, 20).map((r) => r.title),
    message:
      removed.length === 0
        ? "没有「可被学习计划占用」的日程，什么都没删"
        : `已删除 ${removed.length} 条「可被学习计划占用」的日程`,
  };
});

/** 修改一条日程（整条系列；单次调课/停课请用 schedule_exception） */
app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
  "/api/schedule/:id",
  async (req, reply) => {
    const id = Number(req.params.id);
    if (!getSchedule(db, id)) return reply.code(404).send({ ok: false, error: "日程不存在" });
    try {
      const row = updateSchedule(db, id, patchFromBody(req.body ?? {}));
      logScheduleEvent("schedule_update", id, row.title);
      return { ok: true, id, row, message: `已保存：${row.title}`, conflicts: conflictNotes(id) };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: (e as Error).message });
    }
  },
);

/** 删除一条日程（用户主动操作，不受 locked 限制） */
app.delete<{ Params: { id: string } }>("/api/schedule/:id", async (req, reply) => {
  const id = Number(req.params.id);
  const row = getSchedule(db, id);
  if (!row) return reply.code(404).send({ ok: false, error: "日程不存在" });
  const ok = deleteSchedule(db, id);
  if (ok) logScheduleEvent("schedule_remove", id, row.title);
  return ok ? { ok: true, id, message: `已删除：${row.title}` } : { ok: false, error: "删除失败" };
});

// ───────────────────────── 通用工具入口（给 agent 调试用） ─────────────────────────

app.post<{ Params: { name: string }; Body: unknown }>("/api/tools/:name", async (req, reply) => {
  try {
    const result = runTool(db, req.params.name, req.body ?? {});
    return { ok: true, result };
  } catch (e) {
    return reply.code(400).send({ ok: false, error: (e as Error).message });
  }
});

// ───────────────────────── M1：解题 / 改错 / 错题本 ─────────────────────────

// ───────────────────────── 科目解析（M2：不再有静默默认） ─────────────────────────
/**
 * 科目只能来自两处：请求里显式传的 `course`，或 `.env` 里显式配置的 `COURSE_CODE`。
 * 都没有就 400，让调用方去选。
 *
 * 之前这里默认 `PHY2`：选了别的科目却查出物理进度、把物理错题写进别的科目，
 * 这类错误永远不会报出来，只会让画像悄悄错掉。
 */
const ENV_COURSE = (process.env.COURSE_CODE ?? "").trim().toUpperCase();

export interface CourseRef {
  code: string;
  /** 教材库文件名（data/textbook/ 下） */
  file: string;
  name: string;
  /** 参与门控的章节数（chapter_no 非空） */
  chapters: number;
}

const outlineCache = new Map<string, ChapterOutlineItem[]>();

const outlineKey = (course: { code: string; file: string }): string =>
  `${course.code.toUpperCase()}|${course.file}`;

/**
 * 教材真实章节表：越界检查的依据（属于先验知识，不靠模型猜），按「科目 + 库」缓存。
 * 用户改过的章名在这里合并进来——模型看到的名称与界面一致。
 */
function outlineFor(course: { code: string; file: string }): ChapterOutlineItem[] {
  const key = outlineKey(course);
  const hit = outlineCache.get(key);
  if (hit) return hit;
  const merged = applyChapterNames(
    listChapterOutline(course.file),
    listChapterNames(db, course.code),
  );
  outlineCache.set(key, merged);
  return merged;
}

/** 改名后必须清缓存，否则界面/模型还在用旧名 */
function invalidateOutline(course: { code: string; file: string }): void {
  outlineCache.delete(outlineKey(course));
}

/** 科目 → 教材库引用；知识库文件缺失返回 null（不抛错） */
function courseRef(code: string): CourseRef | null {
  const sub = getSubject(db, code);
  const file = sub?.textbook_file ?? textbookFileOf(code);
  const meta = textbookMeta(file);
  if (!meta) return null;
  return { code, file, name: sub?.name ?? meta.name, chapters: meta.chapters };
}

/**
 * 解析并校验请求里的科目。失败时已写好 400 响应，调用方 `if (!course) return;` 即可。
 *
 * 现在科目必须**先登记**（subject 表），且该科目知识库文件必须存在。
 * 三种失败分开报，用户才知道下一步该干什么：
 *   没传科目 → 去选；没登记 → 去「科目」页加；没知识库 → 去 build:textbook。
 */
function requireCourse(raw: unknown, reply: FastifyReply): CourseRef | null {
  const asked = typeof raw === "string" ? raw.trim() : "";
  let code = ENV_COURSE;
  if (asked) {
    try {
      code = normalizeCourseCode(asked);
    } catch (e) {
      void reply.code(400).send({ ok: false, error: (e as Error).message });
      return null;
    }
  }
  if (!code) {
    void reply.code(400).send({
      ok: false,
      error: "请先选择科目：请求里带 course（可选值见 GET /api/courses）",
    });
    return null;
  }
  const ref = courseRef(code);
  if (ref) return ref;
  if (!getSubject(db, code)) {
    void reply
      .code(400)
      .send({ ok: false, error: `科目 ${code} 未登记：先在「科目」页添加（POST /api/courses）` });
    return null;
  }
  void reply.code(400).send({
    ok: false,
    error: `科目 ${code} 还没有知识库：先用 npm run build:textbook 构建 course-${code.toLowerCase()}.db`,
  });
  return null;
}

/**
 * 进度 / 错题本的第二道闸：科目必须是用户勾选「允许 AI 辅助」的。
 *
 * 先走 requireCourse（未登记、没建库各自报错），再校验授权。
 * 不用 404 而用 403：科目确实存在，只是用户没同意让 AI 记录它。
 */
function requireAiCourse(raw: unknown, reply: FastifyReply): CourseRef | null {
  const ref = requireCourse(raw, reply);
  if (!ref) return null;
  if (!isAiSubject(db, ref.code)) {
    void reply.code(403).send({
      ok: false,
      error: `科目 ${ref.code} 未勾选「允许 AI 辅助」，进度与错题本不可用：先到「科目」页勾选`,
    });
    return null;
  }
  return ref;
}

/**
 * 没有选科目时：让模型在「用户勾选允许 AI 辅助」的科目里判一个。
 *
 * 勾选集合为空、或判出来不在集合内 → ref=null，调用方走「只回答、不引教材」。
 * 这是模型判断（第一节）+ 代码白名单（第三节）的组合：模型只能说集合里的代码。
 */
async function routeToCourse(question: string): Promise<{
  ref: CourseRef | null;
  route: SubjectRoute;
  candidates: ReturnType<typeof aiCandidates>;
}> {
  const candidates = aiCandidates(db);
  const current =
    candidates.length > 0
      ? { code: candidates[0]!.code, name: candidates[0]!.name }
      : { code: "", name: "（未指定）" };
  const routing = buildRoutingContext(db, current);
  const guess = await routeQuestion(question, routing).catch(() => "");
  const route = resolveRoute(routing.candidates, current, guess);
  const ref = route.code ? (courseRef(route.code) ?? null) : null;
  return { ref, route, candidates };
}

/** 可用科目清单：前端据此渲染科目选择器（含未建库/未登记的提示） */
app.get<{ Querystring: { includeArchived?: string } }>("/api/courses", async (req) => {
  const subjects = listSubjects(db, { includeArchived: req.query.includeArchived === "1" });
  return {
    ok: true,
    /** .env 里显式配置的默认科目；没配则为 null（前端自己记用户选过的） */
    defaultCourse: ENV_COURSE || null,
    courses: subjects.map((s) => ({
      code: s.code,
      name: s.name,
      file: s.textbook_file,
      chapters: s.chapters,
      textbookReady: s.textbook_ready,
      active: s.active,
      // 前端科目选择器据此只列"勾选允许 AI 辅助"的课（进度/错题本）
      aiEnabled: s.ai_enabled,
    })),
    subjects,
  };
});

/** 兼容旧接口：科目清单（等价于 /api/courses 的 subjects 字段） */
app.get<{ Querystring: { includeArchived?: string } }>("/api/subjects", async (req) => ({
  ok: true,
  subjects: listSubjects(db, { includeArchived: req.query.includeArchived === "1" }),
}));

/**
 * 增加科目 —— "增加科目的框架"入口。
 *
 * 只登记科目本身（代码 + 名称 + 备注），**不写任何先验知识**：
 * 教材、题库、校历、大纲必须由用户提供，再走 build:textbook（AGENTS 第二节）。
 * 也可以在这里绑定已构建好的教材库文件名。
 */
app.post<{
  Body: { code?: string; name?: string; note?: string; textbookFile?: string | null };
}>("/api/courses", async (req, reply) => {
  const b = req.body ?? {};
  if (!b.code) return reply.code(400).send({ ok: false, error: "code 必填（如 DS、MATH2）" });
  try {
    const subject = addSubject(db, {
      code: String(b.code),
      name: b.name,
      note: b.note,
      textbookFile: b.textbookFile ?? null,
    });
    return {
      ok: true,
      subject,
      message: subject.textbook_ready
        ? `已添加科目 ${subject.name}（${subject.code}），知识库已就绪`
        : `已添加科目 ${subject.name}（${subject.code}），知识库待构建：npm run build:textbook`,
    };
  } catch (e) {
    return reply.code(400).send({ ok: false, error: (e as Error).message });
  }
});

/** 改科目：名称/备注/绑定教材库/启停。course_code 是所有记忆的锚点，不允许改 */
app.patch<{
  Params: { code: string };
  Body: { name?: string; note?: string | null; textbookFile?: string | null; active?: boolean };
}>("/api/courses/:code", async (req, reply) => {
  const b = req.body ?? {};
  try {
    const subject = updateSubject(db, req.params.code, {
      name: b.name,
      note: b.note,
      textbookFile: b.textbookFile,
      active: b.active,
    });
    outlineCache.clear();
    return { ok: true, subject };
  } catch (e) {
    return reply.code(400).send({ ok: false, error: (e as Error).message });
  }
});

/** 停用科目（软删除）：不删进度/错题/习惯，重新启用后原样回来 */
app.delete<{ Params: { code: string } }>("/api/courses/:code", async (req, reply) => {
  try {
    const subject = archiveSubject(db, req.params.code);
    return { ok: true, subject, message: `已停用 ${subject.name}（历史记忆保留）` };
  } catch (e) {
    return reply.code(400).send({ ok: false, error: (e as Error).message });
  }
});

/** 该科目教材里的知识点清单（来自只读教材库；未建库返回空） */
app.get<{ Params: { code: string } }>("/api/courses/:code/knowledge-points", async (req, reply) => {
  let code: string;
  try {
    code = normalizeCourseCode(req.params.code);
  } catch (e) {
    return reply.code(400).send({ ok: false, error: (e as Error).message });
  }
  return { ok: true, course: code, knowledgePoints: subjectKnowledgePoints(db, code) };
});

/**
 * AI 辅助科目：候选来自**课程表**，用户逐个勾选。
 *
 * 没勾的课，qwen 不许往那科分流，也不参与科目路由的候选集合。
 * 勾选即授权，会顺手把这些课登记成科目（名称取课表），但不会替你建教材库。
 */
app.get("/api/subjects/ai", async () => {
  const courses = timetableCourses(db);
  return {
    ok: true,
    courses,
    selected: courses.filter((c) => c.ai_enabled).map((c) => c.code),
    candidates: aiCandidates(db),
  };
});

app.put<{ Body: { codes?: string[] } }>("/api/subjects/ai", async (req, reply) => {
  const codes = req.body?.codes;
  if (!Array.isArray(codes) || codes.length > 40) {
    return reply.code(400).send({ ok: false, error: "codes 必须是科目代码数组（最多 40 个）" });
  }
  try {
    const courses = setAiSubjects(db, codes.map(String));
    return {
      ok: true,
      courses,
      selected: courses.filter((c) => c.ai_enabled).map((c) => c.code),
      message:
        codes.length === 0
          ? "已关闭所有科目的 AI 辅助：qwen 不再做科目分流"
          : `已启用 ${codes.length} 门课的 AI 辅助：${codes.join("、")}`,
    };
  } catch (e) {
    return reply.code(400).send({ ok: false, error: (e as Error).message });
  }
});

// ───────────────────────── 课表课名 ↔ 教材库 匹配 ─────────────────────────

/**
 * 把课表里的官方课名对到教材库。
 * 结果分三档：exact/简称（字符可验，直接用）、alias（你确认过的）、model（模型猜的，必须你点头）。
 * `?model=0` 只用前两档，不调模型（只看现有映射）。
 */
app.get<{ Querystring: { model?: string } }>("/api/subjects/match", async (req) => {
  const r = await matchCourses(db, { useModel: req.query.model !== "0" });
  const enabled = new Set(
    (
      db.prepare("SELECT course_code FROM subject WHERE ai_enabled = 1").all() as Array<{
        course_code: string;
      }>
    ).map((x) => x.course_code),
  );
  return {
    ok: true,
    courses: r.courses.map((m) => ({
      name: m.name,
      code: m.code,
      tier: m.tier,
      confidence: m.confidence,
      reason: m.reason,
      needs_confirm: m.needsConfirm,
      ai_enabled: m.code ? enabled.has(m.code) : false,
      library: m.library
        ? {
            code: m.library.code,
            name: m.library.name,
            file: m.library.file,
            chunks: m.library.chunks,
            chapters: m.library.chapters,
            chapter_nos: m.library.chapterNos,
            /** L1=有知识点、L2=只有章号、L3=只有正文 */
            level: m.library.chapterNos === 0 ? "L3" : "L2",
          }
        : null,
    })),
    libraries: r.libraries,
  };
});

/** 确认 / 否决一条课名匹配（确认后写入别名表，以后不再问） */
app.post<{ Body: { alias?: string; code?: string; accepted?: boolean } }>(
  "/api/subjects/alias",
  async (req, reply) => {
    const alias = req.body?.alias?.trim();
    const code = req.body?.code?.trim().toUpperCase();
    if (!alias || !code) {
      return reply.code(400).send({ ok: false, error: "alias 与 code 都必填" });
    }
    confirmAlias(db, alias, code, Boolean(req.body?.accepted));
    return {
      ok: true,
      message: req.body?.accepted ? `已确认：${alias} → ${code}` : `已否决：${alias} ↛ ${code}`,
    };
  },
);

// ───────────────────────── 首次设置：课表导入 ─────────────────────────

/** 首次设置状态：没有课程日程就算"还没设置" */
app.get("/api/setup/status", async () => {
  const courses = Number(
    (
      db
        .prepare("SELECT COUNT(*) c FROM schedule WHERE category = 'academic' OR type = 'course'")
        .get() as { c: number }
    ).c,
  );
  const subjects = Number(
    (db.prepare("SELECT COUNT(*) c FROM subject WHERE active = 1").get() as { c: number }).c,
  );
  return {
    ok: true,
    needsSetup: courses === 0,
    scheduleCourses: courses,
    subjects,
    textbookDbs: listTextbookDbs().length,
    corpusFolders: listCourseFolders(),
  };
});

/**
 * 上传/粘贴课表 → 结构化课程行。
 * 图片先走视觉转录，再交给模型解析；节次→时间用 class_slot，不让模型编时间。
 */
app.post<{ Body: { image?: string; text?: string } }>(
  "/api/timetable/parse",
  async (req, reply) => {
    const image = req.body?.image;
    let text = req.body?.text?.trim() ?? "";
    try {
      if (!text && image) {
        const r = await extractImage(db, image, "question");
        text = r.text;
      }
      if (!text) return reply.code(400).send({ ok: false, error: "请上传课表图片或粘贴课表文字" });
      const parsed = await parseTimetable(db, { text });
      return { ok: true, ...parsed, text };
    } catch (e) {
      return reply.code(500).send({ ok: false, error: (e as Error).message });
    }
  },
);

/** 只做"课程名 → 代码"对应，给前端核对用（还没写日程） */
app.post<{ Body: { titles?: string[] } }>("/api/timetable/match", async (req, reply) => {
  const titles = (req.body?.titles ?? []).map(String).filter(Boolean);
  if (titles.length === 0 || titles.length > 60) {
    return reply.code(400).send({ ok: false, error: "titles 必须是 1–60 个课程名" });
  }
  try {
    const r = await matchCourses(db, { courses: [...new Set(titles)] });
    return {
      ok: true,
      model: "course-match",
      candidates: r.libraries.map((l) => ({ code: l.code, name: l.name, from: "textbook" })),
      matches: r.courses.map((m) => ({
        title: m.name,
        code: m.code ?? "",
        name: m.library?.name ?? m.name,
        reason: m.reason,
        tier: m.tier,
        confidence: m.confidence,
        needsConfirm: m.needsConfirm,
      })),
    };
  } catch (e) {
    return reply.code(500).send({ ok: false, error: (e as Error).message });
  }
});

/**
 * 确认导入：写日程 + 登记科目 + 建空库。
 * matches 可以由前端改过（用户核对），不传则现场让模型判断。
 */
app.post<{
  Body: {
    rows?: Array<{
      title?: string;
      weekday?: number;
      start?: string;
      end?: string;
      location?: string | null;
    }>;
    matches?: Array<{ title?: string; code?: string; name?: string; reason?: string }>;
    weekStart?: number;
    weekEnd?: number;
  };
}>("/api/timetable/apply", async (req, reply) => {
  const raw = req.body?.rows ?? [];
  if (!Array.isArray(raw) || raw.length === 0) {
    return reply.code(400).send({ ok: false, error: "没有可导入的课程行" });
  }
  if (raw.length > 100) return reply.code(400).send({ ok: false, error: "一次最多导入 100 行" });
  const rows = raw
    .map((r) => ({
      title: String(r.title ?? "").trim(),
      weekday: Number(r.weekday),
      start: String(r.start ?? ""),
      end: String(r.end ?? ""),
      location: r.location ?? null,
    }))
    .filter(
      (r) =>
        r.title &&
        Number.isInteger(r.weekday) &&
        r.weekday >= 1 &&
        r.weekday <= 7 &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(r.start) &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(r.end),
    );
  if (rows.length === 0) {
    return reply.code(400).send({ ok: false, error: "课程行都不合法（缺标题/周几/时间）" });
  }
  try {
    const result = await applyTimetable(db, {
      rows,
      matches: req.body?.matches?.map((m) => ({
        title: String(m.title ?? ""),
        code: String(m.code ?? ""),
        name: String(m.name ?? ""),
        reason: String(m.reason ?? ""),
        isNew: false,
      })),
      weekStart: req.body?.weekStart,
      weekEnd: req.body?.weekEnd,
    });
    return { ok: true, ...result };
  } catch (e) {
    return reply.code(500).send({ ok: false, error: (e as Error).message });
  }
});

app.get<{ Querystring: { course?: string } }>("/api/textbook", async (req, reply) => {
  const course = requireCourse(req.query.course, reply);
  if (!course) return;
  return {
    ...textbookInfo(course.file),
    course: course.code,
    bank: { title: BANK_TITLE, questions: bankSize(course.file) },
  };
});

/** 图片识别：把图转成可计算文本（公式转 LaTeX、图形转文字描述） */
app.post<{ Body: { image?: string; kind?: "question" | "answer"; course?: string } }>(
  "/api/extract-image",
  async (req, reply) => {
    const image = req.body?.image;
    if (!image) return reply.code(400).send({ ok: false, error: "image 不能为空" });
    try {
      const r = await extractImage(db, image, req.body?.kind ?? "question");
      // 转录出来的文字本身就是习惯材料（符号偏好、单位写法、错因），当场登记
      const asked = (req.body?.course ?? "").trim().toUpperCase();
      recordAction(db, {
        action: "图片转录",
        text: r.text,
        kind: "image",
        course: asked || envCourseCode(),
        sourceType: "image",
        sourceId: r.artifactId,
      });
      return { ok: true, ...r };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: (e as Error).message });
    }
  },
);

/** 把多张图依次识别并拼接（一道题常跨两页）——并行，串行会白等两倍时间 */
async function imageTexts(images: string[], kind: "question" | "answer"): Promise<string> {
  const parts = await Promise.all(
    images.map(async (img) => (await extractImage(db, img, kind)).text),
  );
  return parts.join("\n\n---\n\n");
}

app.post<{ Body: { question?: string; images?: string[]; course?: string } }>(
  "/api/ask",
  async (req, reply) => {
    // 问教材页不再有科目选择器：不传 course 时先让模型在勾选科目里判一个
    const asked = typeof req.body?.course === "string" ? req.body.course.trim() : "";
    let course: CourseRef | null = asked ? requireCourse(asked, reply) : null;
    if (asked && !course) return;
    let question = req.body?.question?.trim() ?? "";
    const images = (req.body?.images ?? []).slice(0, 4);
    try {
      // 只有拿不到文字时才转录（转录用于检索）；有文字时原图直接交给推理模型
      if (!question && images.length > 0) {
        question = await imageTexts(images, "question");
      }
      if (!question) return reply.code(400).send({ ok: false, error: "问题或图片至少给一个" });
      if (question.length > 8000) return reply.code(400).send({ ok: false, error: "内容过长" });

      // 未指定科目 → 先分流；判不出就纯模型回答（不引教材，避免借错书）
      let subject: SubjectRoute | null = null;
      if (!course) {
        const routed = await routeToCourse(question);
        course = routed.ref;
        subject = routed.route;
      }
      if (!course) {
        const prof = loadProfile(db, "");
        const r = await askGeneral(question, images, profilePrompt(prof));
        db.prepare("INSERT INTO event (type, ref_type, payload) VALUES (?,?,?)").run(
          "ask_unclassified",
          "textbook",
          JSON.stringify({ q: question.slice(0, 120), subject_guess: subject?.raw ?? "" }),
        );
        return {
          ok: true,
          ...r,
          course: null,
          subject,
          unclassified: true,
          note: "这道题不在你勾选的科目里：本次只作答，不引用任何教材。",
          question,
          citations: [],
        };
      }

      const prof = loadProfile(db, course.code, course.name);
      const filter = progressFilter(prof);
      const routing = buildRoutingContext(db, { code: course.code, name: course.name });
      const profileText = `${profilePrompt(prof, outlineFor(course))}\n\n${routing.text}`;
      // 科目分流与作答并行：小模型只回一个代码，不额外拖慢首字
      const [r, guess] = await Promise.all([
        ask(course.file, question, CITATION_LIMIT, images, profileText, filter),
        subject ? Promise.resolve(subject.raw) : routeQuestion(question, routing).catch(() => ""),
      ]);
      subject = resolveRoute(routing.candidates, { code: course.code, name: course.name }, guess);
      const beyond = await guardProgress(question, r.answer, filter, outlineFor(course));
      db.prepare("INSERT INTO event (type, ref_type, payload) VALUES (?,?,?)").run(
        "ask",
        "textbook",
        JSON.stringify({
          course: course.code,
          q: question.slice(0, 120),
          k: r.citations.length,
          imgs: images.length,
          beyond: beyond.beyond.length,
          guard: beyond.guard,
          subject_guess: subject.code,
          auto_routed: asked ? 0 : 1,
        }),
      );
      return {
        ok: true,
        ...r,
        course: course.code,
        subject,
        guard: beyond.guard,
        question,
        beyond: beyond.beyond,
        uncertain: beyond.uncertain,
        allWithin: beyond.allWithin,
        maxChapterNo: prof.maxChapterNo,
        gaps: gapsOf(prof),
        injected: {
          course: course.code,
          maxChapterNo: prof.maxChapterNo,
          habits: prof.habits.length,
        },
      };
    } catch (e) {
      return reply.code(500).send({ ok: false, error: (e as Error).message });
    }
  },
);

/**
 * 改错 / 只解题。
 * 不传 myAnswer 时不分析错因，直接给标准解答——但依然可以存进错题本。
 */
app.post<{
  Body: {
    question?: string;
    myAnswer?: string;
    correctAnswer?: string;
    images?: string[];
    answerImages?: string[];
    course?: string;
  };
}>("/api/review", async (req, reply) => {
  // 改错页同样不再选科目：不传 course 时先按勾选科目分流
  const asked = typeof req.body?.course === "string" ? req.body.course.trim() : "";
  let course: CourseRef | null = asked ? requireCourse(asked, reply) : null;
  if (asked && !course) return;
  let question = req.body?.question?.trim() ?? "";
  let myAnswer = req.body?.myAnswer?.trim() ?? "";
  const images = (req.body?.images ?? []).slice(0, 4);
  const answerImages = (req.body?.answerImages ?? []).slice(0, 4);

  try {
    if (!question && images.length > 0) question = await imageTexts(images, "question");
    if (!myAnswer && answerImages.length > 0) {
      myAnswer = await imageTexts(answerImages, "answer");
    }
    if (!question) return reply.code(400).send({ ok: false, error: "题目不能为空" });

    // 未指定科目 → 先分流；判不出就纯模型回答（不引教材、不入错题本）
    let routedSubject: SubjectRoute | null = null;
    if (!course) {
      const routed = await routeToCourse(question);
      course = routed.ref;
      routedSubject = routed.route;
    }
    if (!course) {
      const prof = loadProfile(db, "");
      const r = await askGeneral(question, images, profilePrompt(prof));
      return {
        ok: true,
        mode: "solve",
        course: null,
        subject: routedSubject,
        unclassified: true,
        question,
        myAnswer: myAnswer || undefined,
        view: {
          mode: "solve",
          verdict: "unsolved",
          error_type: "none",
          errorTypeLabel: "只作答",
          cause: "",
          correction: r.answer,
          hints: [],
          related_kps: [],
          references: [],
          source: "model-only",
          bank: null,
          model: r.model,
          ms: r.ms,
          beyond: [],
          uncertain: [],
          maxChapterNo: null,
          guard: "no-progress",
          subject: routedSubject,
          notes: ["这道题不在你勾选的科目里：本次只作答，不引用教材，也不写入错题本。"],
        },
      };
    }

    if (!myAnswer) {
      const prof = loadProfile(db, course.code, course.name);
      const filter = progressFilter(prof);
      const routing = buildRoutingContext(db, { code: course.code, name: course.name });
      const profileText = `${profilePrompt(prof, outlineFor(course))}\n\n${routing.text}`;
      const [r, guess] = await Promise.all([
        solve(
          course.file,
          question,
          CITATION_LIMIT,
          images,
          undefined,
          profileText,
          "full",
          filter,
        ),
        routeQuestion(question, routing).catch(() => ""),
      ]);
      const subject = resolveRoute(
        routing.candidates,
        { code: course.code, name: course.name },
        guess,
      );
      const beyond = await guardProgress(question, r.answer, filter, outlineFor(course));
      // 落库：对话原文 + 结构化 meta（event）。不会话就永远没有习惯抽取的原料。
      const turn = saveTurn(db, {
        course: course.code,
        kind: "solve",
        question,
        answer: r.answer,
        detail: "full",
        source: r.source,
        qno: r.bank?.qno ?? null,
        bank: r.bank,
        model: r.model,
        ms: r.ms,
        citations: r.citations.length,
      });
      enqueueHabitExtraction(db, {
        text: `${question}\n\n${r.answer.slice(0, 800)}`,
        kind: "chat",
        course: course.code,
        sourceType: "solve",
        sourceId: turn.assistantMessageId,
      });
      return {
        ok: true,
        mode: "solve",
        course: course.code,
        subject,
        guard: beyond.guard,
        turn,
        view: {
          mode: "solve",
          verdict: "unsolved",
          error_type: "none",
          errorTypeLabel: "只解题",
          cause: "",
          correction: r.answer,
          hints: [],
          related_kps: [],
          references: r.citations,
          source: r.source,
          bank: r.bank,
          model: r.model,
          ms: r.ms,
          beyond: beyond.beyond,
          uncertain: beyond.uncertain,
          maxChapterNo: prof.maxChapterNo,
          guard: beyond.guard,
          subject,
        },
        question,
      };
    }

    const prof = loadProfile(db, course.code, course.name);
    const filter = progressFilter(prof);
    const routing = buildRoutingContext(db, { code: course.code, name: course.name });
    const profileText = `${profilePrompt(prof, outlineFor(course))}\n\n${routing.text}`;
    const r = await review(
      course.file,
      question,
      myAnswer,
      req.body?.correctAnswer?.trim(),
      [...images, ...answerImages],
      profileText,
      "full",
      filter,
    );
    // 科目分流来自同一份 META（subject_guess），不额外调模型；代码再校验白名单
    const subject = resolveRoute(
      routing.candidates,
      { code: course.code, name: course.name },
      r.subject_guess,
    );
    const turn = saveTurn(db, {
      course: course.code,
      kind: "grade",
      question,
      studentInput: myAnswer,
      answer: r.correction,
      detail: "full",
      citations: r.references.length,
      grade: {
        verdict: r.verdict,
        input_kind: r.input_kind,
        error_type: r.error_type,
        cause: r.cause,
        hints: r.hints,
        related_kps: r.related_kps,
        subject_guess: r.subject_guess,
      },
    });
    // 习惯抽取只用学生自己写的部分：题干 + 他的作答/过程。
    // 把模型答案也喂进去会污染观察（那是我们的措辞，不是他的）。
    enqueueHabitExtraction(db, {
      text: `【题目】${question}\n\n【学生的写法】${myAnswer}`,
      kind: "answer",
      course: course.code,
      sourceType: "review",
      sourceId: turn.assistantMessageId,
    });
    return {
      ok: true,
      mode: "grade",
      course: course.code,
      subject,
      turn,
      view: {
        mode: "grade",
        ...r,
        errorTypeLabel: errorTypeLabel(r.error_type),
        inputKindLabel: INPUT_KIND_LABEL[r.input_kind] ?? r.input_kind,
        subject,
      },
      question,
      myAnswer,
    };
  } catch (e) {
    return reply.code(500).send({ ok: false, error: (e as Error).message });
  }
});

/**
 * 流式解题 / 批改（SSE）。
 *
 * 与非流式 /api/review 的差别只在「怎么把答案交出去」：
 * 判定与引用照旧在开头给出，正文边生成边发，首字通常 3-5 秒到。
 * 老接口保留：脚本与测试仍走它。
 */
app.post<{
  Body: {
    question?: string;
    myAnswer?: string;
    correctAnswer?: string;
    images?: string[];
    answerImages?: string[];
    detail?: "full" | "brief";
    course?: string;
  };
}>("/api/stream", async (req, reply) => {
  const body = req.body ?? {};
  // 科目先解析：出错要按普通 JSON 回 400，不能进 SSE 分支（hijack 之后就没法改了）
  const asked = typeof body.course === "string" ? body.course.trim() : "";
  let course: CourseRef | null = asked ? requireCourse(asked, reply) : null;
  if (asked && !course) return;
  const images = (body.images ?? []).slice(0, 4);
  const answerImages = (body.answerImages ?? []).slice(0, 4);
  const detail: Detail = body.detail === "brief" ? "brief" : "full";

  // 没指定科目：先补文字（路由需要文本），再分流。这一步必须在 hijack 之前，
  // 否则失败时只能吐 SSE 错误，前端拿不到正常 JSON。
  let _routedSubject: SubjectRoute | null = null;
  if (!course) {
    let q = body.question?.trim() ?? "";
    if (!q && images.length > 0) q = await imageTexts(images, "question");
    if (q) {
      const routed = await routeToCourse(q);
      course = routed.ref;
      _routedSubject = routed.route;
    }
  }
  if (!course) {
    // 不在勾选科目内：纯模型回答，不引教材、不写错题本/习惯
    reply.hijack();
    const rawUnclassified = reply.raw;
    rawUnclassified.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const emit = (ev: StreamEvent): void => {
      if (!rawUnclassified.writableEnded) rawUnclassified.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    try {
      let q = body.question?.trim() ?? "";
      if (!q && images.length > 0) q = await imageTexts(images, "question");
      if (!q) {
        emit({ type: "error", message: "题目不能为空" });
      } else {
        const prof = loadProfile(db, "");
        const r = await askGeneral(q, images, profilePrompt(prof));
        emit({
          type: "meta",
          mode: "solve",
          source: "model-only",
          bank: null,
          citations: [],
          model: r.model,
        });
        emit({ type: "delta", text: r.answer });
        emit({
          type: "note",
          text: "这道题不在你勾选的科目里：本次只作答，不引用教材，也不写入错题本。",
        });
        emit({ type: "done", ms: r.ms, model: r.model });
      }
    } catch (e) {
      emit({ type: "error", message: (e as Error).message });
    }
    if (!rawUnclassified.writableEnded) rawUnclassified.end();
    return;
  }

  const prof = loadProfile(db, course.code, course.name);
  const filter = progressFilter(prof);
  const routing = buildRoutingContext(db, { code: course.code, name: course.name });
  const profileText = `${profilePrompt(prof, outlineFor(course))}\n\n${routing.text}`;
  const currentSubject = { code: course.code, name: course.name };

  // 自己接管响应：SSE 必须逐条 flush，不能被 Fastify 的 JSON 序列化包起来
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (ev: StreamEvent): void => {
    if (!raw.writableEnded) raw.write(`data: ${JSON.stringify(ev)}\n\n`);
  };
  const finish = (): void => {
    if (!raw.writableEnded) raw.end();
  };

  try {
    let question = body.question?.trim() ?? "";
    let myAnswer = body.myAnswer?.trim() ?? "";
    if (!question && images.length > 0) question = await imageTexts(images, "question");
    if (!myAnswer && answerImages.length > 0) myAnswer = await imageTexts(answerImages, "answer");
    if (!question) {
      send({ type: "error", message: "题目不能为空" });
      finish();
      return;
    }

    const stream = myAnswer
      ? reviewStream(
          course.file,
          question,
          myAnswer,
          body.correctAnswer?.trim(),
          [...images, ...answerImages],
          profileText,
          detail,
          filter,
        )
      : solveStream(course.file, question, {
          images,
          profileText,
          detail,
          filter,
        });

    // 只解题没有 META，另用一次小模型在后台并行判断科目，不拖慢正文
    const solveRoutePromise = myAnswer ? null : routeQuestion(question, routing).catch(() => "");

    let answerText = "";
    let gradeSnapshot: GradeSnapshot | undefined;
    let bankSnapshot: BankSnapshot | null = null;
    let sourceTag: string | undefined;
    let modelTag: string | undefined;
    let citationCount = 0;
    let subjectRoute: SubjectRoute | null = null;
    for await (const ev of stream) {
      if (raw.destroyed) break; // 用户关了页面就别再烧 token
      if (ev.type === "delta") answerText += ev.text;
      if (ev.type === "grade") {
        gradeSnapshot = {
          verdict: ev.grade.verdict,
          input_kind: ev.grade.input_kind,
          error_type: ev.grade.error_type,
          cause: ev.grade.cause,
          hints: ev.grade.hints,
          related_kps: ev.grade.related_kps,
          subject_guess: ev.grade.subject_guess,
        };
        // 科目分流来自同一份 META，先于正文发出，前端可立刻提示"这题不像当前科目"
        if (!subjectRoute) {
          subjectRoute = resolveRoute(routing.candidates, currentSubject, ev.grade.subject_guess);
          send({ type: "subject", route: subjectRoute });
        }
      }
      if (ev.type === "meta") {
        modelTag = ev.model;
        citationCount = ev.citations.length;
        if (ev.mode === "solve") {
          sourceTag = ev.source;
          bankSnapshot = ev.bank;
        }
      }
      send(ev);
    }

    if (solveRoutePromise && !subjectRoute) {
      subjectRoute = resolveRoute(routing.candidates, currentSubject, await solveRoutePromise);
      send({ type: "subject", route: subjectRoute });
    }

    if (!myAnswer) {
      if (answerText) {
        const beyond = await guardProgress(question, answerText, filter, outlineFor(course));
        if (beyond.beyond.length > 0 || beyond.uncertain.length > 0) {
          send({
            type: "beyond",
            beyond: beyond.beyond,
            uncertain: beyond.uncertain,
            maxChapterNo: prof.maxChapterNo,
          });
        }
        if (beyond.guard === "no-outline") {
          // 章节表缺失时这道闸没生效，必须让用户知道结果不可信
          send({ type: "note", text: "本课程教材库缺少章节号，本次未做进度越界检查" });
        }
      }
    }

    // 落库：只有真的产出正文才存，空回答不进记忆库
    if (answerText.trim()) {
      const turn = saveTurn(db, {
        course: course.code,
        kind: myAnswer ? "grade" : "solve",
        question,
        studentInput: myAnswer || undefined,
        answer: answerText,
        detail,
        source: sourceTag,
        bank: bankSnapshot,
        model: modelTag,
        citations: citationCount,
        grade: gradeSnapshot,
      });
      // 告诉前端这一轮的 id：刷新页面后靠它恢复（前端存 localStorage）
      send({
        type: "turn",
        conversationId: turn.conversationId,
        messageId: turn.assistantMessageId,
      });
      enqueueHabitExtraction(db, {
        text: myAnswer
          ? `【题目】${question}\n\n【学生的写法】${myAnswer}`
          : `${question}\n\n${answerText.slice(0, 800)}`,
        kind: myAnswer ? "answer" : "chat",
        course: course.code,
        sourceType: myAnswer ? "review" : "solve",
        sourceId: turn.assistantMessageId,
      });
      if (gradeSnapshot) console.log(`[stream] 判定已入库 ${turn.assistantMessageId}`);
    }
    finish();
  } catch (e) {
    send({ type: "error", message: (e as Error).message });
    finish();
  }
});

/**
 * 错题本：科目是可选过滤条件。
 * 前端总是带上当前科目传 `course`，脚本/调试不传则看"勾选 AI 辅助"的全部科目——
 * 但统计口径必须和列表一致，否则「总错题 12」却只列出 3 条，用户会怀疑数据丢了。
 *
 * 没勾选 AI 辅助的科目一律读不到：课程存在不等于用户同意让 AI 记录它。
 */
app.get<{ Querystring: { errorType?: string; unresolved?: string; course?: string } }>(
  "/api/mistakes",
  async (req, reply) => {
    const course = req.query.course?.trim().toUpperCase() || undefined;
    if (course && !getSubject(db, course)) {
      return reply
        .code(400)
        .send({ ok: false, error: `科目 ${course} 未登记：先在「科目」页添加` });
    }
    if (course && !isAiSubject(db, course)) {
      return reply.code(403).send({
        ok: false,
        error: `科目 ${course} 未勾选「允许 AI 辅助」，错题本不可用：先到「科目」页勾选`,
      });
    }
    const allowed = aiSubjectCodes(db);
    const scope = course
      ? { courseCode: course }
      : { courseCodes: allowed, includeUnassigned: true };
    return {
      ok: true,
      course: course ?? null,
      mistakes: listMistakes(db, {
        errorType: req.query.errorType,
        onlyUnresolved: req.query.unresolved === "1",
        ...scope,
      }),
      stats: course
        ? mistakeStats(db, course)
        : mistakeStats(db, undefined, { courseCodes: allowed, includeUnassigned: true }),
    };
  },
);

/**
 * 错题本"全部科目"视图：按科目归类，一次返回所有分组。
 *
 * 与 `/api/mistakes` 的分工：那个是"当前科目"的单科视图（统计同口径）；
 * 这个是跨科目视图，保证旧数据（course_code 为 NULL）落在「未归类」组里，
 * 分组条数之和 = 错题总数，不会出现"总数 12 却只看到 3 条"。
 */
app.get<{ Querystring: { errorType?: string; unresolved?: string } }>(
  "/api/mistakes/groups",
  async (req) => {
    const names = new Map<string, string>();
    for (const s of listSubjects(db)) names.set(s.code, s.name);
    const groups = mistakeGroups(
      db,
      (code) => (code == null ? "其他" : (names.get(code) ?? code)),
      {
        errorType: req.query.errorType,
        onlyUnresolved: req.query.unresolved === "1",
        // "全部科目"也只开放勾选 AI 辅助的课；未归类的旧记录仍保留
        courseCodes: aiSubjectCodes(db),
      },
    );
    return {
      ok: true,
      groups,
      total: groups.reduce((n, g) => n + g.stats.total, 0),
    };
  },
);

app.post<{
  Body: {
    title?: string;
    raw_text?: string;
    my_answer?: string;
    correct_answer?: string;
    error_type?: string;
    error_detail?: string;
    kp_codes?: string[];
    course?: string;
    /** 模型预测、但不在勾选科目里的课程名（这条错题会存成"未归类"） */
    predictedCourse?: string;
    /** 用户上传的题目截图（data URL）。有图时错题本优先显示原图 */
    images?: string[];
  };
}>("/api/mistakes", async (req, reply) => {
  const b = req.body ?? {};
  if (!b.title?.trim()) return reply.code(400).send({ ok: false, error: "title 必填" });

  /**
   * 科目校验比别的接口宽松：
   *   - 没传 course = 未归类（模型也判不出科目），照样存，标签里记预测名；
   *   - 传了但**只登记、没建教材库**：也要存——错题是用户财产，
   *     不能因为还没 build:textbook 就把他的改错结果丢掉。
   */
  let courseCode: string | null = null;
  const askedRaw = typeof b.course === "string" ? b.course.trim() : "";
  if (askedRaw) {
    try {
      courseCode = normalizeCourseCode(askedRaw);
    } catch (e) {
      return reply.code(400).send({ ok: false, error: (e as Error).message });
    }
    if (!getSubject(db, courseCode)) {
      return reply
        .code(400)
        .send({ ok: false, error: `科目 ${courseCode} 未登记：先在「科目」页添加` });
    }
    // 错题本只收"用户勾选允许 AI 辅助"的科目：没勾的课不写记忆
    if (!isAiSubject(db, courseCode)) {
      return reply.code(403).send({
        ok: false,
        error: `科目 ${courseCode} 未勾选「允许 AI 辅助」，不能存入错题本：先到「科目」页勾选`,
      });
    }
  }

  const tags: string[] = [];
  const predicted = typeof b.predictedCourse === "string" ? b.predictedCourse.trim() : "";
  if (!courseCode) {
    tags.push("未归类");
    if (predicted) tags.push(`预测:${predicted.slice(0, 40)}`);
  }

  // 原图落盘（artifact）：截图是用户提供的证据，比模型转录的文字更可信
  let artifactId: number | null = null;
  const firstImage = (b.images ?? []).slice(0, 1)[0];
  if (firstImage) {
    try {
      artifactId = saveImageArtifact(db, firstImage, "mistake");
    } catch (e) {
      // 图片存不下不能连错题一起丢掉；文字部分照常保存，但要留下日志
      console.warn(`[mistake] 图片保存失败，仅存文字: ${(e as Error).message}`);
    }
  }

  const id = saveMistake(db, {
    title: b.title.trim(),
    raw_text: b.raw_text ?? null,
    my_answer: b.my_answer ?? null,
    correct_answer: b.correct_answer ?? null,
    error_type: b.error_type ?? null,
    error_detail: b.error_detail ?? null,
    kp_codes: b.kp_codes ?? [],
    tags,
    course_code: courseCode,
    artifact_id: artifactId,
    source: artifactId != null ? "photo" : "text",
  });
  return {
    ok: true,
    id,
    course: courseCode,
    unclassified: courseCode == null,
    hasImage: artifactId != null,
  };
});

/**
 * 错题原图。
 * 前端优先用它渲染题目，转录文字只作为校对/检索用。
 * 只允许读 uploads 目录内的文件：artifact.path 是库里的数据，不能当可信路径直接用。
 */
app.get<{ Params: { id: string } }>("/api/mistakes/:id/image", async (req, reply) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return reply.code(400).send({ ok: false, error: "id 非法" });
  }
  const img = getMistakeImage(db, id);
  if (!img) return reply.code(404).send({ ok: false, error: "这条错题没有截图" });

  const root = resolve(paths.uploads);
  const abs = resolve(img.path);
  if (abs !== root && !abs.startsWith(root + sep)) {
    console.warn(`[mistake] 拒绝读取 uploads 之外的图片: ${abs}`);
    return reply.code(404).send({ ok: false, error: "图片路径不合法" });
  }
  if (!existsSync(abs)) {
    return reply.code(404).send({ ok: false, error: "图片文件已不存在" });
  }
  const ext = abs.slice(abs.lastIndexOf(".") + 1).toLowerCase();
  const type =
    ext === "jpg" || ext === "jpeg"
      ? "image/jpeg"
      : ext === "png" || ext === "webp" || ext === "gif"
        ? `image/${ext}`
        : "application/octet-stream";
  reply.header("Cache-Control", "private, max-age=86400");
  return reply.type(type).send(readFileSync(abs));
});

/** 给旧错题补传截图：把用户手里的原图挂回去，之后卡片就显示图而不是文字 */
app.post<{ Params: { id: string }; Body: { image?: string } }>(
  "/api/mistakes/:id/image",
  async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ ok: false, error: "id 非法" });
    }
    if (!getMistake(db, id)) return reply.code(404).send({ ok: false, error: "错题不存在" });
    const image = req.body?.image;
    if (!image) return reply.code(400).send({ ok: false, error: "image 不能为空" });

    let artifactId: number;
    try {
      artifactId = saveImageArtifact(db, image, "mistake");
    } catch (e) {
      return reply.code(400).send({ ok: false, error: (e as Error).message });
    }
    const ok = attachMistakeImage(db, id, artifactId);
    return ok
      ? { ok: true, id, artifactId }
      : reply.code(404).send({ ok: false, error: "错题不存在" });
  },
);

app.delete<{ Params: { id: string } }>("/api/mistakes/:id", async (req, reply) => {
  const ok = deleteMistake(db, Number(req.params.id));
  return ok ? { ok: true } : reply.code(404).send({ ok: false, error: "不存在" });
});

app.post<{ Params: { id: string }; Body: { correct?: boolean; myAnswer?: string } }>(
  "/api/mistakes/:id/attempt",
  async (req, reply) => {
    const id = Number(req.params.id);
    if (!getMistake(db, id)) return reply.code(404).send({ ok: false, error: "不存在" });
    const r = addAttempt(db, id, Boolean(req.body?.correct), req.body?.myAnswer);
    return { ok: true, ...r };
  },
);

// ───────────────────────── M2：学习进度 / 学生画像 ─────────────────────────

/** 画像 + 进度总览，前端「我的进度」页用 */
app.get<{ Querystring: { course?: string } }>("/api/progress", async (req, reply) => {
  const course = requireAiCourse(req.query.course, reply);
  if (!course) return;
  return { ok: true, ...profileSummary(db, course.code), course: course.code };
});

/** 设置单章状态 */
app.post<{
  Body: { course?: string; chapterNo?: number; chapterTitle?: string; status?: ChapterStatus };
}>("/api/progress", async (req, reply) => {
  const b = req.body ?? {};
  const course = requireAiCourse(b.course, reply);
  if (!course) return;
  const no = Number(b.chapterNo);
  const status = (b.status ?? "done") as ChapterStatus;
  if (!Number.isInteger(no) || no < 1 || no > 40) {
    return reply.code(400).send({ ok: false, error: "chapterNo 必须是 1-40 的整数" });
  }
  if (!["not_started", "learning", "done"].includes(status)) {
    return reply.code(400).send({ ok: false, error: "status 非法" });
  }
  setChapterProgress(db, {
    courseCode: course.code,
    chapterNo: no,
    chapterTitle: b.chapterTitle ?? null,
    status,
    source: "manual",
    evidence: "用户在界面上设置",
    confidence: 1,
  });
  return { ok: true, ...profileSummary(db, course.code) };
});

/** 清空一门课的全部章节进度（整行删除，不写一堆 not_started 空行） */
app.delete<{ Querystring: { course?: string } }>("/api/progress", async (req, reply) => {
  const course = requireAiCourse(req.query.course, reply);
  if (!course) return;
  const removed = clearChapterProgress(db, course.code);
  return { ok: true, removed, ...profileSummary(db, course.code), course: course.code };
});

/** 一句话把进度推到第 N 章（第 1..N 章标 done） */
app.post<{ Body: { course?: string; chapterNo?: number } }>(
  "/api/progress/advance",
  async (req, reply) => {
    const course = requireAiCourse(req.body?.course, reply);
    if (!course) return;
    const no = Number(req.body?.chapterNo);
    if (!Number.isInteger(no) || no < 1 || no > 40) {
      return reply.code(400).send({ ok: false, error: "chapterNo 必须是 1-40 的整数" });
    }
    advanceTo(db, course.code, no);
    db.prepare("INSERT INTO event (type, ref_type, payload) VALUES (?,?,?)").run(
      "progress_set",
      "chapter_progress",
      JSON.stringify({ course: course.code, chapterNo: no }),
    );
    return { ok: true, ...profileSummary(db, course.code) };
  },
);

/** 当前注入给模型的画像原文，用于肉眼核对"模型到底看到了什么" */
app.get<{ Querystring: { course?: string } }>("/api/profile/prompt", async (req, reply) => {
  const course = requireAiCourse(req.query.course, reply);
  if (!course) return;
  return {
    ok: true,
    course: course.code,
    prompt: profilePrompt(loadProfile(db, course.code), outlineFor(course)),
  };
});

/**
 * 进度页的章节清单：**只列教材库里真实存在的章节**（没有的章不出现，也不显示"未收录"）。
 * 名称优先用用户改过的，其次教材原名；状态来自 chapter_progress，没有行就是未学。
 */
function chapterListOf(course: CourseRef): Array<{
  chapter_no: number;
  chapter_title: string;
  library_title: string;
  edited: boolean;
  status: string;
}> {
  const outline = outlineFor(course);
  const progress = new Map(
    listChapterProgress(db, course.code).map((p) => [Number(p.chapter_no), p.status]),
  );
  return outline.map((o) => ({
    chapter_no: o.chapterNo,
    chapter_title: o.title,
    library_title: o.libraryTitle,
    edited: o.edited,
    status: progress.get(o.chapterNo) ?? "not_started",
  }));
}

/** 章节清单：用于前端渲染进度条（含未开始章节） */
app.get<{ Querystring: { course?: string } }>("/api/progress/chapters", async (req, reply) => {
  const course = requireAiCourse(req.query.course, reply);
  if (!course) return;
  return { ok: true, course: course.code, chapters: chapterListOf(course) };
});

/**
 * 改章节名：用户按"市面上约定俗成的叫法"重命名，写 learner.db 的 chapter_name。
 * 只允许改教材库里真实存在的章；空标题 = 删除覆盖、恢复原名。
 * 改完立刻失效章节缓存，下一次问答/越界检查用的就是新名字。
 */
app.put<{ Params: { no: string }; Body: { course?: string; title?: string } }>(
  "/api/progress/chapters/:no",
  async (req, reply) => {
    const course = requireAiCourse(req.body?.course, reply);
    if (!course) return;
    const no = Number(req.params.no);
    if (!Number.isInteger(no) || no < 1 || no > 40) {
      return reply.code(400).send({ ok: false, error: "chapterNo 必须是 1-40 的整数" });
    }
    if (!outlineFor(course).some((o) => o.chapterNo === no)) {
      return reply
        .code(400)
        .send({ ok: false, error: `教材库里没有第 ${no} 章，只能修改真实存在的章节` });
    }
    try {
      if (!String(req.body?.title ?? "").trim()) {
        clearChapterName(db, course.code, no);
      } else {
        setChapterName(db, course.code, no, req.body?.title);
      }
    } catch (e) {
      return reply.code(400).send({ ok: false, error: (e as Error).message });
    }
    invalidateOutline(course);
    return { ok: true, course: course.code, chapters: chapterListOf(course) };
  },
);

/**
 * 全部科目的进度总览（"我的进度"页顶部的科目卡片）。
 *
 * 每门课各自一条：已学章节数 / 当前章 / 断层 / 错题数 / 习惯数。
 * 不做加权合并——两门课的"第 5 章"完全不是一回事，合成一个总进度只会误导。
 */
app.get("/api/progress/overview", async () => {
  // 总览也只列"用户勾选允许 AI 辅助"的科目：没勾的课不该出现在进度页
  const subjects = listSubjects(db).filter((s) => s.active && s.ai_enabled);
  return {
    ok: true,
    subjects,
    totals: {
      subjects: subjects.length,
      ready: subjects.filter((s) => s.textbook_ready).length,
      mistakes: subjects.reduce((n, s) => n + s.mistakes.total, 0),
      unresolved: subjects.reduce((n, s) => n + s.mistakes.unresolved, 0),
    },
  };
});

// ───────────────────────── M2：习惯抽取 ─────────────────────────

/** 全部习惯（含被否决与未达阈值的），供界面展示与用户核对 */
app.get<{ Querystring: { course?: string; scope?: string } }>("/api/habits", async (req, reply) => {
  const course = requireCourse(req.query.course, reply);
  if (!course) return;
  // scope=course：只要"属于这门课"的习惯（进度页用——共用习惯不在这里重复展示）
  const onlyCourse = req.query.scope === "course";
  const rows = db
    .prepare(
      `SELECT h.*, (SELECT COUNT(*) FROM habit_evidence e WHERE e.habit_id = h.id) AS ev_rows
       FROM habit h
       WHERE ${onlyCourse ? "h.course_code = ?" : "(h.course_code IS NULL OR h.course_code = ?)"}
       ORDER BY h.status, h.dimension, h.confidence DESC`,
    )
    .all(course.code) as unknown as Array<Record<string, unknown>>;
  const injectable = new Set(injectableHabits(db, course.code).map((h) => h.id));
  return {
    ok: true,
    course: course.code,
    scope: onlyCourse ? "course" : "all",
    thresholds: { minEvidence: INJECT_MIN_EVIDENCE, minConfidence: INJECT_MIN_CONFIDENCE },
    habits: rows.map((r) => ({ ...r, injectable: injectable.has(Number(r.id)) })),
  };
});

/** 从一段材料（图片转录/代码/对话）抽取习惯，写事件后重算 */
app.post<{
  Body: {
    course?: string;
    text?: string;
    kind?: "code" | "image" | "chat" | "answer";
    sourceType?: string;
    sourceId?: number;
  };
}>("/api/habits/extract", async (req, reply) => {
  const course = requireCourse(req.body?.course, reply);
  if (!course) return;
  const text = req.body?.text?.trim();
  if (!text || text.length < 30) {
    return reply.code(400).send({ ok: false, error: "材料太短，至少 30 字才有观察价值" });
  }
  try {
    const r = await extractHabits(db, {
      text,
      kind: req.body?.kind ?? "chat",
      course: course.code,
      sourceType: req.body?.sourceType ?? "message",
      sourceId: req.body?.sourceId ?? null,
    });
    return { ok: true, ...r };
  } catch (e) {
    return reply.code(500).send({ ok: false, error: (e as Error).message });
  }
});

/** 用户否决一条习惯：永不注入，但保留证据 */
app.post<{ Params: { id: string } }>("/api/habits/:id/reject", async (req, reply) => {
  try {
    rejectHabit(db, Number(req.params.id));
    return { ok: true };
  } catch (e) {
    return reply.code(400).send({ ok: false, error: (e as Error).message });
  }
});

/** 重放事件重建结论表（幂等），用于改动证据后校正 */
app.post("/api/habits/rebuild", async () => ({
  ok: true,
  ...rebuildHabitFromEvents(db),
}));

// ───────────────────────── 用户自述：学习习惯 / 日程偏好 / 资源 ─────────────────────────

/**
 * 用户自己填一条习惯或偏好。写 source='manual'，一条就注入（不受证据阈值限制）。
 * course 只在错题本 / 举一反三 / 进度三个界面传；其他界面不传 = 个人共用习惯。
 */
app.post<{
  Body: { dimension?: string; key?: string; value?: string; course?: string; context?: string };
}>("/api/habits/manual", async (req, reply) => {
  const b = req.body ?? {};
  const input = {
    dimension: (b.dimension ?? "") as never,
    key: b.key ?? "",
    value: b.value ?? "",
    course_code: b.course?.trim().toUpperCase() || null,
    context: b.context ?? null,
  };
  const bad = validateManualHabit(input);
  if (bad) return reply.code(400).send({ ok: false, error: bad });
  const id = saveManualHabit(db, input);
  return {
    ok: true,
    id,
    scope: input.course_code ? `仅 ${input.course_code}` : "个人共用",
    message: `已记录：${input.key} → ${input.value}`,
  };
});

/** 自述习惯清单（可按科目看，含共用部分） */
app.get<{ Querystring: { course?: string } }>("/api/habits/manual", async (req) => ({
  ok: true,
  habits: listManualHabits(db, req.query.course?.toUpperCase() || null),
}));

/** 修改一条自述习惯（只有自己填的能改；模型推断的只能否决） */
app.patch<{
  Params: { id: string };
  Body: {
    dimension?: string;
    key?: string;
    value?: string;
    context?: string | null;
    course?: string | null;
  };
}>("/api/habits/manual/:id", async (req, reply) => {
  const b = req.body ?? {};
  try {
    const row = updateManualHabit(db, Number(req.params.id), {
      dimension: b.dimension as never,
      key: b.key,
      value: b.value,
      context: b.context,
      course_code: b.course === undefined ? undefined : b.course?.trim().toUpperCase() || null,
    });
    return { ok: true, habit: row, message: `已更新：${row.key} → ${row.value}` };
  } catch (e) {
    return reply.code(400).send({ ok: false, error: (e as Error).message });
  }
});

/** 删掉填错的习惯 */
app.delete<{ Params: { id: string } }>("/api/habits/manual/:id", async (req, reply) => {
  const ok = deleteManualHabit(db, Number(req.params.id));
  return ok ? { ok: true } : reply.code(404).send({ ok: false, error: "不存在或不是自述习惯" });
});

/** 偏好时段：日程排期直接读这个（8:00-9:00 写代码 → 优先排代码类任务） */
app.get<{ Querystring: { course?: string } }>("/api/habits/windows", async (req) => ({
  ok: true,
  windows: listStudyWindows(db, req.query.course?.toUpperCase() || null),
}));

/**
 * 课下投入占比（避开水课）：排期据此分配每天的学习时长。
 * 单独一对接口，是因为它是"每门课一个 0-1 的数"，用通用的 key/value 表单填起来太反人类。
 */
app.get("/api/habits/investment", async () => {
  const weights = loadPlanWeights(db);
  const subjects = listSubjects(db).map((s) => ({
    code: s.code,
    name: s.name,
    textbook_ready: s.textbook_ready,
    weight: weights.find((w) => w.course_code === s.code.toUpperCase())?.weight ?? null,
  }));
  return { ok: true, subjects, weights };
});

app.put<{ Body: { course?: string; weight?: number | string } }>(
  "/api/habits/investment",
  async (req, reply) => {
    const code = req.body?.course?.trim().toUpperCase();
    if (!code) return reply.code(400).send({ ok: false, error: "course 必填" });
    const raw = req.body?.weight;
    // 允许 0-1 的小数、0-100 的百分数，或"高/中/低/水"这类词
    const num = typeof raw === "number" ? raw : Number(String(raw ?? "").replace("%", ""));
    const value =
      Number.isFinite(num) && num > 1 ? Math.min(1, num / 100) : Number.isFinite(num) ? num : null;
    const text = value != null ? String(Math.max(0, Math.min(1, value))) : String(raw ?? "");
    const parsed = parseInvestment(text);
    if (parsed == null) {
      return reply
        .code(400)
        .send({ ok: false, error: "weight 无法解析（给 0-1、0-100 或 高/中/低/水）" });
    }
    const subject = listSubjects(db).find((s) => s.code.toUpperCase() === code);
    saveManualHabit(db, {
      dimension: "investment",
      key: subject?.name ?? code,
      value: String(parsed),
      course_code: code,
    });
    return {
      ok: true,
      course: code,
      weight: parsed,
      message:
        parsed === 0
          ? `${subject?.name ?? code} 已标记为水课：排期不再给它分时间`
          : `${subject?.name ?? code} 投入占比 ${Math.round(parsed * 100)}%`,
    };
  },
);

/** 资源：正在看的网课 / 在用的教辅；本地没有的标 missing，走上传流程（预留） */
app.post<{ Body: ResourceInput & { course?: string } }>("/api/resources", async (req, reply) => {
  const b = req.body ?? ({} as ResourceInput);
  const input: ResourceInput = {
    course_code: (b.course ?? b.course_code ?? null) || null,
    kind: b.kind,
    title: b.title,
    url: b.url ?? null,
    local_status: b.local_status ?? "unknown",
    progress: b.progress ?? null,
    note: b.note ?? null,
  };
  const bad = validateResource(input);
  if (bad) return reply.code(400).send({ ok: false, error: bad });
  const id = upsertResource(db, input);
  return { ok: true, id, message: `已记录资源：${input.title}` };
});

app.get<{ Querystring: { course?: string } }>("/api/resources", async (req) => {
  const course = req.query.course?.toUpperCase() || null;
  return {
    ok: true,
    resources: listResources(db, course),
    missing: missingResources(db, course),
  };
});

app.delete<{ Params: { id: string } }>("/api/resources/:id", async (req, reply) => {
  const ok = deleteResource(db, Number(req.params.id));
  return ok ? { ok: true } : reply.code(404).send({ ok: false, error: "不存在" });
});

/**
 * 习惯抽取队列状态：前端/排查都用得上。
 * runs = 最近几次抽取尝试（成功/失败都记），用来解释"为什么还没有习惯"：
 * 是没材料、材料太短、还是模型看完觉得证据不足。
 */
app.get("/api/habits/status", async () => ({
  ok: true,
  ...habitQueueState(),
  runs: recentHabitRuns(db, 8),
}));

/**
 * 用「行为摘要」刷新习惯：日程、错题、进度、活跃时段。
 * 投递即返回（后台排队抽），不等模型。
 */
app.post<{ Body: { course?: string; days?: number } }>(
  "/api/habits/refresh",
  async (req, reply) => {
    const course = requireCourse(req.body?.course, reply);
    if (!course) return;
    const days = Number(req.body?.days ?? 30);
    const r = refreshHabitsFromActivity(db, course.code, Number.isFinite(days) ? days : 30);
    return { ok: true, course: course.code, ...r, queue: habitQueueState() };
  },
);

// ───────────────────────── M2：学习路径的科目范围（预检） ─────────────────────────
/**
 * "学习路径要不要调用多科目知识库"的预检。
 *
 * 只做判断，不生成路径：返回这次会打开哪些教材库、每科知识库是否就绪、
 * 每科自己的门控集合有几章。前端据此在生成路径前提示"DS 还没建库"，
 * 后续的完整 roadmap 生成直接复用同一个 scope（scopeSources 就是检索入参）。
 */
app.post<{ Body: { course?: string; courses?: string[]; intent?: CourseIntent } }>(
  "/api/roadmap/scope",
  async (req) => {
    const body = req.body ?? {};
    const intent: CourseIntent = body.intent && INTENT_LABEL[body.intent] ? body.intent : "roadmap";
    const scope = planCourseScope(db, {
      intent,
      course: body.course,
      courseCodes: body.courses,
    });
    const sources = scopeSources(db, scope);
    return {
      ok: true,
      ...scope,
      intentLabel: INTENT_LABEL[intent],
      /** 实际检索入参：每个库 + 该库自己的已学章节门控（null = 该科还没设进度） */
      retrieval: sources.map((s, i) => ({
        code: scope.sources[i]!.code,
        file: s.file,
        gatedChapters: s.filter ? s.filter.size : null,
      })),
    };
  },
);

// ───────────────────────── 对话记录（持久化） ─────────────────────────

/** 最近若干轮（用于「上次结果」与历史回看） */
app.get<{ Querystring: { course?: string; limit?: string } }>("/api/turns", async (req, reply) => {
  const course = requireCourse(req.query.course, reply);
  if (!course) return;
  const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 20) || 20));
  return { ok: true, course: course.code, turns: listTurns(db, course.code, limit) };
});

/** 单轮详情：刷新页面后前端拿它恢复上一次结果 */
app.get<{ Params: { id: string } }>("/api/turns/:id", async (req, reply) => {
  const turn = getTurn(db, Number(req.params.id));
  if (!turn) return reply.code(404).send({ ok: false, error: "没有这一轮记录" });
  return { ok: true, turn };
});

// ───────────────────────── 启动 ─────────────────────────

/** 本机所有可用于局域网访问的 IPv4（跳过回环与虚拟适配器） */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== "IPv4" || ni.internal) continue;
      if (/^(169\.254\.|198\.18\.)/.test(ni.address)) continue; // 自动私有地址/测试网段
      out.push(ni.address);
    }
  }
  return [...new Set(out)];
}

const distDir = resolve(paths.data, "../web/dist");

async function main(): Promise<void> {
  if (existsSync(distDir)) {
    await app.register(fastifyStatic, { root: distDir, prefix: "/" });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api")) {
        return reply.code(404).send({ error: "not found", url: req.url });
      }
      return reply.sendFile("index.html");
    });
    app.log.info(`静态前端: ${distDir}`);
  } else {
    app.log.warn(`未找到 ${distDir}，请先运行 npm run build:web`);
  }

  const port = Number(process.env.PORT ?? 8787);
  // 默认只监听本机。要让同一局域网的人看，设 HOST=0.0.0.0（见 README「分享给别人看」）。
  const host = process.env.HOST ?? "127.0.0.1";
  await app.listen({ port, host });
  app.log.info(`本机打开 http://127.0.0.1:${port}/`);

  // 行为摘要 → 习惯：启动后跑一次，之后每 30 分钟一次。
  // fire-and-forget：抽取在后台排队，不挡请求；失败只记日志。
  const refreshAllHabits = (): void => {
    try {
      // 教材库是科目存在性的第一来源：先同步再按科目刷习惯
      const sync = syncSubjectsFromTextbooks(db);
      if (sync.added.length > 0)
        app.log.info(`[subject] 自动登记教材库科目：${sync.added.join("、")}`);
      for (const c of listSubjects(db)) {
        if (!c.textbook_ready) continue; // 还没建库的科目没有教材可讲，不刷行为摘要
        const r = refreshHabitsFromActivity(db, c.code);
        if (r.queued) app.log.info(`[habit] 行为摘要已投递（${c.code}）`);
      }
    } catch (e) {
      app.log.warn(`[habit] 行为摘要刷新失败：${(e as Error).message}`);
    }
  };
  setTimeout(refreshAllHabits, 15_000).unref();
  setInterval(refreshAllHabits, 30 * 60_000).unref();

  if (host !== "127.0.0.1" && host !== "localhost") {
    for (const ip of lanAddresses()) app.log.info(`局域网可访问 http://${ip}:${port}/`);
    app.log.warn(
      "⚠ 没有登录验证：任何能打开该地址的人都能看到本机的对话、错题原文与上传文件。" +
        "演示结束请把 HOST 改回 127.0.0.1。",
    );
  }
}

const shutdown = async (): Promise<void> => {
  await app.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

void main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});

export { app };
