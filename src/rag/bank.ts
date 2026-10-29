import type { DatabaseSync } from "node:sqlite";
import { openTextbookDb } from "../db/index.js";
import { blobToVec, cosine } from "../llm/client.js";
import { embedQuery } from "./search.js";

/**
 * 题库检索层：解题前先问「题库里有没有这道题」。
 *
 * 与教材检索（search.ts）的区别：
 * - 教材检索回答「该讲哪段知识」，结果必然是教材正文切片。
 * - 题库检索回答「这道题题库里有没有、有没有标准答案」，结果必须是**题目**。
 *
 * 题库本体是 textbook.db 里 textbook.title = 题库名 的那批 chunk
 * （由 scripts/build-textbook.ts 从题库 docx 按题切分），所以不需要新表、
 * 也不需要重新向量化——直接复用 chunk_vec。
 */

/** 题库在 textbook.db 里的 textbook.title，换语料时可用环境变量覆盖 */
export const BANK_TITLE = process.env.QUESTION_BANK_NAME ?? "清华题库";

/**
 * 同题 / 相似题阈值。
 * 实测（2026-10，956 道题，qwen3.7-text-embedding）：原题命中自己 0.968~0.971，
 * 同章节不同题最高 0.779，跨科无关题 0.35~0.41。
 * 0.90 留出转录误差余量，同时离负样本（0.78）有 0.12 间距。
 */
export const HIT_COSINE = 0.9;
export const SIMILAR_COSINE = 0.8;

export type QuestionKind = "choice" | "fill" | "calc" | "unknown";

const KIND_LABEL: Record<QuestionKind, string> = {
  choice: "选择题",
  fill: "填空题",
  calc: "计算题",
  unknown: "题型未知",
};

export function kindLabel(k: QuestionKind): string {
  return KIND_LABEL[k];
}

/** 题库里的一道题 */
export interface BankQuestion {
  chunkId: number;
  /** 题库原始题号，如 "0148"；提取不到为 null */
  qno: string | null;
  kind: QuestionKind;
  chapter: string;
  /** 题干（计算题题库只存解答时为空串） */
  stem: string;
  /** 标准答案 / 解答；题库没给答案则为 null */
  answer: string | null;
}

export type BankVerdict = "same" | "close" | "none";

export interface BankLookup {
  verdict: BankVerdict;
  /** verdict === "same" 才为 true：可以拿题库答案当基准 */
  hit: boolean;
  score: number;
  question: BankQuestion | null;
  /** 题库总题数，便于排查「库是空的」 */
  total: number;
  /** 未命中时的原因说明（空库 / 题目太短 / 无向量） */
  reason: string;
}

const QNO_RE = /^\s*\d+\s*[．.、]\s*(\d{3,4})\s*[：:]\s*/;
const ANSWER_RE = /(?:^|\s)(?:解|答)\s*[：:]/;

/**
 * 解析题库切片文本。
 * 题号形如「1．0148：题干…」，答案形如「解：…」「答：…」。
 */
export function parseBankQuestion(text: string, chunkId = 0, chapter = ""): BankQuestion {
  const qno = text.match(QNO_RE)?.[1] ?? null;
  let body = text.replace(QNO_RE, "").trim();

  let answer: string | null = null;
  const m = body.match(ANSWER_RE);
  if (m?.index !== undefined) {
    const cut = body.indexOf(m[0]);
    answer = body.slice(cut + m[0].length).trim() || null;
    body = body.slice(0, cut).trim();
  }
  // 太短的「答案」多半是误切（例如题干里出现「答：」），不当作标准答案
  if (answer !== null && answer.length < 20) answer = null;

  return {
    chunkId,
    qno,
    kind: detectKind(text),
    chapter,
    stem: body,
    answer,
  };
}

/**
 * 题型判定靠文本特征，不靠模型：
 * 这是「必须等于」类判断（AGENTS.md 第三节），错了会影响后续出卷配比。
 */
export function detectKind(text: string): QuestionKind {
  if (/_{3,}|＿{2,}/.test(text)) return "fill";
  if (/[（(]\s*[A-EＡ-Ｅ]\s*[)）]/.test(text)) return "choice";
  if (/解\s*[：:]|答\s*[：:]/.test(text)) return "calc";
  return "unknown";
}

/** 相似度 → 判定。纯函数，测试直接断言，不调模型。 */
export function classifyBankScore(score: number): BankVerdict {
  if (score >= HIT_COSINE) return "same";
  if (score >= SIMILAR_COSINE) return "close";
  return "none";
}

interface BankIndex {
  questions: BankQuestion[];
  vecs: Map<number, Float32Array>;
}

const indexCache = new Map<string, BankIndex>();

