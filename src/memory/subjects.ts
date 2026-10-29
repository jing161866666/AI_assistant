import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { listTextbookDbs, openTextbookDb, paths } from "../db/index.js";

/**
 * 科目注册表 —— "增加科目"的唯一入口。
 *
 * 两层隔离，别混：
 *   1) 知识库（教材/题库）**物理分库**：data/textbook/course-<code>.db，只读打开。
 *      这门课有没有知识库，看 subject.textbook_file 指向的文件在不在。
 *   2) 学习记忆（进度/错题/习惯）**逻辑分库**：都在一个 learner.db 里，靠 course_code 列区分。
 *      subject.learner_file 预留给第二步"记忆也物理分库"，现在恒为 NULL。
 *
 * 科目必须先登记再使用：没登记的科目不许写记忆（否则进度会挂在一个不存在科目上），
 * 登记了但知识库没构建的科目可以记录进度/错题/习惯，只是暂时不能问教材与改错。
 */

export interface SubjectRow {
  id: number;
  course_code: string;
  course_name: string;
  textbook_file: string | null;
  textbook_ver: string | null;
  learner_file: string | null;
  note: string | null;
  /** 用户是否勾选「允许 AI 辅助这门课」 */
  ai_enabled: number;
  selected_at: string;
  updated_at: string | null;
  active: number;
}

export interface TextbookMeta {
  code: string;
  name: string;
  /** 参与进度门控的章节数（chapter_no 非空） */
  chapters: number;
  chunks: number;
  version: string;
}

export interface SubjectProgress {
  maxChapterNo: number | null;
  learned: number[];
  learnedCount: number;
  /** 已学上限之内没确认学过的章节（断层） */
  gaps: number[];
  current: number | null;
}

export interface SubjectMistakes {
  total: number;
  unresolved: number;
  byErrorType: Array<{ error_type: string; n: number }>;
}

export interface SubjectSummary {
  code: string;
  name: string;
  active: boolean;
  textbook_file: string | null;
  /** 知识库文件在且能读出 course 表 = 可以问教材/改错 */
  textbook_ready: boolean;
  chapters: number;
  chunks: number;
  version: string;
  /** 预留：NULL 表示记忆写在共享 learner.db */
  learner_file: string | null;
  note: string | null;
  /** 用户勾选允许 AI 辅助；qwen 只能在这个集合里选科目 */
  ai_enabled: boolean;
  progress: SubjectProgress;
  mistakes: SubjectMistakes;
  habits: number;
}

/** 约定：一个科目一个教材库文件（小写），server 与 build:textbook 共用 */
export function textbookFileOf(code: string): string {
  return `course-${code.toLowerCase()}.db`;
}

/**
 * 科目代码规范：2–16 位，字母开头，允许数字/下划线/短横。
 * 统一大写，避免 phy2 / PHY2 被当成两门课各存一份进度。
 */
export function normalizeCourseCode(raw: unknown): string {
  const code = String(raw ?? "")
    .trim()
    .toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{1,15}$/.test(code)) {
    throw new Error(
      "科目代码只能由 2–16 位字母、数字、下划线或短横组成，且以字母开头（如 PHY2、DS、MATH2）",
    );
  }
  return code;
}

const metaCache = new Map<string, TextbookMeta | null>();

/** 读教材库自报的科目信息；文件缺失或库损坏返回 null（不抛错） */
export function textbookMeta(file: string | null | undefined): TextbookMeta | null {
  if (!file) return null;
  const cached = metaCache.get(file);
  if (cached !== undefined) return cached;

  let out: TextbookMeta | null = null;
  if (existsSync(resolve(paths.textbook, file))) {
    try {
      const db = openTextbookDb(file);
      try {
        const row = db.prepare("SELECT code, name FROM course LIMIT 1").get() as
          | { code: string; name: string }
          | undefined;
        const chapters = Number(
          (
            db.prepare("SELECT COUNT(*) AS c FROM chapter WHERE chapter_no IS NOT NULL").get() as {
              c: number;
            }
          ).c,
        );
        const chunks = Number(
          (db.prepare("SELECT COUNT(*) AS c FROM chunk").get() as { c: number }).c,
        );
        const v = db.prepare("SELECT value FROM meta WHERE key='version'").get() as
          | { value: string }
          | undefined;
        const code = (row?.code ?? file.replace(/^course-/, "").replace(/\.db$/, "")).toUpperCase();
        out = { code, name: row?.name ?? code, chapters, chunks, version: v?.value ?? "" };
      } finally {
        db.close();
      }
    } catch {
      out = null;
    }
  }
  metaCache.set(file, out);
  return out;
}

