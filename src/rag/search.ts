import type { DatabaseSync } from "node:sqlite";
import { openTextbookDb } from "../db/index.js";
import { blobToVec, cosine, embeddingClient } from "../llm/client.js";
import { getEmbedConfig } from "../llm/models.js";

export interface Hit {
  chunkId: number;
  text: string;
  chapter: string;
  textbook: string;
  page: number | null;
  /** 融合后的分数，越大越相关 */
  score: number;
  via: string[];
  /**
   * 来自哪个教材库文件（如 course-phy2.db）。
   * `chunkId` 只在单个库内唯一，跨科目合并必须靠 file 一起定位。
   */
  file?: string;
}

interface ChunkRow {
  id: number;
  text: string;
  page_from: number | null;
  chapter: string | null;
  textbook: string | null;
  chapter_no: number | null;
}

/**
 * 章节门控（M2 L1 硬闸）。
 *
 * - `null`  = 还没设进度：不过滤，进提示词里说明，由模型自己收敛用已学方法
 * - 空集合  = 已设进度但一章都没学：只放行题库切片（`chapter_no IS NULL`）
 * - 非空    = 只放行已学章节 + 题库切片
 *
 * 未学章节的教材正文根本不进上下文——模型看不见，就用不出来。
 * 这比在提示词里写「不要用泰勒公式」可靠得多（模型会忘、会绕）。
 */
export type LearnedFilter = Set<number> | null;

function chapterClause(filter: LearnedFilter, alias = "ch"): { sql: string; params: number[] } {
  if (!filter) return { sql: "", params: [] };
  const ids = [...filter]
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b)
    .slice(0, 200);
  if (ids.length === 0) return { sql: ` AND ${alias}.chapter_no IS NULL`, params: [] };
  const marks = ids.map(() => "?").join(",");
  return {
    sql: ` AND (${alias}.chapter_no IS NULL OR ${alias}.chapter_no IN (${marks}))`,
    params: ids,
  };
}

const OPEN_QUERY = `
  SELECT c.id, c.text, c.page_from,
         ch.title AS chapter, ch.chapter_no AS chapter_no, tb.title AS textbook
  FROM chunk c
  LEFT JOIN chapter ch ON ch.id = c.chapter_id
  LEFT JOIN textbook tb ON tb.id = c.textbook_id
`;

/**
 * 教材库连接缓存。
 *
 * 从"只缓存一个文件"改成小型 LRU：跨科目检索会交替打开多个库，
 * 单槽缓存每次都要重开、且旧连接没人关（Node 的 DatabaseSync 不会自动回收）。
 * 这里最多同时留 4 个，超出时关掉最久未用的那个。
 */
const DB_CACHE_LIMIT = 4;
const dbCache = new Map<string, DatabaseSync>();

function getDb(file: string): DatabaseSync {
  const hit = dbCache.get(file);
  if (hit) {
    // 命中即刷新 LRU 顺序
    dbCache.delete(file);
    dbCache.set(file, hit);
    return hit;
  }
  const db = openTextbookDb(file);
  dbCache.set(file, db);
  if (dbCache.size > DB_CACHE_LIMIT) {
    const oldest = dbCache.keys().next().value;
    if (oldest != null && oldest !== file) {
      const stale = dbCache.get(oldest);
      dbCache.delete(oldest);
      try {
        stale?.close();
      } catch {
        /* 关不掉也不影响使用 */
      }
    }
  }
  return db;
}

