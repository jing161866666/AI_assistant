import "dotenv/config";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply } from "fastify";
import { getLearnerDb, inspectTables, listTextbookDbs, openTextbookDb, paths } from "./db/index.js";
import { checkEnv } from "./llm/models.js";
import {
  advanceTo,
  type ChapterStatus,
  listChapterProgress,
  setChapterProgress,
} from "./memory/chapter-progress.js";
import {
  extractHabits,
  INJECT_MIN_CONFIDENCE,
  INJECT_MIN_EVIDENCE,
  injectableHabits,
  rebuildHabitFromEvents,
  rejectHabit,
} from "./memory/habit-extract.js";
import {
  addAttempt,
  deleteMistake,
  getMistake,
  listMistakes,
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
  ask,
  CITATION_LIMIT,
  type Detail,
  errorTypeLabel,
  INPUT_KIND_LABEL,
  review,
  solve,
} from "./rag/answer.js";
import { BANK_TITLE, bankSize } from "./rag/bank.js";
import { type ChapterOutlineItem, listChapterOutline } from "./rag/chapter-outline.js";
import { guardProgress } from "./rag/progress-guard.js";
import { textbookInfo } from "./rag/search.js";
import { reviewStream, type StreamEvent, solveStream } from "./rag/stream.js";
import {
  conflictsFor,
  createSchedule,
  dateOfWeek,
  deleteSchedule,
  expandOccurrences,
  getActiveTerm,
  getSchedule,
  listCapacity,
  listPreferences,
  listSchedule,
  listTeachingDays,
  listTermEvents,
  type NewScheduleInput,
  planStudy,
  resolveWeek,
  updateSchedule,
} from "./schedule/service.js";
import { runTool } from "./schedule/tools.js";
import { extractImage } from "./vision/extract.js";

const app = Fastify({
  logger: { level: "info" },
  // 图片以 base64 传入，默认 1MB 不够
  bodyLimit: 24 * 1024 * 1024,
});
const db = getLearnerDb();

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
    features: { stream: true, course: true, bank: true },
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

app.get("/api/subjects", async () => ({
  subjects: db.prepare("SELECT * FROM subject WHERE active = 1").all(),
}));

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

// ───────────────────────── 排期建议 ─────────────────────────