/** 构建/替换知识库后清缓存，否则科目页会一直显示旧章节数 */
export function clearTextbookMetaCache(): void {
  metaCache.clear();
}

/**
 * 把 data/textbook/ 下已有的教材库自动登记成科目。
 * 幂等：已登记的不重复插入，只补 file/版本/占位名。
 * 目的：老用户升级后不用手工"加科目"，现有 PHY2 直接出现。
 */
export function syncSubjectsFromTextbooks(db: DatabaseSync): {
  added: string[];
  updated: string[];
} {
  const added: string[] = [];
  const updated: string[] = [];
  for (const file of listTextbookDbs()) {
    const meta = textbookMeta(file);
    if (!meta) continue;
    const row = db.prepare("SELECT * FROM subject WHERE course_code = ?").get(meta.code) as
      | SubjectRow
      | undefined;
    if (!row) {
      db.prepare(
        `INSERT INTO subject (course_code, course_name, textbook_file, textbook_ver, updated_at)
         VALUES (?,?,?,?, datetime('now'))`,
      ).run(meta.code, meta.name, file, meta.version);
      added.push(meta.code);
      continue;
    }
    // 名称只在不许覆盖用户自定义：仅当名称还是占位（等于代码）时用教材库里的名字
    const name = row.course_name === row.course_code ? meta.name : row.course_name;
    if (
      row.textbook_file !== file ||
      row.textbook_ver !== meta.version ||
      row.course_name !== name
    ) {
      db.prepare(
        `UPDATE subject
            SET textbook_file = ?, textbook_ver = ?, course_name = ?, updated_at = datetime('now')
          WHERE course_code = ?`,
      ).run(file, meta.version, name, meta.code);
      updated.push(meta.code);
    }
  }
  return { added, updated };
}

/** 按科目整批算统计，避免科目页对每个科目各查一遍 */
function bulkStats(db: DatabaseSync): {
  progress: Map<string, SubjectProgress>;
  mistakes: Map<string, SubjectMistakes>;
  habits: Map<string, number>;
} {
  const chapterRows = db
    .prepare("SELECT course_code, chapter_no, status FROM chapter_progress")
    .all() as unknown as Array<{ course_code: string; chapter_no: number; status: string }>;

  const learnedByCourse = new Map<string, Set<number>>();
  const currentByCourse = new Map<string, number>();
  for (const r of chapterRows) {
    if (r.status !== "learning" && r.status !== "done") continue;
    const set = learnedByCourse.get(r.course_code) ?? new Set<number>();
    set.add(r.chapter_no);
    learnedByCourse.set(r.course_code, set);
    if (r.status === "learning") currentByCourse.set(r.course_code, r.chapter_no);
  }

  const progress = new Map<string, SubjectProgress>();
  for (const [code, set] of learnedByCourse) {
    const learned = [...set].sort((a, b) => a - b);
    const max = learned.length ? learned[learned.length - 1]! : null;
    const gaps: number[] = [];
    if (max != null) for (let n = 1; n <= max; n++) if (!set.has(n)) gaps.push(n);
    progress.set(code, {
      maxChapterNo: max,
      learned,
      learnedCount: learned.length,
      gaps,
      current: currentByCourse.get(code) ?? null,
    });
  }

  const mistakeTotals = db
    .prepare(
      `SELECT COALESCE(course_code,'') AS course_code,
              COUNT(*) AS total,
              SUM(CASE WHEN resolved = 0 THEN 1 ELSE 0 END) AS unresolved
         FROM mistake GROUP BY COALESCE(course_code,'')`,
    )
    .all() as unknown as Array<{ course_code: string; total: number; unresolved: number }>;

  const mistakeTypes = db
    .prepare(
      `SELECT COALESCE(course_code,'') AS course_code,
              COALESCE(error_type,'unknown') AS error_type, COUNT(*) AS n
         FROM mistake GROUP BY COALESCE(course_code,''), COALESCE(error_type,'unknown')
        ORDER BY n DESC`,
    )
    .all() as unknown as Array<{ course_code: string; error_type: string; n: number }>;

  const mistakes = new Map<string, SubjectMistakes>();
  const ensureMistake = (code: string): SubjectMistakes => {
    const cur = mistakes.get(code) ?? { total: 0, unresolved: 0, byErrorType: [] };
    mistakes.set(code, cur);
    return cur;
  };
  for (const r of mistakeTotals) {
    const cur = ensureMistake(r.course_code);
    cur.total = Number(r.total);
    cur.unresolved = Number(r.unresolved);
  }
  for (const r of mistakeTypes) {
    ensureMistake(r.course_code).byErrorType.push({
      error_type: r.error_type,
      n: Number(r.n),
    });
  }

  const habitRows = db
    .prepare(
      `SELECT COALESCE(course_code,'') AS course_code, COUNT(*) AS n
         FROM habit WHERE status = 'active' GROUP BY COALESCE(course_code,'')`,
    )
    .all() as unknown as Array<{ course_code: string; n: number }>;
  const habits = new Map(habitRows.map((r) => [r.course_code, Number(r.n)]));

  return { progress, mistakes, habits };
}