/** 全文检索（FTS5 + bm25） */
export function ftsSearch(file: string, query: string, k = 8, filter: LearnedFilter = null): Hit[] {
  const db = getDb(file);
  // 中文用 FTS5 的 unicode61 按单字切分，若直接喂单字会命中一切含该字的段落。
  // 因此只取「二字词组」做短语匹配，ASCII 词整词匹配。
  const terms = new Set<string>();
  for (const word of query.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, " ").split(/\s+/)) {
    if (!word) continue;
    if (/^[a-zA-Z0-9]+$/.test(word)) {
      terms.add(`"${word}"`);
      continue;
    }
    for (let i = 0; i + 2 <= word.length; i++) terms.add(`"${word.slice(i, i + 2)}"`);
  }
  if (terms.size === 0) return [];
  const expr = [...terms].slice(0, 40).join(" OR ");
  const gate = chapterClause(filter);

  let rows: Array<ChunkRow & { bm: number }> = [];
  try {
    rows = db
      .prepare(
        `SELECT c.id, c.text, c.page_from, ch.title AS chapter, ch.chapter_no AS chapter_no,
                tb.title AS textbook, bm25(chunk_fts) AS bm
         FROM chunk_fts
         JOIN chunk c ON c.id = chunk_fts.rowid
         LEFT JOIN chapter ch ON ch.id = c.chapter_id
         LEFT JOIN textbook tb ON tb.id = c.textbook_id
         WHERE chunk_fts MATCH ?${gate.sql}
         ORDER BY bm
         LIMIT ?`,
      )
      .all(expr, ...gate.params, k) as unknown as Array<ChunkRow & { bm: number }>;
  } catch {
    return [];
  }

  return rows.map((r, i) => ({
    chunkId: r.id,
    text: r.text,
    chapter: r.chapter ?? "未分章",
    textbook: r.textbook ?? "未知",
    page: r.page_from,
    score: 1 / (i + 1),
    via: ["全文"],
  }));
}

/** 查询向量：一次解题只该算一次，三处复用（向量检索 / 重排 / 题库比对） */
export async function embedQuery(text: string): Promise<Float32Array> {
  const cfg = getEmbedConfig();
  const client = embeddingClient();
  const res = await client.embeddings.create({ model: cfg.model, input: [text.slice(0, 1000)] });
  return Float32Array.from(res.data[0]!.embedding as number[]);
}

/** 向量检索（暴力余弦，1500 片规模下毫秒级） */
export async function vecSearch(
  file: string,
  query: string,
  k = 8,
  qvIn?: Float32Array,
  filter: LearnedFilter = null,
): Promise<Hit[]> {
  const db = getDb(file);
  const qv = qvIn ?? (await embedQuery(query));
  const gate = chapterClause(filter);

  const rows = db
    .prepare(`${OPEN_QUERY} JOIN chunk_vec v ON v.chunk_id = c.id WHERE 1=1${gate.sql}`)
    .all(...gate.params) as unknown as ChunkRow[];
  const vecs = db.prepare("SELECT chunk_id, dim, vec FROM chunk_vec").all() as unknown as Array<{
    chunk_id: number;
    dim: number;
    vec: Uint8Array;
  }>;

  const byId = new Map(rows.map((r) => [r.id, r]));
  const scored: Array<{ id: number; s: number }> = [];
  for (const v of vecs) {
    // 门控过滤掉的切片不进候选；没有过滤时 byId 全集，行为不变
    if (!byId.has(v.chunk_id)) continue;
    const arr = blobToVec(v.vec, v.dim);
    scored.push({ id: v.chunk_id, s: cosine(qv, arr) });
  }
  scored.sort((a, b) => b.s - a.s);

  return scored.slice(0, k).map(({ id, s }) => {
    const r = byId.get(id);
    return {
      chunkId: id,
      text: r?.text ?? "",
      chapter: r?.chapter ?? "未分章",
      textbook: r?.textbook ?? "未知",
      page: r?.page_from ?? null,
      score: s,
      via: ["向量"],
    };
  });
}

/**
 * RRF（Reciprocal Rank Fusion）融合两路结果。
 * 单一检索都有系统性偏差：全文怕同义改写，向量怕精确术语与数字。
 */
export function fuse(a: Hit[], b: Hit[], k = 8): Hit[] {
  const acc = new Map<number, Hit & { rrf: number }>();
  const add = (list: Hit[], tag: string): void => {
    list.forEach((h, i) => {
      const cur = acc.get(h.chunkId);
      const gain = 1 / (60 + i + 1);
      if (cur) {
        cur.rrf += gain;
        if (!cur.via.includes(tag)) cur.via.push(tag);
      } else {
        acc.set(h.chunkId, { ...h, via: [tag], rrf: gain });
      }
    });
  };
  add(a, "全文");
  add(b, "向量");

  return [...acc.values()]
    .sort((x, y) => y.rrf - x.rrf)
    .slice(0, k)
    .map((h) => ({ ...h, score: Number(h.rrf.toFixed(5)) }));
}