app.post<{ Body: { week?: number; perDayMinutes?: number } }>("/api/plan", async (req) => {
  const term = getActiveTerm(db);
  const week = Number(req.body?.week ?? 1);
  const perDay = Number(req.body?.perDayMinutes ?? 120);
  const from = dateOfWeek(term.start_date, week, 1);
  const to = dateOfWeek(term.start_date, week, 7);
  const blocks = planStudy(db, { from, to, perDayMinutes: perDay });
  return {
    blocks,
    totalMinutes: blocks.reduce((s, b) => s + b.minutes, 0),
    perDayMinutes: perDay,
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
  return Object.prototype.hasOwnProperty.call(b, k);
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

const courseCache = new Map<string, CourseRef>();
const outlineCache = new Map<string, ChapterOutlineItem[]>();

/** 读教材库自报的科目信息；库损坏或缺少 course 表时返回 null */
function readCourse(file: string): CourseRef | null {
  try {
    const tdb = openTextbookDb(file);
    try {
      const row = tdb.prepare("SELECT code, name FROM course LIMIT 1").get() as
        | { code: string; name: string }
        | undefined;
      const chapters = Number(
        (
          tdb.prepare("SELECT COUNT(*) AS c FROM chapter WHERE chapter_no IS NOT NULL").get() as {
            c: number;
          }
        ).c,
      );
      const code = (row?.code ?? file.replace(/^course-/, "").replace(/\.db$/, "")).toUpperCase();
      return { code, file, name: row?.name ?? code, chapters };
    } finally {
      tdb.close();
    }
  } catch {
    return null;
  }
}

/** 全部可用科目（每个教材库一个） */
function listCourses(): CourseRef[] {
  const out: CourseRef[] = [];
  for (const file of listTextbookDbs()) {
    const ref = courseCache.get(file) ?? readCourse(file);
    if (!ref) continue;
    courseCache.set(file, ref);
    out.push(ref);
  }
  return out.sort((a, b) => a.code.localeCompare(b.code));
}

/** 教材真实章节表：越界检查的依据（属于先验知识，不靠模型猜），按库缓存 */
function outlineFor(file: string): ChapterOutlineItem[] {
  const hit = outlineCache.get(file);
  if (hit) return hit;
  const outline = listChapterOutline(file);
  outlineCache.set(file, outline);
  return outline;
}

/**
 * 解析并校验请求里的科目。失败时已写好 400 响应，调用方 `if (!course) return;` 即可。
 */
function requireCourse(raw: unknown, reply: FastifyReply): CourseRef | null {
  const asked = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  const code = asked || ENV_COURSE;
  if (!code) {
    void reply.code(400).send({
      ok: false,
      error: "请先选择科目：请求里带 course（可选值见 GET /api/courses）",
    });
    return null;
  }
  const file = `course-${code.toLowerCase()}.db`;
  if (!existsSync(resolve(paths.textbook, file))) {
    void reply.code(400).send({ ok: false, error: `未知科目：${code}` });
    return null;
  }
  const ref = courseCache.get(file) ?? readCourse(file) ?? { code, file, name: code, chapters: 0 };
  courseCache.set(file, ref);
  return ref;
}

/** 可用科目清单：前端据此渲染科目选择器 */
app.get("/api/courses", async () => ({
  ok: true,
  /** .env 里显式配置的默认科目；没配则为 null（前端自己记用户选过的） */
  defaultCourse: ENV_COURSE || null,
  courses: listCourses(),
}));

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
app.post<{ Body: { image?: string; kind?: "question" | "answer" } }>(
  "/api/extract-image",
  async (req, reply) => {
    const image = req.body?.image;
    if (!image) return reply.code(400).send({ ok: false, error: "image 不能为空" });
    try {
      const r = await extractImage(db, image, req.body?.kind ?? "question");
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
    const course = requireCourse(req.body?.course, reply);
    if (!course) return;
    let question = req.body?.question?.trim() ?? "";
    const images = (req.body?.images ?? []).slice(0, 4);
    try {
      // 只有拿不到文字时才转录（转录用于检索）；有文字时原图直接交给推理模型
      if (!question && images.length > 0) {
        question = await imageTexts(images, "question");
      }
      if (!question) return reply.code(400).send({ ok: false, error: "问题或图片至少给一个" });
      if (question.length > 8000) return reply.code(400).send({ ok: false, error: "内容过长" });
      const prof = loadProfile(db, course.code);
      const filter = progressFilter(prof);
      const r = await ask(
        course.file,
        question,
        CITATION_LIMIT,
        images,
        profilePrompt(prof),
        filter,
      );
      const beyond = await guardProgress(question, r.answer, filter, outlineFor(course.file));
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
        }),
      );
      return {
        ok: true,
        ...r,
        course: course.code,
        guard: beyond.guard,
        question,
        beyond: beyond.beyond,
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
  const course = requireCourse(req.body?.course, reply);
  if (!course) return;
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

    if (!myAnswer) {
      const prof = loadProfile(db, course.code);
      const filter = progressFilter(prof);
      const r = await solve(
        course.file,
        question,
        CITATION_LIMIT,
        images,
        undefined,
        profilePrompt(prof),
        "full",
        filter,
      );
      const beyond = await guardProgress(question, r.answer, filter, outlineFor(course.file));
      db.prepare("INSERT INTO event (type, ref_type, payload) VALUES (?,?,?)").run(
        "solve",
        "textbook",
        JSON.stringify({ course: course.code, q: question.slice(0, 120) }),
      );
      return {
        ok: true,
        mode: "solve",
        course: course.code,
        guard: beyond.guard,
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
          maxChapterNo: prof.maxChapterNo,
          guard: beyond.guard,
        },
        question,
      };
    }

    const prof = loadProfile(db, course.code);
    const filter = progressFilter(prof);
    const r = await review(
      course.file,
      question,
      myAnswer,
      req.body?.correctAnswer?.trim(),
      [...images, ...answerImages],
      profilePrompt(prof),
      "full",
      filter,
    );
    return {
      ok: true,
      mode: "grade",
      course: course.code,
      view: {
        mode: "grade",
        ...r,
        errorTypeLabel: errorTypeLabel(r.error_type),
        inputKindLabel: INPUT_KIND_LABEL[r.input_kind] ?? r.input_kind,
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
  const course = requireCourse(body.course, reply);
  if (!course) return;
  const images = (body.images ?? []).slice(0, 4);
  const answerImages = (body.answerImages ?? []).slice(0, 4);
  const detail: Detail = body.detail === "brief" ? "brief" : "full";
  const prof = loadProfile(db, course.code);
  const filter = progressFilter(prof);

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
          profilePrompt(prof),
          detail,
          filter,
        )
      : solveStream(course.file, question, {
          images,
          profileText: profilePrompt(prof),
          detail,
          filter,
        });

    let answerText = "";
    for await (const ev of stream) {
      if (raw.destroyed) break; // 用户关了页面就别再烧 token
      if (ev.type === "delta") answerText += ev.text;
      send(ev);
    }

    if (!myAnswer) {
      db.prepare("INSERT INTO event (type, ref_type, payload) VALUES (?,?,?)").run(
        "solve",
        "textbook",
        JSON.stringify({ course: course.code, q: question.slice(0, 120) }),
      );
      if (answerText) {
        const beyond = await guardProgress(question, answerText, filter, outlineFor(course.file));
        if (beyond.beyond.length > 0) {
          send({ type: "beyond", beyond: beyond.beyond, maxChapterNo: prof.maxChapterNo });
        }
        if (beyond.guard === "no-outline") {
          // 章节表缺失时这道闸没生效，必须让用户知道结果不可信
          send({ type: "note", text: "本课程教材库缺少章节号，本次未做进度越界检查" });
        }
      }
    }
    finish();
  } catch (e) {
    send({ type: "error", message: (e as Error).message });
    finish();
  }
});

app.get<{ Querystring: { errorType?: string; unresolved?: string } }>(
  "/api/mistakes",
  async (req) => ({
    ok: true,
    mistakes: listMistakes(db, {
      errorType: req.query.errorType,
      onlyUnresolved: req.query.unresolved === "1",
    }),
    stats: mistakeStats(db),
  }),
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
  };
}>("/api/mistakes", async (req, reply) => {
  const b = req.body ?? {};
  const course = requireCourse(b.course, reply);
  if (!course) return;
  if (!b.title?.trim()) return reply.code(400).send({ ok: false, error: "title 必填" });
  const id = saveMistake(db, {
    title: b.title.trim(),
    raw_text: b.raw_text ?? null,
    my_answer: b.my_answer ?? null,
    correct_answer: b.correct_answer ?? null,
    error_type: b.error_type ?? null,
    error_detail: b.error_detail ?? null,
    kp_codes: b.kp_codes ?? [],
    course_code: course.code,
  });
  return { ok: true, id, course: course.code };
});

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
  const course = requireCourse(req.query.course, reply);
  if (!course) return;
  return { ok: true, ...profileSummary(db, course.code), course: course.code };
});