const EMPTY_PROGRESS: SubjectProgress = {
  maxChapterNo: null,
  learned: [],
  learnedCount: 0,
  gaps: [],
  current: null,
};

function toSummary(row: SubjectRow, stats: ReturnType<typeof bulkStats>): SubjectSummary {
  const meta = textbookMeta(row.textbook_file);
  const progress = stats.progress.get(row.course_code) ?? { ...EMPTY_PROGRESS };
  const mistakes = stats.mistakes.get(row.course_code) ?? {
    total: 0,
    unresolved: 0,
    byErrorType: [],
  };
  return {
    code: row.course_code,
    name: row.course_name,
    active: row.active === 1,
    textbook_file: row.textbook_file,
    textbook_ready: meta != null,
    chapters: meta?.chapters ?? 0,
    chunks: meta?.chunks ?? 0,
    version: meta?.version ?? row.textbook_ver ?? "",
    learner_file: row.learner_file,
    note: row.note,
    ai_enabled: row.ai_enabled === 1,
    progress,
    mistakes,
    habits: stats.habits.get(row.course_code) ?? 0,
  };
}

export interface ListSubjectsOptions {
  /** 默认只列启用中的科目；true 时连停用的也列 */
  includeArchived?: boolean;
  /** 列之前先把教材库同步进注册表（默认 true） */
  sync?: boolean;
}

/** 全部科目（含每科进度/错题/习惯概况），科目页与进度总览共用 */
export function listSubjects(db: DatabaseSync, opts: ListSubjectsOptions = {}): SubjectSummary[] {
  if (opts.sync !== false) syncSubjectsFromTextbooks(db);
  const rows = (opts.includeArchived
    ? db.prepare("SELECT * FROM subject ORDER BY active DESC, course_code").all()
    : db
        .prepare("SELECT * FROM subject WHERE active = 1 ORDER BY course_code")
        .all()) as unknown as SubjectRow[];
  const stats = bulkStats(db);
  return rows.map((r) => toSummary(r, stats));
}

/** 单科目概况；未登记返回 null */
export function getSubject(db: DatabaseSync, code: string): SubjectSummary | null {
  const normalized = code.trim().toUpperCase();
  const row = db.prepare("SELECT * FROM subject WHERE course_code = ?").get(normalized) as
    | SubjectRow
    | undefined;
  if (!row) return null;
  return toSummary(row, bulkStats(db));
}

/** 科目变更也要进 event（唯一事实来源）：加科目/改绑定/停用都可追溯 */
function logSubjectEvent(
  db: DatabaseSync,
  type: string,
  code: string,
  payload: Record<string, unknown>,
): void {
  db.prepare("INSERT INTO event (type, ref_type, payload) VALUES (?,?,?)").run(
    type,
    "subject",
    JSON.stringify({ course: code, ...payload }),
  );
}

/**
 * 注册一个新科目。
 *
 * 只登记"这门课存在"，不写任何先验知识：知识库由 build:textbook 构建（AGENTS 第二节）。
 * 停用过的科目再次添加 = 重新启用，历史进度/错题不丢。
 */
