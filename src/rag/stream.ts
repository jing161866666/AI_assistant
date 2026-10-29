import type { z } from "zod";
import { llm } from "../llm/client.js";
import {
  CITATION_LIMIT,
  type Citation,
  type Detail,
  prepareReviewStream,
  prepareSolve,
  type ReviewPrep,
  reviewSchema,
  type SolveBankInfo,
  type SolvePrep,
  type SolveSource,
  userContent,
} from "./answer.js";
import type { LearnedFilter } from "./search.js";

/**
 * 流式解题 / 批改。
 *
 * 为什么不是简单地把 JSON 拆成流：判断学生输入是什么、判对错，都是结构化结论，
 * 需要一次性得到；而详细推导是长文本，越早出字越好。所以约定模型先吐一行 META JSON，
 * 再吐 Markdown 正文——一次调用同时满足两件事，不增加对话轮次。
 */

export type GradeMeta = z.infer<typeof reviewSchema>;

export type StreamEvent =
  | {
      type: "meta";
      mode: "solve";
      source: SolveSource;
      bank: SolveBankInfo | null;
      citations: Citation[];
      model: string;
    }
  | { type: "meta"; mode: "grade"; citations: Citation[]; model: string }
  | { type: "grade"; grade: GradeMeta; degraded: boolean }
  /** 科目分流结论：判成了别的已勾选科目时 mismatch=true */
  | { type: "subject"; route: import("./subject-router.js").SubjectRoute }
  | { type: "delta"; text: string }
  /** 进度门控：解答用到了学生还没学的章节（给免责说明用） */
  | {
      type: "beyond";
      beyond: BeyondItem[];
      /** 模型判为越界但定位不到章节的，降级成"可能越界" */
      uncertain?: BeyondItem[];
      maxChapterNo: number | null;
    }
  /** 附注（其它提示），不影响正文 */
  | { type: "note"; text: string }
  /** 这一轮已入库：前端拿 id 存 localStorage，刷新后据此恢复 */
  | { type: "turn"; conversationId: number; messageId: number }
  | { type: "done"; ms: number; model: string }
  | { type: "error"; message: string };

/** 与 web 端 BeyondNotice 的入参保持一致，结构由 progress-guard 决定 */
export interface BeyondItem {
  topic: string;
  chapter_no: number | null;
  why: string;
}

const META_OPEN = "[[META]]";
const META_CLOSE = "[[/META]]";
/** 模型不按格式走时的容忍上限：超过这么多字还没等到 META 就不再等 */
const META_GIVE_UP = 1500;

const EMPTY_GRADE: GradeMeta = {
  verdict: "unsolved",
  input_kind: "unknown",
  error_type: "none",
  cause: "",
  correction: "",
  hints: [],
  related_kps: [],
  subject_guess: "",
};

interface StreamBody {
  system: string;
  userText: string;
  images?: string[];
  maxTokens: number;
  temperature: number;
  model: string;
  role?: "reason" | "fast";
}

async function* rawDeltas(prep: StreamBody): AsyncGenerator<string> {
  const s = await llm(prep.role ?? "reason").chat.completions.create({
    model: prep.model,
    messages: [
      { role: "system", content: prep.system },
      { role: "user", content: userContent(prep.userText, prep.images) },
    ],
    max_tokens: prep.maxTokens,
    temperature: prep.temperature,
    stream: true,
  });
  for await (const chunk of s) {
    const d = chunk.choices[0]?.delta?.content;
    if (d) yield d;
  }
}

function parseGrade(raw: string): GradeMeta {
  try {
    return reviewSchema.parse(JSON.parse(raw));
  } catch {
    return { ...EMPTY_GRADE };
  }
}

/** 纯解题：结构化信息全在服务端已知，可以先发 meta 再流正文 */
export async function* solveStream(
  file: string,
  question: string,
  opts: {
    k?: number;
    images?: string[];
    studentInput?: string;
    profileText?: string;
    detail?: Detail;
    /** 章节门控：未学章节的正文不进上下文（未设进度时传 null） */
    filter?: LearnedFilter;
    /** 速度档：smart（默认）/ fast（用户主动选，换更快的小模型） */
    speed?: "smart" | "fast";
  } = {},
): AsyncGenerator<StreamEvent> {
  const t0 = Date.now();
  let prep: SolvePrep;
  try {
    prep = await prepareSolve(
      file,
      question,
      opts.k ?? CITATION_LIMIT,
      opts.images,
      opts.studentInput,
      opts.profileText,
      opts.detail ?? "full",
      opts.filter ?? null,
      opts.speed ?? "smart",
    );
  } catch (e) {
    yield { type: "error", message: (e as Error).message };
    return;
  }

  yield {
    type: "meta",
    mode: "solve",
    source: prep.source,
    bank: prep.bank,
    citations: prep.citations,
    model: prep.model,
  };

  try {
    for await (const d of rawDeltas({ ...prep, role: prep.role })) yield { type: "delta", text: d };
  } catch (e) {
    yield { type: "error", message: (e as Error).message };
    return;
  }
  yield { type: "done", ms: Date.now() - t0, model: prep.model };
}

/** 批改：判定要等模型先吐出 META 行，正文随后流式输出 */
export async function* reviewStream(
  file: string,
  question: string,
  myAnswer: string,
  correctAnswer?: string,
  images?: string[],
  profileText?: string,
  detail: Detail = "full",
  filter: LearnedFilter = null,
): AsyncGenerator<StreamEvent> {
  const t0 = Date.now();
  let prep: ReviewPrep;
  try {
    prep = await prepareReviewStream(
      file,
      question,
      myAnswer,
      correctAnswer,
      images,
      profileText,
      detail,
      filter,
    );
  } catch (e) {
    yield { type: "error", message: (e as Error).message };
    return;
  }

  yield { type: "meta", mode: "grade", citations: prep.citations, model: prep.model };

  // 首段先攒够 META 再决定怎么渲染；之后一律直通
  let phase: "meta" | "body" = "meta";
  let pending = "";

  const flushMeta = function* (rest: string): Generator<StreamEvent> {
    if (rest) {
      const text = rest.replace(/^\s+/, "");
      if (text) yield { type: "delta", text };
    }
  };

  try {
    for await (const d of rawDeltas(prep)) {
      if (phase === "body") {
        yield { type: "delta", text: d };
        continue;
      }
      pending += d;
      const open = pending.indexOf(META_OPEN);
      const close = pending.indexOf(META_CLOSE);
      if (open >= 0 && close > open) {
        const json = pending.slice(open + META_OPEN.length, close);
        yield { type: "grade", grade: parseGrade(json), degraded: false };
        const rest = pending.slice(close + META_CLOSE.length);
        pending = "";
        phase = "body";
        yield* flushMeta(rest);
        continue;
      }
      if (pending.length > META_GIVE_UP) {
        // 模型没按格式走：别把用户卡住，正文照常流出来，只是判定标为降级
        yield { type: "grade", grade: { ...EMPTY_GRADE }, degraded: true };
        const rest = pending;
        pending = "";
        phase = "body";
        yield* flushMeta(rest);
      }
    }
  } catch (e) {
    yield { type: "error", message: (e as Error).message };
    return;
  }

  if (phase === "meta") {
    // 流结束了还没见到 META：整段都是正文
    yield { type: "grade", grade: { ...EMPTY_GRADE }, degraded: true };
    yield* flushMeta(pending);
  }
  yield { type: "done", ms: Date.now() - t0, model: prep.model };
}