/** 设置单章状态 */
app.post<{
  Body: { course?: string; chapterNo?: number; chapterTitle?: string; status?: ChapterStatus };
}>("/api/progress", async (req, reply) => {
  const b = req.body ?? {};
  const course = requireCourse(b.course, reply);
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

/** 一句话把进度推到第 N 章（第 1..N 章标 done） */
app.post<{ Body: { course?: string; chapterNo?: number } }>(
  "/api/progress/advance",
  async (req, reply) => {
    const course = requireCourse(req.body?.course, reply);
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
  const course = requireCourse(req.query.course, reply);
  if (!course) return;
  return { ok: true, course: course.code, prompt: profilePrompt(loadProfile(db, course.code)) };
});

/** 章节清单：用于前端渲染进度条（含未开始章节） */
app.get<{ Querystring: { course?: string } }>("/api/progress/chapters", async (req, reply) => {
  const course = requireCourse(req.query.course, reply);
  if (!course) return;
  const rows = listChapterProgress(db, course.code);
  return { ok: true, course: course.code, chapters: rows };
});

// ───────────────────────── M2：习惯抽取 ─────────────────────────

/** 全部习惯（含被否决与未达阈值的），供界面展示与用户核对 */
app.get<{ Querystring: { course?: string } }>("/api/habits", async (req, reply) => {
  const course = requireCourse(req.query.course, reply);
  if (!course) return;
  const rows = db
    .prepare(
      `SELECT h.*, (SELECT COUNT(*) FROM habit_evidence e WHERE e.habit_id = h.id) AS ev_rows
       FROM habit h
       WHERE h.course_code IS NULL OR h.course_code = ?
       ORDER BY h.status, h.dimension, h.confidence DESC`,
    )
    .all(course.code) as unknown as Array<Record<string, unknown>>;
  const injectable = new Set(injectableHabits(db, course.code).map((h) => h.id));
  return {
    ok: true,
    course: course.code,
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
