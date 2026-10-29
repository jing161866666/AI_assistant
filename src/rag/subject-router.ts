import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { llm } from "../llm/client.js";
import { getLlmConfig } from "../llm/models.js";
import { type AiCandidate, aiCandidates } from "../memory/subjects.js";

/**
 * 科目分流：用户勾选允许 AI 辅助的科目，qwen 只能在这个集合里挑一个最可能的。
 *
 * 分工（AGENTS 第一节）：
 *   "这道题属于哪一科" = 判断 → 模型。
 *   "能不能写进这一科" = 硬约束 → 代码（白名单校验 + 用户确认）。
 *
 * 关键：模型**不许**自己扩大范围。它只能在 aiCandidates() 给出的代码里选，
 * 选不到就填 unsure；写库前还要再过一次 matchSubjectGuess()。
 */

export interface RoutingContext {
  /** 直接拼进 profileText 的提示词段落 */
  text: string;
  /** 用户勾选的候选科目（qwen 的可选集合） */
  candidates: AiCandidate[];
  current: { code: string; name: string };
}

function candidateLine(c: AiCandidate): string {
  const progress = c.maxChapterNo == null ? "还没设进度" : `已学到第 ${c.maxChapterNo} 章`;
  const kb = c.textbookReady ? `知识库 ${c.chapters} 章` : "知识库未构建";
  return `- ${c.code} ${c.name}（${progress}；${kb}）`;
}

/**
 * 组装【科目路由】提示段落。
 * 放在用户消息最前面（profileText 之后），让模型先看到"当前科目"和"可选科目"。
 */
export function buildRoutingContext(
  db: DatabaseSync,
  current: { code: string; name: string },
): RoutingContext {
  const candidates = aiCandidates(db);
  const lines: string[] = ["【科目路由】", `当前科目：${current.code} ${current.name}`];

  if (candidates.length === 0) {
    lines.push("用户还没有勾选任何允许 AI 辅助的科目：subject_guess 固定填 unsure，不要猜。");
  } else {
    lines.push("用户勾选允许 AI 辅助的科目（subject_guess 只能从这些代码里选）：");
    for (const c of candidates) lines.push(candidateLine(c));
    lines.push(
      "判定规则：",
      "1. 按题目内容判断它属于哪一科，不要因为「当前科目」是它，就默认这道题属于它。",
      "2. subject_guess 只填一个科目代码（大写，如上表），没有任何候选贴合时填 unsure。",
      "3. 这一步只判断题目归属，不影响你继续按题目本身作答。",
    );
  }

  return { text: lines.join("\n"), candidates, current };
}

function normalizeName(s: string): string {
  return s
    .replace(/\s+/g, "")
    .replace(/[（）()]/g, "")
    .toLowerCase();
}

/**
 * 把模型给的 subject_guess 收敛到候选白名单里。
 *
 * 模型可能返回代码、科目名、或「科目名（代码）」。三种都认；
 * 认不出来一律 null（= 未归类），绝不猜成"当前科目"。
 */
export function matchSubjectGuess(raw: string, candidates: AiCandidate[]): AiCandidate | null {
  const guess = String(raw ?? "").trim();
  if (!guess) return null;
  const low = guess.toLowerCase();
  if (low === "unsure" || low === "unknown" || low === "none" || low === "不确定") return null;

  // 1) 直接是代码
  const upper = guess.toUpperCase();
  const byCode = candidates.find((c) => c.code === upper);
  if (byCode) return byCode;

  // 2) 文本里出现候选代码（如「物理 PHY2」）
  const byEmbeddedCode = candidates.find((c) =>
    new RegExp(`(^|[^A-Z0-9])${c.code}([^A-Z0-9]|$)`).test(upper),
  );
  if (byEmbeddedCode) return byEmbeddedCode;

  // 3) 科目名（去掉空格/括号后比较，兼容「大学物理（B）II」）
  const normGuess = normalizeName(guess);
  const exact = candidates.find((c) => normalizeName(c.name) === normGuess);
  if (exact) return exact;
  // 4) 科目名被包含（「这题是概率统计与随机过程的」）
  const contained = candidates.find((c) => {
    const n = normalizeName(c.name);
    return n.length >= 4 && normGuess.includes(n);
  });
  return contained ?? null;
}

export interface SubjectRoute {
  /** 模型原始输出（便于排查它为什么这么判） */
  raw: string;
  currentCode: string;
  currentName: string;
  /** 收敛到白名单后的科目；null = 未归类 / 模型说 unsure */
  code: string | null;
  name: string | null;
  /** true = 判成了别的科目（前端要提示，保存错题时默认存到 code） */
  mismatch: boolean;
  /** 给人看的一句话 */
  reason: string;
}

/** 把模型的 subject_guess 变成可展示、可落库的结论（纯函数，不碰 DB，可单测） */
export function resolveRoute(
  candidates: AiCandidate[],
  current: { code: string; name: string },
  rawGuess: string,
): SubjectRoute {
  const hit = matchSubjectGuess(rawGuess, candidates);
  if (!hit) {
    return {
      raw: rawGuess,
      currentCode: current.code,
      currentName: current.name,
      code: null,
      name: null,
      mismatch: false,
      reason: rawGuess.trim()
        ? `模型给出「${rawGuess.slice(0, 30)}」，但不在已勾选科目里，按未归类处理`
        : "模型没有给出科目判断（按未归类处理）",
    };
  }
  const mismatch = hit.code !== current.code;
  return {
    raw: rawGuess,
    currentCode: current.code,
    currentName: current.name,
    code: hit.code,
    name: hit.name,
    mismatch,
    reason: mismatch
      ? `这道题判为《${hit.name}》（${hit.code}），不是当前科目《${current.name}》`
      : `科目与当前一致（${hit.name}）`,
  };
}

/** 读库版：内部重新取一次候选集合，给非流式入口用 */
export function resolveSubjectRoute(
  db: DatabaseSync,
  current: { code: string; name: string },
  rawGuess: string,
): SubjectRoute {
  return resolveRoute(aiCandidates(db), current, rawGuess);
}

/** 单独给「问教材」用的分科调用（它没有结构化 META，只能补一次小模型） */
const routeSchema = z.object({ subject_guess: z.string().catch("") });

const ROUTE_SYSTEM = `你是教务分科助手。只做一件事：判断一道题属于下面哪门课。
只从给定的科目代码里选一个；都不像就填 "unsure"。不要解释，不要自造科目代码。
只输出 JSON：{"subject_guess":"代码或 unsure"}`;

export async function routeQuestion(question: string, routing: RoutingContext): Promise<string> {
  if (routing.candidates.length === 0) return "";
  const cfg = getLlmConfig("extract");
  const list = routing.candidates
    .map((c) => `- ${c.code} ${c.name}${c.textbookReady ? "" : "（暂无教材库）"}`)
    .join("\n");
  const r = await llm("extract").chat.completions.create({
    model: cfg.model,
    messages: [
      { role: "system", content: ROUTE_SYSTEM },
      {
        role: "user",
        content: `可选科目：\n${list}\n\n当前科目：${routing.current.code} ${routing.current.name}\n题目：\n${question.slice(0, 1200)}`,
      },
    ],
    max_tokens: 60,
    temperature: 0,
    response_format: { type: "json_object" },
  });
  const raw = r.choices[0]?.message?.content ?? "";
  try {
    return routeSchema.parse(JSON.parse(raw)).subject_guess;
  } catch {
    return "";
  }
}