export interface AddSubjectInput {
  code: string;
  name?: string;
  note?: string;
  /** 指定教材库文件名；不传则按约定 course-<code>.db 探测，不存在就留空 */
  textbookFile?: string | null;
}

export function addSubject(db: DatabaseSync, input: AddSubjectInput): SubjectSummary {
  const code = normalizeCourseCode(input.code);
  const name = input.name?.trim() || code;
  if (name.length > 60) throw new Error("科目名称过长（最多 60 字）");
  const note = input.note?.trim() || null;

  let textbookFile: string | null = null;
  if (input.textbookFile != null && String(input.textbookFile).trim() !== "") {
    const f = String(input.textbookFile).trim();
    if (!existsSync(resolve(paths.textbook, f))) {
      throw new Error(`教材库文件不存在：${f}（先跑 npm run build:textbook，或留空）`);
    }
    textbookFile = f;
  } else if (existsSync(resolve(paths.textbook, textbookFileOf(code)))) {
    textbookFile = textbookFileOf(code);
  }
  const meta = textbookMeta(textbookFile);

  const existing = db.prepare("SELECT * FROM subject WHERE course_code = ?").get(code) as
    | SubjectRow
    | undefined;
  if (existing) {
    if (existing.active === 1) throw new Error(`科目 ${code} 已存在，无需重复添加`);
    db.prepare(
      `UPDATE subject
          SET active = 1, course_name = ?, note = COALESCE(?, note),
              textbook_file = COALESCE(?, textbook_file),
              textbook_ver  = COALESCE(?, textbook_ver),
              updated_at = datetime('now')
        WHERE course_code = ?`,
    ).run(name, note, textbookFile, meta?.version ?? null, code);
    logSubjectEvent(db, "subject_restored", code, { name });
    return getSubject(db, code)!;
  }

  db.prepare(
    `INSERT INTO subject (course_code, course_name, textbook_file, textbook_ver, note, updated_at)
     VALUES (?,?,?,?,?, datetime('now'))`,
  ).run(code, name, textbookFile, meta?.version ?? null, note);
  logSubjectEvent(db, "subject_added", code, { name, has_textbook: meta != null });
  return getSubject(db, code)!;
}

export interface UpdateSubjectInput {
  name?: string;
  note?: string | null;
  /** 绑定/更换教材库；null 表示解除绑定（知识库未就绪） */
  textbookFile?: string | null;
  learnerFile?: string | null;
  active?: boolean;
}

/** 改科目名/备注/绑定知识库/启停；不改 course_code（它是所有记忆的锚点） */
export function updateSubject(
  db: DatabaseSync,
  code: string,
  input: UpdateSubjectInput,
): SubjectSummary {
  const normalized = normalizeCourseCode(code);
  const row = db.prepare("SELECT * FROM subject WHERE course_code = ?").get(normalized) as
    | SubjectRow
    | undefined;
  if (!row) throw new Error(`科目 ${normalized} 未登记`);

  const name = input.name?.trim() || row.course_name;
  if (name.length > 60) throw new Error("科目名称过长（最多 60 字）");

  let textbookFile = row.textbook_file;
  let textbookVer = row.textbook_ver;
  if (input.textbookFile !== undefined) {
    if (input.textbookFile == null || String(input.textbookFile).trim() === "") {
      textbookFile = null;
      textbookVer = null;
    } else {
      const f = String(input.textbookFile).trim();
      if (!existsSync(resolve(paths.textbook, f))) throw new Error(`教材库文件不存在：${f}`);
      textbookFile = f;
      textbookVer = textbookMeta(f)?.version ?? null;
    }
  }
  const learnerFile =
    input.learnerFile === undefined ? row.learner_file : input.learnerFile?.trim() || null;
  const active = input.active === undefined ? row.active : input.active ? 1 : 0;

  db.prepare(
    `UPDATE subject
        SET course_name = ?, note = ?, textbook_file = ?, textbook_ver = ?,
            learner_file = ?, active = ?, updated_at = datetime('now')
      WHERE course_code = ?`,
  ).run(
    name,
    input.note === undefined ? row.note : (input.note?.trim() ?? null),
    textbookFile,
    textbookVer,
    learnerFile,
    active,
    normalized,
  );
  logSubjectEvent(db, active ? "subject_updated" : "subject_archived", normalized, {
    name,
    textbook_file: textbookFile,
    active: Boolean(active),
  });
  return getSubject(db, normalized)!;
}

