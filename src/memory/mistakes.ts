import type { DatabaseSync } from "node:sqlite";

export interface MistakeInput {
  course_code?: string | null;
  title: string;
  kp_codes?: string[];
  source?: string;
  /** 用户上传的原图（artifact.id）。有它时界面优先显示截图，而不是转录文字 */
  artifact_id?: number | null;
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
  artifact_id: number | null;
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
       (course_code, title, kp_codes, source, artifact_id, raw_text, my_answer, correct_answer,
        error_type, error_detail, tags, difficulty)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      m.course_code ?? null,
      m.title,
      JSON.stringify(m.kp_codes ?? []),
      m.source ?? "text",
      m.artifact_id ?? null,
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

/**
 * 科目集合过滤的 SQL 片段。
 * 集合为空时给一个恒假条件（而不是 `IN ()`，那是语法错误）；
 * includeUnassigned 时并上未归类，保证旧数据在"只开放勾选科目"的视图里也不消失。
 */
function courseClause(
  codes: string[],
  includeUnassigned: boolean,
  column = "course_code",
): { sql: string; args: string[] } {
  if (codes.length === 0) {
    return { sql: includeUnassigned ? `${column} IS NULL` : "1 = 0", args: [] };
  }
  const ph = codes.map(() => "?").join(",");
  return {
    sql: includeUnassigned ? `(${column} IN (${ph}) OR ${column} IS NULL)` : `${column} IN (${ph})`,
    args: [...codes],
  };
}

export function listMistakes(
  db: DatabaseSync,
  opts: {
    errorType?: string;
    limit?: number;
    onlyUnresolved?: boolean;
    /** 只看某科目；不传 = 全部科目（错题本默认按当前科目看） */
    courseCode?: string;
    /** 只在这些科目里查（错题本只开放"勾选了 AI 辅助"的科目）；与 courseCode 互斥 */
    courseCodes?: string[];
    /** 与 courseCodes 搭配：把未归类（course_code IS NULL）也带出来，旧数据不丢 */
    includeUnassigned?: boolean;
  } = {},
): MistakeRow[] {
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (opts.errorType) {
    where.push("m.error_type = ?");
    args.push(opts.errorType);
  }
  if (opts.onlyUnresolved) where.push("m.resolved = 0");
  if (opts.courseCode) {
    where.push("m.course_code = ?");
    args.push(opts.courseCode);
  } else if (opts.courseCodes) {
    const c = courseClause(opts.courseCodes, opts.includeUnassigned === true, "m.course_code");
    where.push(c.sql);
    args.push(...c.args);
  }
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

/**
 * 错题的原图（如果有）。
 * 只返回 artifact 的元信息，不读文件内容——图片由 `/api/mistakes/:id/image` 流式返回。
 */
export function getMistakeImage(
  db: DatabaseSync,
  id: number,
): { path: string; filename: string; sha256: string } | null {
  const row = db
    .prepare(
      `SELECT a.path AS path, a.filename AS filename, a.sha256 AS sha256
       FROM mistake m JOIN artifact a ON a.id = m.artifact_id
       WHERE m.id = ?`,
    )
    .get(id) as { path: string; filename: string; sha256: string } | undefined;
  return row ?? null;
}

/**
 * 给已有错题补挂原图（用户在错题本里补传截图）。
 *
 * 旧错题保存时还没存原图，库里只有转录文字；用户手里如果还有截图，
 * 这个入口让"优先用原图"对旧数据也成立，而不是只能等下次重做。
 */
export function attachMistakeImage(db: DatabaseSync, id: number, artifactId: number): boolean {
  const r = db
    .prepare("UPDATE mistake SET artifact_id = ?, source = 'photo' WHERE id = ?")
    .run(artifactId, id);
  if (Number(r.changes) === 0) return false;
  db.prepare("INSERT INTO event (type, ref_type, ref_id, payload) VALUES (?,?,?,?)").run(
    "mistake_image",
    "mistake",
    id,
    JSON.stringify({ artifactId }),
  );
  return true;
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

/** 错题统计；传 courseCode 时只统计该科目（与列表口径保持一致） */
export function mistakeStats(
  db: DatabaseSync,
  courseCode?: string,
  opts: { unassigned?: boolean; courseCodes?: string[]; includeUnassigned?: boolean } = {},
): MistakeStats {
  // 未归类（course_code IS NULL）必须单独一种口径：不能退化成"全部科目"
  let where = "";
  let args: string[] = [];
  if (opts.unassigned) {
    where = "WHERE course_code IS NULL";
  } else if (courseCode) {
    where = "WHERE course_code = ?";
    args = [courseCode];
  } else if (opts.courseCodes) {
    // 只统计勾选 AI 辅助的科目；未归类可选并入，与列表口径一致
    const c = courseClause(opts.courseCodes, opts.includeUnassigned === true);
    where = `WHERE ${c.sql}`;
    args = c.args;
  }
  const total = Number(
    (db.prepare(`SELECT COUNT(*) c FROM mistake ${where}`).get(...args) as { c: number }).c,
  );
  const unresolved = Number(
    (
      db
        .prepare(`SELECT COUNT(*) c FROM mistake ${where ? `${where} AND` : "WHERE"} resolved = 0`)
        .get(...args) as { c: number }
    ).c,
  );
  const byErrorType = db
    .prepare(
      `SELECT COALESCE(error_type,'unknown') AS error_type, COUNT(*) AS n
       FROM mistake ${where} GROUP BY error_type ORDER BY n DESC`,
    )
    .all(...args) as unknown as Array<{ error_type: string; n: number }>;
  return { total, unresolved, byErrorType };
}

export interface MistakeGroup {
  /** null = 旧数据没有科目，统一放进「未归类」组，绝不静默丢弃 */
  course_code: string | null;
  course_name: string;
  stats: MistakeStats;
  mistakes: MistakeRow[];
}

/**
 * 按科目归类的错题本。
 *
 * 与"前端选一门科目再查"的区别：这个函数一次给出**所有**科目的分组，
 * 保证「全部科目」视图下每条错题都能落到某一组里（含未归类），总数与分组和一致。
 * 科目名由注册表提供，未登记/已停用的科目退回显示代码。
 */
export function mistakeGroups(
  db: DatabaseSync,
  nameOf: (code: string | null) => string,
  opts: {
    errorType?: string;
    onlyUnresolved?: boolean;
    limitPerCourse?: number;
    /** 只归这些科目（错题本"全部科目"也只开放勾选 AI 辅助的课）；未归类始终保留 */
    courseCodes?: string[];
  } = {},
): MistakeGroup[] {
  const allowed = opts.courseCodes ? new Set(opts.courseCodes) : null;
  const rows = (
    db
      .prepare(
        `SELECT DISTINCT course_code FROM mistake
        ${opts.errorType ? "WHERE error_type = ?" : ""}
        ORDER BY course_code IS NULL, course_code`,
      )
      .all(...(opts.errorType ? [opts.errorType] : [])) as unknown as Array<{
      course_code: string | null;
    }>
  ).filter((r) => r.course_code == null || !allowed || allowed.has(r.course_code));

  const limit = opts.limitPerCourse ?? 100;
  const groups: MistakeGroup[] = rows.map((r) => {
    const code = r.course_code;
    // listMistakes 的 courseCode 过滤是"精确等于"，未归类（NULL）要单独查一次
    const list =
      code == null
        ? (db
            .prepare(
              `SELECT m.*,
                      (SELECT COUNT(*) FROM mistake_attempt a WHERE a.mistake_id = m.id) AS attempts,
                      (SELECT MAX(attempted_at) FROM mistake_attempt a WHERE a.mistake_id = m.id) AS last_attempt_at
                 FROM mistake m
                WHERE m.course_code IS NULL
                ${opts.errorType ? "AND m.error_type = ?" : ""}
                ${opts.onlyUnresolved ? "AND m.resolved = 0" : ""}
                ORDER BY m.saved_at DESC, m.id DESC
                LIMIT ?`,
            )
            .all(...(opts.errorType ? [opts.errorType] : []), limit) as unknown as MistakeRow[])
        : listMistakes(db, {
            courseCode: code,
            errorType: opts.errorType,
            onlyUnresolved: opts.onlyUnresolved,
            limit,
          });
    return {
      course_code: code,
      course_name: nameOf(code),
      stats: mistakeStats(db, code ?? undefined, { unassigned: code == null }),
      mistakes: list,
    };
  });

  return groups.sort(
    (a, b) => b.stats.total - a.stats.total || a.course_name.localeCompare(b.course_name),
  );
}
