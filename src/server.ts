import "dotenv/config";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify from "fastify";
import { getLearnerDb, inspectTables, listTextbookDbs, paths } from "./db/index.js";
import { checkEnv } from "./llm/models.js";

const app = Fastify({ logger: { level: "info" } });

/** 健康检查：一眼看出数据库、教材库、模型配置三件事是否就绪 */
app.get("/api/health", async () => {
  const db = getLearnerDb();
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
  const db = getLearnerDb();
  const row = db.prepare("SELECT * FROM profile WHERE id = 1").get();
  return { profile: row ?? null };
});

app.post<{ Body: { nickname: string; studentNoTail?: string; school?: string } }>(
  "/api/profile",
  async (req) => {
    const { nickname, studentNoTail, school } = req.body ?? {};
    if (!nickname) {
      return { ok: false, error: "nickname 必填" };
    }
    const db = getLearnerDb();
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

app.get("/api/subjects", async () => {
  const db = getLearnerDb();
  const rows = db.prepare("SELECT * FROM subject WHERE active = 1 ORDER BY selected_at DESC").all();
  return { subjects: rows };
});

app
  .listen({
    port: Number(process.env.PORT ?? 8787),
    host: "127.0.0.1",
  })
  .then((addr) => {
    app.log.info(`server: ${addr}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

// 防止 tests / 热重载时残留连接
const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

void existsSync(resolve(paths.data));