/**
 * 停用科目（软删除）。
 * 不删任何记忆：进度/错题/习惯/对话都留着，重新启用后原样回来。
 */
export function archiveSubject(db: DatabaseSync, code: string): SubjectSummary {
  const normalized = normalizeCourseCode(code);
  const row = db.prepare("SELECT * FROM subject WHERE course_code = ?").get(normalized) as
    | SubjectRow
    | undefined;
  if (!row) throw new Error(`科目 ${normalized} 未登记`);
  db.prepare(
    "UPDATE subject SET active = 0, updated_at = datetime('now') WHERE course_code = ?",
  ).run(normalized);
  logSubjectEvent(db, "subject_archived", normalized, { name: row.course_name });
  return getSubject(db, normalized)!;
}

/** 科目是否已登记且启用（写入记忆前的最低门槛） */
export function isActiveSubject(db: DatabaseSync, code: string): boolean {
  const r = db
    .prepare("SELECT active FROM subject WHERE course_code = ?")
    .get(code.trim().toUpperCase()) as { active: number } | undefined;
  return r?.active === 1;
}

/**
 * 进度与错题本的授权闸：只有用户勾选「允许 AI 辅助」的启用科目才算数。
 *
 * 与 isActiveSubject 的区别：登记/启用只说明"这门课存在"，
 * 不代表用户同意让 AI 记它的进度和错题。没勾的科目一律读不到、写不进，
 * 历史数据不删——重新勾选后原样回来。
 */
export function isAiSubject(db: DatabaseSync, code: string): boolean {
  const r = db
    .prepare("SELECT active, ai_enabled FROM subject WHERE course_code = ?")
    .get(code.trim().toUpperCase()) as { active: number; ai_enabled: number } | undefined;
  return r?.active === 1 && r?.ai_enabled === 1;
}

/** 允许 AI 辅助的科目代码（启用中）；错题本"全部科目"与进度总览共用 */
export function aiSubjectCodes(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        "SELECT course_code FROM subject WHERE active = 1 AND ai_enabled = 1 ORDER BY course_code",
      )
      .all() as unknown as Array<{ course_code: string }>
  ).map((r) => r.course_code);
}

// ───────────────────────── 候选科目：来自课程表，用户勾选 ─────────────────────────

export interface TimetableCourse {
  code: string;
  name: string;
  /** 课程表里出现次数（每周几次课） */
  periods: number;
  /** 是否已登记为科目（登记了才能存进度/错题） */
  registered: boolean;
  active: boolean;
  /** 用户是否勾选允许 AI 辅助 */
  ai_enabled: boolean;
  textbook_ready: boolean;
}

/**
 * 从**课程表**里取候选科目。
 *
 * 这是"有哪些科目"的唯一来源：用户导入的课表里有什么课，科目页就列出什么课。
 * 不用教材库反推——没建库的课也是用户真实在上的课，应该能被勾选（只是暂时不能问教材）。
 * 没有 course_code 的日程不参与（无法做记忆锚点），在界面上提示先补课程代码。
 */
