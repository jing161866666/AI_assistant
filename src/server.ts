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
import { ask, errorTypeLabel, review } from "./rag/answer.js";
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

const app = Fastify({ logger: { level: "info" } });
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

app.post<{ Body: { question?: string } }>("/api/ask", async (req, reply) => {
  const question = req.body?.question?.trim();
  if (!question) return reply.code(400).send({ ok: false, error: "question 不能为空" });
  if (question.length > 2000) return reply.code(400).send({ ok: false, error: "问题过长" });
  try {
    const r = await ask(TEXTBOOK_FILE, question);
    db.prepare("INSERT INTO event (type, ref_type, payload) VALUES (?,?,?)").run(
      "ask",
      "textbook",
      JSON.stringify({ q: question.slice(0, 120), k: r.citations.length }),
    );
    return { ok: true, ...r };
  } catch (e) {
    return reply.code(500).send({ ok: false, error: (e as Error).message });
  }
});

app.post<{ Body: { question?: string; myAnswer?: string; correctAnswer?: string } }>(
  "/api/review",
  async (req, reply) => {
    const question = req.body?.question?.trim();
    const myAnswer = req.body?.myAnswer?.trim();
    if (!question || !myAnswer) {
      return reply.code(400).send({ ok: false, error: "question 与 myAnswer 都不能为空" });
    }
    try {
      const r = await review(TEXTBOOK_FILE, question, myAnswer, req.body?.correctAnswer?.trim());
      return { ok: true, ...r, errorTypeLabel: errorTypeLabel(r.error_type) };
    } catch (e) {
      return reply.code(500).send({ ok: false, error: (e as Error).message });
    }
  },
);

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
