import type { DatabaseSync } from "node:sqlite";

export interface MistakeInput {
  course_code?: string | null;
  title: string;
  kp_codes?: string[];
  source?: string;
  raw_text?: string | null;
  my_answer?: string | null;
  correct_answer?: string | null;
  error_type?: string | null;
  error_detail?: string | null;
  tags?: string[];
  difficulty?: number | null;
}

export interface MistakeRow {
  id: number;
  course_code: string | null;
  title: string;
  kp_codes: string | null;
  source: string;
  raw_text: string | null;
  my_answer: string | null;
  correct_answer: string | null;
  error_type: string | null;
  error_detail: string | null;
  tags: string | null;
  difficulty: number | null;
  resolved: number;
  saved_at: string;
  attempts: number;
  last_attempt_at: string | null;
}

export function saveMistake(db: DatabaseSync, m: MistakeInput): number {
  const r = db
    .prepare(
      `INSERT INTO mistake
       (course_code, title, kp_codes, source, raw_text, my_answer, correct_answer,
        error_type, error_detail, tags, difficulty)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      m.course_code ?? null,
      m.title,
      JSON.stringify(m.kp_codes ?? []),
      m.source ?? "text",
      m.raw_text ?? null,
      m.my_answer ?? null,
      m.correct_answer ?? null,
      m.error_type ?? null,
      m.error_detail ?? null,
      JSON.stringify(m.tags ?? []),
      m.difficulty ?? null,
    );
  const id = Number(r.lastInsertRowid);
  db.prepare("INSERT INTO event (type, ref_type, ref_id, payload) VALUES (?,?,?,?)").run(
    "mistake_saved",
    "mistake",
    id,
    JSON.stringify({ error_type: m.error_type }),
  );
  return id;
}

export function listMistakes(
  db: DatabaseSync,
  opts: { errorType?: string; limit?: number; onlyUnresolved?: boolean } = {},
): MistakeRow[] {
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (opts.errorType) {
    where.push("m.error_type = ?");
    args.push(opts.errorType);
  }
  if (opts.onlyUnresolved) where.push("m.resolved = 0");
  const sql = `
    SELECT m.*,
           (SELECT COUNT(*) FROM mistake_attempt a WHERE a.mistake_id = m.id) AS attempts,
           (SELECT MAX(attempted_at) FROM mistake_attempt a WHERE a.mistake_id = m.id) AS last_attempt_at
    FROM mistake m
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY m.saved_at DESC, m.id DESC
    LIMIT ?`;
  args.push(opts.limit ?? 100);
  return db.prepare(sql).all(...args) as unknown as MistakeRow[];
}

export function getMistake(db: DatabaseSync, id: number): MistakeRow | undefined {
  return db
    .prepare(
      `SELECT m.*,
              (SELECT COUNT(*) FROM mistake_attempt a WHERE a.mistake_id = m.id) AS attempts,
              (SELECT MAX(attempted_at) FROM mistake_attempt a WHERE a.mistake_id = m.id) AS last_attempt_at
       FROM mistake m WHERE m.id = ?`,
    )
    .get(id) as unknown as MistakeRow | undefined;
}

export function deleteMistake(db: DatabaseSync, id: number): boolean {
  const r = db.prepare("DELETE FROM mistake WHERE id = ?").run(id);
  return Number(r.changes) > 0;
}

/** 记录一次重做；答对 2 次才算掌握 */
export function addAttempt(
  db: DatabaseSync,
  id: number,
  correct: boolean,
  myAnswer?: string,
): { attempts: number; resolved: boolean } {
  db.prepare("INSERT INTO mistake_attempt (mistake_id, correct, my_answer) VALUES (?,?,?)").run(
    id,
    correct ? 1 : 0,
    myAnswer ?? null,
  );

  const rows = db
    .prepare("SELECT correct FROM mistake_attempt WHERE mistake_id = ? ORDER BY id")
    .all(id) as unknown as Array<{ correct: number }>;
  const total = rows.length;
  const right = rows.filter((r) => r.correct === 1).length;
  const resolved = total >= 2 && right >= 2;
  if (resolved) db.prepare("UPDATE mistake SET resolved = 1 WHERE id = ?").run(id);
  db.prepare("INSERT INTO event (type, ref_type, ref_id, payload) VALUES (?,?,?,?)").run(
    "mistake_retry",
    "mistake",
    id,
    JSON.stringify({ correct, total }),
  );
  return { attempts: total, resolved };
}

export interface MistakeStats {
  total: number;
  unresolved: number;
  byErrorType: Array<{ error_type: string; n: number }>;
}

export function mistakeStats(db: DatabaseSync): MistakeStats {
  const total = Number((db.prepare("SELECT COUNT(*) c FROM mistake").get() as { c: number }).c);
  const unresolved = Number(
    (db.prepare("SELECT COUNT(*) c FROM mistake WHERE resolved = 0").get() as { c: number }).c,
  );
  const byErrorType = db
    .prepare(
      `SELECT COALESCE(error_type,'unknown') AS error_type, COUNT(*) AS n
       FROM mistake GROUP BY error_type ORDER BY n DESC`,
    )
    .all() as unknown as Array<{ error_type: string; n: number }>;
  return { total, unresolved, byErrorType };
}