export async function retrieve(
  file: string,
  query: string,
  k = 6,
  qvIn?: Float32Array,
  filter: LearnedFilter = null,
): Promise<Hit[]> {
  // 查询向量只算一次：向量检索、融合重排、题库比对共用同一个 qv。
  // 之前一次解题要打三次 embedding 接口，纯属白等。
  const qv = qvIn ?? (await embedQuery(query));
  const [lex, sem] = await Promise.all([
    Promise.resolve(ftsSearch(file, query, k * 3, filter)),
    vecSearch(file, query, k * 3, qv, filter).catch(() => [] as Hit[]),
  ]);
  const fused = fuse(lex, sem, k * 3);
  if (fused.length === 0) return [];
  // 融合后按查询余弦相似度重排：RRF 只反映"两路都靠前"，
  // 不反映与问题的真实语义接近程度，必须再校准一次。
  const db = getDb(file);

  const stmt = db.prepare("SELECT dim, vec FROM chunk_vec WHERE chunk_id = ?");
  const reranked = fused.map((h) => {
    const row = stmt.get(h.chunkId) as { dim: number; vec: Uint8Array } | undefined;
    const cos = row ? cosine(qv, blobToVec(row.vec, row.dim)) : 0;
    return { ...h, score: Number(cos.toFixed(4)) };
  });
  reranked.sort((a, b) => b.score - a.score);
  return reranked.slice(0, k);
}

export interface CourseSource {
  /** 教材库文件名，例如 course-phy2.db */
  file: string;
  /** 该科目自己的已学章节过滤；null / 不传 = 不设进度、不过滤 */
  filter?: LearnedFilter;
}

/**
 * 跨库结果合并（纯函数，不碰 DB / 不调模型，可单测）。
 *
 * 用 RRF：每个库的候选是各自 top-k，直接比余弦会把"小库里的第一"和"大库里的第一"
 * 放在同一尺度上；RRF 只看名次，跨库更稳。
 * 去重键必须是 `file#chunkId`——`chunkId` 只在单库内唯一。
 */
export function mergeCourseHits(lists: Hit[][], k: number): Hit[] {
  const acc = new Map<string, Hit & { rrf: number }>();
  for (const list of lists) {
    list.forEach((h, i) => {
      const key = `${h.file ?? ""}#${h.chunkId}`;
      const gain = 1 / (60 + i + 1);
      const cur = acc.get(key);
      if (cur) {
        cur.rrf += gain;
        if (!cur.via.includes("跨库")) cur.via.push("跨库");
      } else {
        acc.set(key, { ...h, rrf: gain });
      }
    });
  }
  return [...acc.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, k)
    .map((h) => ({ ...h, score: Number(h.rrf.toFixed(5)) }));
}

/**
 * 跨科目联合检索。
 *
 * 关键点：门控必须**按科目各用各的**——拿物理的已学集合去过滤高数的切片，
 * 只会把高数内容整个挡掉或整个放行，两种都是错的。
 */
export async function retrieveMany(
  sources: CourseSource[],
  query: string,
  k = 6,
  qvIn?: Float32Array,
): Promise<Hit[]> {
  if (sources.length === 0) return [];
  if (sources.length === 1) {
    const only = sources[0]!;
    const hits = await retrieve(only.file, query, k, qvIn, only.filter ?? null);
    return hits.map((h) => ({ ...h, file: only.file }));
  }

  const qv = qvIn ?? (await embedQuery(query));
  const lists = await Promise.all(
    sources.map(async (s) => {
      try {
        const hits = await retrieve(s.file, query, k * 2, qv, s.filter ?? null);
        return hits.map((h) => ({ ...h, file: s.file }));
      } catch {
        // 单个教材库缺失/损坏，不能让整次多科目检索失败
        return [] as Hit[];
      }
    }),
  );
  return mergeCourseHits(lists, k);
}

/** 教材库是否可用及其元信息 */
export function textbookInfo(file: string): { ok: boolean; chunks: number; version: string } {
  try {
    const db = getDb(file);
    const n = Number((db.prepare("SELECT COUNT(*) c FROM chunk").get() as { c: number }).c);
    const v = db.prepare("SELECT value FROM meta WHERE key='version'").get() as
      | { value: string }
      | undefined;
    return { ok: true, chunks: n, version: v?.value ?? "" };
  } catch {
    return { ok: false, chunks: 0, version: "" };
  }
}
