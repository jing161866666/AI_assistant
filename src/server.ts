import "dotenv/config";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { getLearnerDb, inspectTables, listTextbookDbs, paths } from "./db/index.js";
import { checkEnv } from "./llm/models.js";
import {
  advanceTo,
  type ChapterStatus,
  listChapterProgress,
  setChapterProgress,
} from "./memory/chapter-progress.js";
import {
  addAttempt,
  deleteMistake,
  getMistake,
  listMistakes,
  mistakeStats,
  saveMistake,
} from "./memory/mistakes.js";
import { loadProfile, profilePrompt, profileSummary } from "./memory/profile.js";
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
import { listChapterOutline } from "./rag/chapter-outline.js";
import { guardProgress } from "./rag/progress-guard.js";
import { textbookInfo } from "./rag/search.js";
import { reviewStream, type StreamEvent, solveStream } from "./rag/stream.js";
import {
  dateOfWeek,
  expandOccurrences,
  getActiveTerm,
  listCapacity,
  listPreferences,
  listTeachingDays,
  listTermEvents,
  planStudy,
  resolveWeek,
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

const TEXTBOOK_FILE = process.env.TEXTBOOK_FILE ?? "course-phy2.db";
/** M2：当前主修科目。多科目时由前端勾选后传入，这里给默认值 */
const COURSE_CODE = process.env.COURSE_CODE ?? "PHY2";
/** 教材真实章节表：越界检查的依据（属于先验知识，不靠模型猜） */
const CHAPTER_OUTLINE = listChapterOutline(TEXTBOOK_FILE);

app.get("/api/textbook", async () => ({
  ...textbookInfo(TEXTBOOK_FILE),
  bank: { title: BANK_TITLE, questions: bankSize(TEXTBOOK_FILE) },
}));

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

app.post<{ Body: { question?: string; images?: string[] } }>("/api/ask", async (req, reply) => {
  let question = req.body?.question?.trim() ?? "";
  const images = (req.body?.images ?? []).slice(0, 4);
  try {
    // 只有拿不到文字时才转录（转录用于检索）；有文字时原图直接交给推理模型
    if (!question && images.length > 0) {
      question = await imageTexts(images, "question");
    }
    if (!question) return reply.code(400).send({ ok: false, error: "问题或图片至少给一个" });
    if (question.length > 8000) return reply.code(400).send({ ok: false, error: "内容过长" });
    const prof = loadProfile(db, COURSE_CODE);
    const r = await ask(TEXTBOOK_FILE, question, CITATION_LIMIT, images, profilePrompt(prof));
    const beyond = await guardProgress(question, r.answer, prof.maxChapterNo, CHAPTER_OUTLINE);
    db.prepare("INSERT INTO event (type, ref_type, payload) VALUES (?,?,?)").run(
      "ask",
      "textbook",
      JSON.stringify({
        q: question.slice(0, 120),
        k: r.citations.length,
        imgs: images.length,
        beyond: beyond.beyond.length,
      }),
    );
    return {
      ok: true,
      ...r,
      question,
      beyond: beyond.beyond,
      allWithin: beyond.allWithin,
      maxChapterNo: prof.maxChapterNo,
    };
  } catch (e) {
    return reply.code(500).send({ ok: false, error: (e as Error).message });
  }
});

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
  };
}>("/api/review", async (req, reply) => {
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
      const prof = loadProfile(db, COURSE_CODE);
      const r = await solve(
        TEXTBOOK_FILE,
        question,
        CITATION_LIMIT,
        images,
        undefined,
        profilePrompt(prof),
      );
      const beyond = await guardProgress(question, r.answer, prof.maxChapterNo, CHAPTER_OUTLINE);
      db.prepare("INSERT INTO event (type, ref_type, payload) VALUES (?,?,?)").run(
        "solve",
        "textbook",
        JSON.stringify({ q: question.slice(0, 120) }),
      );
      return {
        ok: true,
        mode: "solve",
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
        },
        question,
      };
    }

    const prof = loadProfile(db, COURSE_CODE);
    const r = await review(
      TEXTBOOK_FILE,
      question,
      myAnswer,
      req.body?.correctAnswer?.trim(),
      [...images, ...answerImages],
      profilePrompt(prof),
    );
    return {
      ok: true,
      mode: "grade",
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
  };
}>("/api/stream", async (req, reply) => {
  const body = req.body ?? {};
  const images = (body.images ?? []).slice(0, 4);
  const answerImages = (body.answerImages ?? []).slice(0, 4);
  const detail: Detail = body.detail === "brief" ? "brief" : "full";

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

    const prof = loadProfile(db, COURSE_CODE);
    const stream = myAnswer
      ? reviewStream(
          TEXTBOOK_FILE,
          question,
          myAnswer,
          body.correctAnswer?.trim(),
          [...images, ...answerImages],
          profilePrompt(prof),
          detail,
        )
      : solveStream(TEXTBOOK_FILE, question, {
          images,
          profileText: profilePrompt(prof),
          detail,
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
        JSON.stringify({ q: question.slice(0, 120) }),
      );
      if (answerText) {
        const beyond = await guardProgress(
          question,
          answerText,
          prof.maxChapterNo,
          CHAPTER_OUTLINE,
        );
        if (beyond.beyond.length > 0) {
          send({ type: "beyond", beyond: beyond.beyond, maxChapterNo: prof.maxChapterNo });
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
  };
}>("/api/mistakes", async (req, reply) => {
  const b = req.body ?? {};
  if (!b.title?.trim()) return reply.code(400).send({ ok: false, error: "title 必填" });
  const id = saveMistake(db, {
    title: b.title.trim(),
    raw_text: b.raw_text ?? null,
    my_answer: b.my_answer ?? null,
    correct_answer: b.correct_answer ?? null,
    error_type: b.error_type ?? null,
    error_detail: b.error_detail ?? null,
    kp_codes: b.kp_codes ?? [],
    course_code: "PHY2",
  });
  return { ok: true, id };
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
app.get<{ Querystring: { course?: string } }>("/api/progress", async (req) => {
  const course = req.query.course ?? COURSE_CODE;
  return { ok: true, ...profileSummary(db, course), course };
});

/** 设置单章状态 */
app.post<{
  Body: { course?: string; chapterNo?: number; chapterTitle?: string; status?: ChapterStatus };
}>("/api/progress", async (req, reply) => {
  const b = req.body ?? {};
  const course = b.course ?? COURSE_CODE;
  const no = Number(b.chapterNo);
  const status = (b.status ?? "done") as ChapterStatus;
  if (!Number.isInteger(no) || no < 1 || no > 40) {
    return reply.code(400).send({ ok: false, error: "chapterNo 必须是 1-40 的整数" });
  }
  if (!["not_started", "learning", "done"].includes(status)) {
    return reply.code(400).send({ ok: false, error: "status 非法" });
  }
  setChapterProgress(db, {
    courseCode: course,
    chapterNo: no,
    chapterTitle: b.chapterTitle ?? null,
    status,
    source: "manual",
    evidence: "用户在界面上设置",
    confidence: 1,
  });
  return { ok: true, ...profileSummary(db, course) };
});

/** 一句话把进度推到第 N 章（第 1..N 章标 done） */
app.post<{ Body: { course?: string; chapterNo?: number } }>(
  "/api/progress/advance",
  async (req, reply) => {
    const course = req.body?.course ?? COURSE_CODE;
    const no = Number(req.body?.chapterNo);
    if (!Number.isInteger(no) || no < 1 || no > 40) {
      return reply.code(400).send({ ok: false, error: "chapterNo 必须是 1-40 的整数" });
    }
    advanceTo(db, course, no);
    db.prepare("INSERT INTO event (type, ref_type, payload) VALUES (?,?,?)").run(
      "progress_set",
      "chapter_progress",
      JSON.stringify({ course, chapterNo: no }),
    );
    return { ok: true, ...profileSummary(db, course) };
  },
);

/** 当前注入给模型的画像原文，用于肉眼核对"模型到底看到了什么" */
app.get<{ Querystring: { course?: string } }>("/api/profile/prompt", async (req) => {
  const course = req.query.course ?? COURSE_CODE;
  return { ok: true, course, prompt: profilePrompt(loadProfile(db, course)) };
});

/** 章节清单：用于前端渲染进度条（含未开始章节） */
app.get<{ Querystring: { course?: string } }>("/api/progress/chapters", async (req) => {
  const course = req.query.course ?? COURSE_CODE;
  const rows = listChapterProgress(db, course);
  return { ok: true, course, chapters: rows };
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
