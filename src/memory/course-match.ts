import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { listTextbookDbs, openTextbookDb, paths } from "../db/index.js";
import { llm } from "../llm/client.js";
import { getLlmConfig } from "../llm/models.js";

/**
 * 科目匹配：把课表里的「官方课程名」对到「教材库」。
 *
 * 为什么不能全靠模型：这一步决定后面用哪本书答题，错了会一路错下去且看不出来。
 * 所以分三档，模型只在最后一档、且结果必须挂 pending 等用户点确认：
 *
 *   1. exact —— 归一化后相同/包含（代码判定，可直接信）
 *   2. alias —— 用户确认过的别名表（course_alias.status='confirmed'）
 *   3. model —— 给候选枚举让模型挑（qwen-flash 足够，快且便宜），带置信度
 *
 * 注意：文件夹缩写（PHY2/DS）只是文件名，不是语义信息。
 * 真正的"官方名"来自每个教材库自报的 course.name，匹配是「课表名 ↔ 库自报名」。
 */

export interface LibraryRef {
  code: string;
  name: string;
  file: string;
  chapters: number;
  /** 该库有多少章节带 chapter_no（决定进度门控能不能生效） */
  chapterNos: number;
  chunks: number;
}

export type MatchTier = "exact" | "alias" | "short" | "model" | "none";

export interface CourseMatch {
  /** 课表里的原名，不改写 */
  name: string;
  code: string | null;
  library: LibraryRef | null;
  tier: MatchTier;
  confidence: number;
  reason: string;
  /** true = 需要用户点一下确认，不能自动使用 */
  needsConfirm: boolean;
}

// ───────────────────────── 归一化（纯函数，可断言） ─────────────────────────

const ROMAN: Record<string, string> = {
  i: "1",
  ii: "2",
  iii: "3",
  iv: "4",
  v: "5",
  vi: "6",
};

/**
 * 只做语言层面的统一，不做语义猜测：
 * 全角转半角、大小写统一、各种括号统一、去掉分隔符、结尾罗马数字转阿拉伯数字。
 */
export function normalizeCourseName(raw: string): string {
  let s = raw.normalize("NFKC").toLowerCase();
  s = s.replace(/[（【[〔]/g, "(").replace(/[）】\]〕]/g, ")");
  s = s.replace(/[\s·・,，、_\-—–]/g, "");
  // 结尾的罗马数字：大学物理(b)ii → 大学物理(b)2
  s = s.replace(/(?<![a-z0-9])(iii|ii|iv|vi|i|v)$/, (m) => ROMAN[m] ?? m);
  return s;
}

/** 包含关系判定要设门槛，否则「物理」会命中一切 */
function containment(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 5) return false; // 太短的词不做包含匹配
  if (!long.includes(short)) return false;
  return long.length - short.length <= 8;
}

/**
 * 简称可验性：文件夹缩写（大物下 / 工数）能不能在官方课名里逐字找到。
 *
 * 这不是语义判断，是字符串判定，所以可信、可断言：
 * - 大物下 → 大学物理下：大→大、物→物、下→下，按顺序出现 ✓
 * - 工数 → 工科数学分析：工→工、数→数 ✓
 * - CPP → 编程语言基础：C/P/P 一个都不在 ✗（这类只能靠常识，必须人确认）
 *
 * @returns 0 表示不可验；0.9 表示可验（官方名里按顺序全找到）
 */
export function shortNameScore(officialName: string, folderName: string): number {
  const off = normalizeCourseName(officialName).replace(/[^0-9a-z\u4e00-\u9fa5]/g, "");
  const short = normalizeCourseName(folderName).replace(/[^0-9a-z\u4e00-\u9fa5]/g, "");
  if (short.length < 2) return 0;
  if (off.length < short.length) return 0;

  // 逐字按顺序找（允许官方名里插字）
  let i = 0;
  for (const ch of off) {
    if (ch === short[i]) i++;
    if (i === short.length) return 0.9;
  }
  return 0;
}

/**
 * 双向简称判定：不知道哪一边才是缩写。
 * 库里可能叫「大物下」、课表里是「大学物理下」，也可能反过来。
 */