export function timetableCourses(db: DatabaseSync): TimetableCourse[] {
  const rows = db
    .prepare(
      `SELECT course_code AS code, title, COUNT(*) AS n
         FROM schedule
        WHERE (category = 'academic' OR type = 'course')
          AND course_code IS NOT NULL AND TRIM(course_code) <> ''
        GROUP BY course_code, title
        ORDER BY course_code`,
    )
    .all() as unknown as Array<{ code: string; title: string; n: number }>;

  // 同一门课一周上两次是很常见的：按 code 合并，名称取出现最多的那个
  const merged = new Map<string, { name: string; nameCount: number; periods: number }>();
  for (const r of rows) {
    const code = r.code.trim().toUpperCase();
    const n = Number(r.n);
    const cur = merged.get(code);
    if (!cur) merged.set(code, { name: r.title, nameCount: n, periods: n });
    else {
      cur.periods += n;
      if (n > cur.nameCount) {
        cur.name = r.title;
        cur.nameCount = n;
      }
    }
  }

  const subjects = new Map(
    (db.prepare("SELECT * FROM subject").all() as unknown as SubjectRow[]).map((s) => [
      s.course_code,
      s,
    ]),
  );

  return [...merged.entries()]
    .map(([code, v]) => {
      const sub = subjects.get(code);
      const meta = textbookMeta(sub?.textbook_file ?? textbookFileOf(code));
      return {
        code,
        name: sub?.course_name ?? v.name,
        periods: v.periods,
        registered: sub != null,
        active: sub?.active === 1,
        ai_enabled: sub?.ai_enabled === 1,
        textbook_ready: meta != null,
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * 保存用户勾选：只有被勾选的科目允许 AI 辅助。
 *
 * 勾选即授权，所以顺手把还没登记的课程表科目登记成科目（名称取自课表），
 * 但**不建教材库**：知识库仍要 build:textbook。未勾选的科目 ai_enabled 置 0，
 * 记忆一条不删——只是 qwen 不再往那科分流。
 */
export function setAiSubjects(db: DatabaseSync, rawCodes: string[]): TimetableCourse[] {
  const courses = new Map(timetableCourses(db).map((c) => [c.code, c]));
  const wanted = new Set<string>();
  for (const raw of rawCodes) {
    const code = normalizeCourseCode(raw);
    if (!courses.has(code)) {
      throw new Error(`科目 ${code} 不在课程表里，不能启用 AI 辅助（先导入课表或手动登记）`);
    }
    wanted.add(code);
  }

  db.exec("BEGIN");
  try {
    for (const code of wanted) {
      const existing = db
        .prepare("SELECT course_code FROM subject WHERE course_code = ?")
        .get(code) as { course_code: string } | undefined;
      if (!existing) addSubject(db, { code, name: courses.get(code)!.name });
      db.prepare(
        `UPDATE subject SET ai_enabled = 1, active = 1, updated_at = datetime('now')
          WHERE course_code = ?`,
      ).run(code);
    }
    const all = db.prepare("SELECT course_code FROM subject").all() as unknown as Array<{
      course_code: string;
    }>;
    for (const r of all) {
      if (wanted.has(r.course_code)) continue;
      db.prepare(
        "UPDATE subject SET ai_enabled = 0, updated_at = datetime('now') WHERE course_code = ?",
      ).run(r.course_code);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  logSubjectEvent(db, "subject_ai_enabled", [...wanted].join(","), { codes: [...wanted] });
  return timetableCourses(db);
}

export interface AiCandidate {
  code: string;
  name: string;
  /** 知识库章节数；0 = 还没建库（仍可作为候选，只是不能问教材） */
  chapters: number;
  maxChapterNo: number | null;
  textbookReady: boolean;
}

/**
 * 允许 AI 辅助的科目（用户勾选 + 启用）。
 *
 * qwen 的科目分流只能在这个集合里选：用户没勾的课，模型不许往里归档。
 */
export function aiCandidates(db: DatabaseSync): AiCandidate[] {
  return listSubjects(db)
    .filter((s) => s.active && s.ai_enabled)
    .map((s) => ({
      code: s.code,
      name: s.name,
      chapters: s.chapters,
      maxChapterNo: s.progress.maxChapterNo,
      textbookReady: s.textbook_ready,
    }));
}

/** 科目下的知识点（供前端展示；教材库缺失时返回空数组） */
export function subjectKnowledgePoints(
  db: DatabaseSync,
  code: string,
): Array<{ code: string; name: string; chapter: string | null }> {
  const sub = db
    .prepare("SELECT textbook_file FROM subject WHERE course_code = ?")
    .get(code.trim().toUpperCase()) as { textbook_file: string | null } | undefined;
  const file = sub?.textbook_file;
  if (!file || !existsSync(resolve(paths.textbook, file))) return [];
  try {
    const tdb = openTextbookDb(file);
    try {
      return tdb
        .prepare(
          `SELECT k.code, k.name, ch.title AS chapter
             FROM knowledge_point k LEFT JOIN chapter ch ON ch.id = k.chapter_id
            ORDER BY k.code`,
        )
        .all() as unknown as Array<{ code: string; name: string; chapter: string | null }>;
    } finally {
      tdb.close();
    }
  } catch {
    return [];
  }
}
