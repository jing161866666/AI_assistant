import "dotenv/config";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { getLearnerDb, inspectTables, listTextbookDbs, paths } from "./db/index.js";
import { checkEnv } from "./llm/models.js";
import {
  addAttempt,
  deleteMistake,
  getMistake,
  listMistakes,
  mistakeStats,
  saveMistake,
} from "./memory/mistakes.js";
import { ask, errorTypeLabel, review, solve } from "./rag/answer.js";
import { textbookInfo } from "./rag/search.js";
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

app.get("/api/textbook", async () => textbookInfo(TEXTBOOK_FILE));

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

/** 把多张图依次识别并拼接（一道题常跨两页） */
async function imageTexts(images: string[], kind: "question" | "answer"): Promise<string> {
  const parts: string[] = [];
  for (const img of images) {
    const r = await extractImage(db, img, kind);
    parts.push(r.text);
  }
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
    const r = await ask(TEXTBOOK_FILE, question, 6, images);
    db.prepare("INSERT INTO event (type, ref_type, payload) VALUES (?,?,?)").run(
      "ask",
      "textbook",
      JSON.stringify({ q: question.slice(0, 120), k: r.citations.length, imgs: images.length }),
    );
    return { ok: true, ...r, question };
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
      const r = await solve(TEXTBOOK_FILE, question, 5, images);
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
          model: r.model,
          ms: r.ms,
        },
        question,
      };
    }

    const r = await review(TEXTBOOK_FILE, question, myAnswer, req.body?.correctAnswer?.trim(), [
      ...images,
      ...answerImages,
    ]);
    return {
      ok: true,
      mode: "grade",
      view: { mode: "grade", ...r, errorTypeLabel: errorTypeLabel(r.error_type) },
      question,
      myAnswer,
    };
  } catch (e) {
    return reply.code(500).send({ ok: false, error: (e as Error).message });
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

// ───────────────────────── 启动 ─────────────────────────

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
  await app.listen({ port, host: "127.0.0.1" });
  app.log.info(`打开 http://127.0.0.1:${port}/`);
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
