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
}

interface ChunkRow {
  id: number;
  text: string;
  page_from: number | null;
  chapter: string | null;
  textbook: string | null;
}

const OPEN_QUERY = `
  SELECT c.id, c.text, c.page_from,
         ch.title AS chapter, tb.title AS textbook
  FROM chunk c
  LEFT JOIN chapter ch ON ch.id = c.chapter_id
  LEFT JOIN textbook tb ON tb.id = c.textbook_id
`;

let cached: { path: string; db: DatabaseSync } | null = null;

function getDb(file: string): DatabaseSync {
  if (cached && cached.path === file) return cached.db;
  const db = openTextbookDb(file);
  cached = { path: file, db };
  return db;
}

/** 全文检索（FTS5 + bm25） */
export function ftsSearch(file: string, query: string, k = 8): Hit[] {
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

  let rows: Array<ChunkRow & { bm: number }> = [];
  try {
    rows = db
      .prepare(
        `SELECT c.id, c.text, c.page_from, ch.title AS chapter, tb.title AS textbook,
                bm25(chunk_fts) AS bm
         FROM chunk_fts
         JOIN chunk c ON c.id = chunk_fts.rowid
         LEFT JOIN chapter ch ON ch.id = c.chapter_id
         LEFT JOIN textbook tb ON tb.id = c.textbook_id
         WHERE chunk_fts MATCH ?
         ORDER BY bm
         LIMIT ?`,
      )
      .all(expr, k) as unknown as Array<ChunkRow & { bm: number }>;
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

/** 向量检索（暴力余弦，1500 片规模下毫秒级） */
export async function vecSearch(file: string, query: string, k = 8): Promise<Hit[]> {
  const db = getDb(file);
  const cfg = getEmbedConfig();
  const client = embeddingClient();
  const res = await client.embeddings.create({ model: cfg.model, input: [query] });
  const qv = Float32Array.from(res.data[0]!.embedding as number[]);

  const rows = db
    .prepare(`${OPEN_QUERY} JOIN chunk_vec v ON v.chunk_id = c.id`)
    .all() as unknown as ChunkRow[];
  const vecs = db.prepare("SELECT chunk_id, dim, vec FROM chunk_vec").all() as unknown as Array<{
    chunk_id: number;
    dim: number;
    vec: Uint8Array;
  }>;

  const byId = new Map(rows.map((r) => [r.id, r]));
  const scored: Array<{ id: number; s: number }> = [];
  for (const v of vecs) {
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

export async function retrieve(file: string, query: string, k = 6): Promise<Hit[]> {
  const [lex, sem] = await Promise.all([
    Promise.resolve(ftsSearch(file, query, k * 3)),
    vecSearch(file, query, k * 3).catch(() => [] as Hit[]),
  ]);
  const fused = fuse(lex, sem, k * 3);
  if (fused.length === 0) return [];
  // 融合后按查询余弦相似度重排：RRF 只反映"两路都靠前"，
  // 不反映与问题的真实语义接近程度，必须再校准一次。
  const db = getDb(file);
  const cfg = getEmbedConfig();
  const client = embeddingClient();
  const res = await client.embeddings.create({ model: cfg.model, input: [query] });
  const qv = Float32Array.from(res.data[0]!.embedding as number[]);

  const stmt = db.prepare("SELECT dim, vec FROM chunk_vec WHERE chunk_id = ?");
  const reranked = fused.map((h) => {
    const row = stmt.get(h.chunkId) as { dim: number; vec: Uint8Array } | undefined;
    const cos = row ? cosine(qv, blobToVec(row.vec, row.dim)) : 0;
    return { ...h, score: Number(cos.toFixed(4)) };
  });
  reranked.sort((a, b) => b.score - a.score);
  return reranked.slice(0, k);
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