export function bestShortNameScore(a: string, b: string): number {
  return Math.max(shortNameScore(a, b), shortNameScore(b, a));
}

// ───────────────────────── 教材库清单 ─────────────────────────

function readLibrary(file: string): LibraryRef | null {
  try {
    const db = openTextbookDb(file);
    try {
      const row = db.prepare("SELECT code, name FROM course LIMIT 1").get() as
        | { code: string; name: string }
        | undefined;
      const chapters = Number(
        (db.prepare("SELECT COUNT(*) AS c FROM chapter").get() as { c: number }).c,
      );
      const chapterNos = Number(
        (
          db.prepare("SELECT COUNT(*) AS c FROM chapter WHERE chapter_no IS NOT NULL").get() as {
            c: number;
          }
        ).c,
      );
      const chunks = Number(
        (db.prepare("SELECT COUNT(*) AS c FROM chunk").get() as { c: number }).c,
      );
      return {
        code: (row?.code ?? file.replace(/^course-/, "").replace(/\.db$/, "")).toUpperCase(),
        name: row?.name ?? row?.code ?? file,
        file,
        chapters,
        chapterNos,
        chunks,
      };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** 现有全部教材库（一个库 = 一门课的知识库） */
export function listLibraries(): LibraryRef[] {
  return listTextbookDbs()
    .map(readLibrary)
    .filter((x): x is LibraryRef => x !== null)
    .sort((a, b) => a.code.localeCompare(b.code));
}

/** 课表里的课程名（去重，保持出现顺序） */
export function loadTimetableCourses(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT title FROM schedule
       WHERE category = 'academic' AND title IS NOT NULL AND title <> ''
       ORDER BY title`,
    )
    .all() as Array<{ title: string }>;
  return rows.map((r) => r.title);
}

// ───────────────────────── 模型兜底（可注入，便于测试） ─────────────────────────

const modelMatchSchema = z.object({
  matches: z
    .array(
      z.object({
        course: z.string().catch(""),
        code: z.string().nullable().catch(null),
        confidence: z.number().min(0).max(1).catch(0),
        reason: z.string().catch(""),
      }),
    )
    .catch([]),
});

export type ModelMatcher = (
  courses: string[],
  libraries: LibraryRef[],
) => Promise<z.infer<typeof modelMatchSchema>["matches"]>;

async function defaultMatcher(
  courses: string[],
  libraries: LibraryRef[],
): Promise<z.infer<typeof modelMatchSchema>["matches"]> {
  if (courses.length === 0 || libraries.length === 0) return [];
  const cfg = getLlmConfig("extract");
  const res = await llm("extract").chat.completions.create({
    model: cfg.model,
    messages: [
      {
        role: "system",
        content: `你在把大学课表里的课程名，配到已有的教材库上。只输出 JSON。

规则：
1. 只能从给出的 code 里选，不许发明新的 code。
2. 一门课配一本库：同一门课不同学分/不同册（如「大学物理(B)II」与「大学物理实验(理工)II」）必须分开，
   宁可 code 为 null 也不要合并。
3. 配不上就给 null，不要硬凑。confidence 用 0-1 表示你的把握。
4. reason 一句话，20 字内。

输出格式：{"matches":[{"course":"课表原名","code":"PHY2 或 null","confidence":0.9,"reason":"..."}]}`,
      },
      {
        role: "user",
        content: [
          `【候选教材库】\n${libraries.map((l) => `${l.code} = ${l.name}`).join("\n")}`,
          `【待匹配课程】\n${courses.join("\n")}`,
        ].join("\n\n"),
      },
    ],
    max_tokens: 1200,
    temperature: 0,
    response_format: { type: "json_object" },
  });

  const raw = res.choices[0]?.message?.content ?? "{}";
  try {
    return modelMatchSchema.parse(JSON.parse(raw)).matches;
  } catch {
    return [];
  }
}

let matcher: ModelMatcher = defaultMatcher;
export function setCourseMatcher(fn: ModelMatcher): void {
  matcher = fn;
}

// ───────────────────────── 三段匹配 ─────────────────────────

export interface AliasRow {
  alias: string;
  course_code: string;
  source: string;
  status: string;
}

export function loadAliases(db: DatabaseSync): AliasRow[] {
  return db
    .prepare("SELECT alias, course_code, source, status FROM course_alias")
    .all() as unknown as AliasRow[];
}

/** 存匹配结果：可字符校验的（exact/alias/short）直接 confirmed；模型猜的一律 pending */
export function saveMatchResult(db: DatabaseSync, m: CourseMatch): void {
  if (!m.code) return;
  if (m.tier === "exact" || m.tier === "alias" || (m.tier === "short" && !m.needsConfirm)) {
    db.prepare(
      `INSERT INTO course_alias (alias, course_code, source, status, confidence, reason)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(alias, course_code) DO UPDATE SET
         source=excluded.source, status=excluded.status,
         confidence=excluded.confidence, reason=excluded.reason,
         updated_at=datetime('now')`,
    ).run(m.name, m.code, m.tier, "confirmed", m.confidence, m.reason);
    return;
  }
  db.prepare(
    `INSERT INTO course_alias (alias, course_code, source, status, confidence, reason)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(alias, course_code) DO UPDATE SET
       source=excluded.source,
       status=CASE WHEN course_alias.status='confirmed' THEN 'confirmed' ELSE 'pending' END,
       confidence=excluded.confidence, reason=excluded.reason,
       updated_at=datetime('now')`,
  ).run(m.name, m.code, "model", "pending", m.confidence, m.reason);
}

/**
 * 主入口：课表课程 × 现有教材库 → 匹配结果。
 * 只有 exact / 已确认别名 会 needsConfirm=false；模型结果一律要用户点头。
 */
export async function matchCourses(
  db: DatabaseSync,
  opts: { courses?: string[]; useModel?: boolean; libraries?: LibraryRef[] } = {},
): Promise<{ courses: CourseMatch[]; libraries: LibraryRef[] }> {
  // libraries 可注入：测试时不用真的建一堆 .db 文件
  const libraries = opts.libraries ?? listLibraries();
  const names = opts.courses ?? loadTimetableCourses(db);
  const aliases = loadAliases(db);
  const byCode = new Map(libraries.map((l) => [l.code.toLowerCase(), l]));
  const results: CourseMatch[] = [];
  const unresolved: string[] = [];

  for (const name of names) {
    const norm = normalizeCourseName(name);

    // 1) 归一化精确 / 包含
    let hit: LibraryRef | undefined;
    for (const lib of libraries) {
      const ln = normalizeCourseName(lib.name);
      if (ln === norm) {
        hit = lib;
        break;
      }
    }
    if (!hit) {
      for (const lib of libraries) {
        if (containment(norm, normalizeCourseName(lib.name))) {
          hit = lib;
          break;
        }
      }
    }
    if (hit) {
      results.push({
        name,
        code: hit.code,
        library: hit,
        tier: "exact",
        confidence: normalizeCourseName(hit.name) === norm ? 1 : 0.85,
        reason: "课名归一化后与教材库自报名称一致",
        needsConfirm: false,
      });
      continue;
    }

    // 2) 用户确认过的别名
    const alias = aliases.find(
      (a) =>
        a.alias === name && a.status === "confirmed" && byCode.has(a.course_code.toLowerCase()),
    );
    if (alias) {
      const lib = byCode.get(alias.course_code.toLowerCase()) ?? null;
      results.push({
        name,
        code: lib?.code ?? null,
        library: lib,
        tier: "alias",
        confidence: 1,
        reason: `别名表已确认（来源 ${alias.source}）`,
        needsConfirm: false,
      });
      continue;
    }

    // 2.5) 简称可验：文件夹缩写逐字出现在官方课名里（大物下→大学物理下、工数→工科数学分析）
    // 两边都试：库自报名可能才是缩写（库叫「大物下」、课表叫「大学物理下」）
    const shortHits = libraries
      .map((lib) => ({ lib, score: bestShortNameScore(lib.name, name) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    if (shortHits.length > 0) {
      const best = shortHits[0]!;
      const ambiguous = shortHits.length > 1 && shortHits[1]?.score === best.score;
      results.push({
        name,
        code: best.lib.code,
        library: best.lib,
        tier: "short",
        confidence: ambiguous ? 0.5 : best.score,
        reason: ambiguous
          ? `简称同时符合多个库（${shortHits.map((x) => x.lib.name).join(" / ")}），请选一个`
          : "简称逐字对得上官方课名（可字符串校验）",
        // 有歧义就必须人确认；否则简称型可直接用（随时可改）
        needsConfirm: ambiguous,
      });
      continue;
    }

    unresolved.push(name);
  }

  // 3) 模型兜底
  if (opts.useModel !== false && unresolved.length > 0 && libraries.length > 0) {
    let guesses: Awaited<ReturnType<ModelMatcher>> = [];
    try {
      guesses = await matcher(unresolved, libraries);
    } catch (e) {
      console.error(`[match] 模型匹配失败：${(e as Error).message}`);
    }
    for (const name of unresolved) {
      const g = guesses.find((x) => x.course === name);
      const lib = g?.code ? (byCode.get(g.code.toLowerCase()) ?? null) : null;
      results.push({
        name,
        code: lib?.code ?? null,
        library: lib,
        tier: lib ? "model" : "none",
        confidence: g?.confidence ?? 0,
        reason: g?.reason ?? "模型也没把握",
        // 模型猜的一律要确认：这是"用哪本书"的决定，猜错代价太高
        needsConfirm: Boolean(lib),
      });
    }
  } else {
    for (const name of unresolved) {
      results.push({
        name,
        code: null,
        library: null,
        tier: "none",
        confidence: 0,
        reason: libraries.length === 0 ? "还没有任何教材库" : "未匹配到教材库",
        needsConfirm: false,
      });
    }
  }

  for (const m of results) saveMatchResult(db, m);
  return { courses: results, libraries };
}

// ───────────────────────── 用户勾选 / 确认 ─────────────────────────

export interface SelectInput {
  code: string;
  name: string;
  enabled: boolean;
  textbookFile?: string | null;
  textbookVer?: string | null;
}

/** 勾选「允许 AI 辅助这门课」；写 subject 表（ai_enabled） */
export function selectSubject(db: DatabaseSync, input: SelectInput): void {
  db.prepare(
    `INSERT INTO subject (course_code, course_name, textbook_file, textbook_ver, ai_enabled, updated_at)
     VALUES (?,?,?,?,?,datetime('now'))
     ON CONFLICT(course_code) DO UPDATE SET
       course_name=excluded.course_name,
       textbook_file=COALESCE(excluded.textbook_file, subject.textbook_file),
       textbook_ver=COALESCE(excluded.textbook_ver, subject.textbook_ver),
       ai_enabled=excluded.ai_enabled,
       updated_at=datetime('now')`,
  ).run(
    input.code,
    input.name,
    input.textbookFile ?? null,
    input.textbookVer ?? null,
    input.enabled ? 1 : 0,
  );
}

/** 用户确认/否决一条匹配 */
export function confirmAlias(
  db: DatabaseSync,
  alias: string,
  code: string,
  accepted: boolean,
): void {
  if (accepted) {
    db.prepare(
      `INSERT INTO course_alias (alias, course_code, source, status, confidence, reason)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(alias, course_code) DO UPDATE SET
         source='user', status='confirmed', confidence=1,
         reason='用户确认', updated_at=datetime('now')`,
    ).run(alias, code, "user", "confirmed", 1, "用户确认");
    return;
  }
  db.prepare(
    `UPDATE course_alias SET status='rejected', source='user', updated_at=datetime('now')
     WHERE alias=? AND course_code=?`,
  ).run(alias, code);
}

/** 某个科目当前是否允许 AI 辅助（答题入口据此校验，避免没勾选也算） */
export function isAiEnabled(db: DatabaseSync, code: string): boolean {
  const row = db
    .prepare("SELECT ai_enabled FROM subject WHERE course_code = ? AND active = 1")
    .get(code) as { ai_enabled: number } | undefined;
  return Boolean(row?.ai_enabled);
}

export const TEXTBOOK_DIR = paths.textbook;