function loadIndex(file: string): BankIndex {
  const cached = indexCache.get(file);
  if (cached) return cached;

  const db: DatabaseSync = openTextbookDb(file);
  const rows = db
    .prepare(
      `SELECT c.id, c.text, ch.title AS chapter
       FROM chunk c
       JOIN textbook tb ON tb.id = c.textbook_id
       LEFT JOIN chapter ch ON ch.id = c.chapter_id
       WHERE tb.title = ?
       ORDER BY c.id`,
    )
    .all(BANK_TITLE) as unknown as Array<{ id: number; text: string; chapter: string | null }>;

  const questions: BankQuestion[] = [];
  const vecs = new Map<number, Float32Array>();
  const vecStmt = db.prepare("SELECT dim, vec FROM chunk_vec WHERE chunk_id = ?");
  for (const r of rows) {
    const q = parseBankQuestion(r.text, r.id, r.chapter ?? "未分章");
    // 只保留像「题」的切片：题库 docx 的封面、目录、答案说明会被切进来
    if (q.stem.length < 15 && q.answer === null) continue;
    questions.push(q);
    const v = vecStmt.get(r.id) as { dim: number; vec: Uint8Array } | undefined;
    if (v) vecs.set(r.id, blobToVec(v.vec, v.dim));
  }
  db.close();

  const index = { questions, vecs };
  indexCache.set(file, index);
  return index;
}

/** 冷启动时预热题库索引（可选，便于 /api/health 报题库题数） */
export function bankSize(file: string): number {
  try {
    return loadIndex(file).questions.length;
  } catch {
    return 0;
  }
}

export function clearBankCache(): void {
  indexCache.clear();
}

/**
 * 在题库里找这道题。
 * 没有题库、题目太短、向量缺失都返回 verdict "none"，由调用方决定「让模型自己答」。
 */
export async function lookupBank(
  file: string,
  question: string,
  qvIn?: Float32Array,
): Promise<BankLookup> {
  const empty = (reason: string, total = 0): BankLookup => ({
    verdict: "none",
    hit: false,
    score: 0,
    question: null,
    total,
    reason,
  });

  const q = question.trim();
  if (q.length < 6) return empty("题目太短，无法检索");

  let index: BankIndex;
  try {
    index = loadIndex(file);
  } catch (e) {
    return empty(`教材库打不开：${(e as Error).message}`);
  }
  if (index.questions.length === 0) return empty(`题库为空（textbook.title = ${BANK_TITLE}）`);
  if (index.vecs.size === 0) return empty("题库没有向量，无法按语义比对", index.questions.length);

  const qv = qvIn ?? (await embedQuery(q.slice(0, 1000)));

  let best: { id: number; score: number } | null = null;
  for (const [id, v] of index.vecs) {
    const s = cosine(qv, v);
    if (!best || s > best.score) best = { id, score: s };
  }
  if (!best) return empty("题库没有向量", index.questions.length);

  const question_ = index.questions.find((x) => x.chunkId === best.id) ?? null;
  const verdict = classifyBankScore(best.score);
  return {
    verdict,
    hit: verdict === "same",
    score: Number(best.score.toFixed(4)),
    question: question_,
    total: index.questions.length,
    reason: verdict === "none" ? "题库里没有足够相似的题" : "",
  };
}

/**
 * 拼给模型的「题库检索结果」段。
 * 三种状态必须让模型看得懂，否则它会把相似题当原题、或把无答案当有答案。
 */
export function bankPromptBlock(lookup: BankLookup): string {
  const q = lookup.question;
  const note = "（题库原文由 docx 提取，公式与插图位置为空，空处不代表内容缺失）";

  if (!q || lookup.verdict === "none") {
    return `未命中。题库（${lookup.total} 题）中没有找到与本题足够相似的题目，本题由你独立求解。`;
  }

  const head = `题号 ${q.qno ?? "（无）"}，${kindLabel(q.kind)}，所属 ${q.chapter}，相似度 ${lookup.score.toFixed(3)}`;

  if (lookup.verdict === "close") {
    const ans = q.answer
      ? `\n题库解答（供参考，可能对应另一道题）：\n${q.answer}`
      : "\n题库中这道相似题没有答案。";
    return [
      `相似但未确认同题：${head}`,
      "题库里有一道高度相似的题，但不确认与用户给的是同一道。",
      `题库原文：\n${q.stem || "（题库只存了解答，无题干）"}`,
      ans,
      "请自行核对是否同一道：是同一道才采用题库答案，不是则独立求解并说明差异。",
      note,
    ].join("\n");
  }

  if (q.answer) {
    return [
      `命中且有答案：${head}`,
      `题库原文：\n${q.stem || "（题库只存了解答，无题干）"}`,
      `题库解答：\n${q.answer}`,
      note,
    ].join("\n");
  }

  return [
    `命中但题库无答案：${head}`,
    `题库原文：\n${q.stem || "（题库只存了解答，无题干）"}`,
    "题库收录了这道题，但没有提供标准答案，本题由你独立求解。",
    note,
  ].join("\n");
}
