import type { BankMatch, Citation } from "./types.ts";

/**
 * 客户端 SSE 解析。
 *
 * 用 fetch + ReadableStream 而不是 EventSource：EventSource 只能 GET，
 * 题目/作答/图片都得放 body 里 POST 过去。
 */

export interface GradeMeta {
  verdict: "correct" | "partially" | "wrong" | "unsolved";
  input_kind: "answer" | "process" | "question" | "empty" | "unknown";
  error_type: string;
  cause: string;
  correction: string;
  hints: string[];
  related_kps: string[];
  /** 模型给的科目代码（未校验）；服务端已另发 subject 事件 */
  subject_guess?: string;
}

export interface BeyondItem {
  topic: string;
  chapter_no: number | null;
  why: string;
}

export interface StreamResult {
  mode: "solve" | "grade";
  source?: "bank-answer" | "bank-no-answer" | "model-only";
  bank?: BankMatch | null;
  citations: Citation[];
  model?: string;
  ms?: number;
  grade?: GradeMeta;
  /** 模型没按 META 格式走时为 true（判定不可信，正文照常显示） */
  degraded?: boolean;
  /** 解答用到了还没学的章节，给 BeyondNotice 用 */
  beyond?: BeyondItem[];
  /** 模型判为越界但定位不到章节：降级成"可能越界"提示 */
  uncertain?: BeyondItem[];
  maxChapterNo?: number | null;
  /** 这一轮在本地库里的 id：存 localStorage，刷新后据此恢复 */
  turn?: { conversationId: number; messageId: number };
  /** 科目分流：qwen 在用户勾选科目里选出的最可能科目 */
  subject?: import("./types.ts").SubjectRoute;
  text: string;
  notes: string[];
}

export type StreamEvent =
  | {
      type: "meta";
      mode: "solve";
      source: StreamResult["source"];
      bank: BankMatch | null;
      citations: Citation[];
      model: string;
    }
  | { type: "meta"; mode: "grade"; citations: Citation[]; model: string }
  | { type: "grade"; grade: GradeMeta; degraded: boolean }
  | { type: "subject"; route: import("./types.ts").SubjectRoute }
  | { type: "delta"; text: string }
  | {
      type: "beyond";
      beyond: BeyondItem[];
      uncertain?: BeyondItem[];
      maxChapterNo: number | null;
    }
  | { type: "note"; text: string }
  | { type: "turn"; conversationId: number; messageId: number }
  | { type: "done"; ms: number; model: string }
  | { type: "error"; message: string };

const FLUSH_MS = 100;

export interface StreamInput {
  question: string;
  myAnswer?: string;
  correctAnswer?: string;
  images?: string[];
  answerImages?: string[];
  detail?: "full" | "brief";
  /** 科目：后端不再有隐式默认，必须显式带上 */
  course: string;
}

/**
 * 跑一次流式解题 / 批改。
 * onPartial 会被高频调用（正文增量），调用方负责节流渲染；
 * 返回值是最终结果，方便调用方一次性落库/存错题。
 */
export async function runStream(
  input: StreamInput,
  onPartial: (acc: StreamResult) => void,
): Promise<StreamResult> {
  const res = await fetch("/api/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(text.slice(0, 200) || `请求失败 ${res.status}`);
  }

  const acc: StreamResult = {
    mode: input.myAnswer ? "grade" : "solve",
    citations: [],
    text: "",
    notes: [],
  };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let lastFlush = 0;

  const flush = (force = false): void => {
    const now = Date.now();
    if (!force && now - lastFlush < FLUSH_MS) return;
    lastFlush = now;
    onPartial({ ...acc });
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let idx = buf.indexOf("\n\n");
    while (idx >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      idx = buf.indexOf("\n\n");
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      let ev: StreamEvent;
      try {
        ev = JSON.parse(line.slice(6)) as StreamEvent;
      } catch {
        continue;
      }
      switch (ev.type) {
        case "meta":
          acc.mode = ev.mode;
          acc.citations = ev.citations;
          acc.model = ev.model;
          if (ev.mode === "solve") {
            acc.source = ev.source;
            acc.bank = ev.bank;
          }
          flush(true);
          break;
        case "grade":
          acc.grade = ev.grade;
          acc.degraded = ev.degraded;
          flush(true);
          break;
        case "subject":
          acc.subject = ev.route;
          flush(true);
          break;
        case "delta":
          acc.text += ev.text;
          flush();
          break;
        case "beyond":
          acc.beyond = ev.beyond;
          acc.uncertain = ev.uncertain ?? [];
          acc.maxChapterNo = ev.maxChapterNo;
          flush(true);
          break;
        case "note":
          acc.notes = [...acc.notes, ev.text];
          flush(true);
          break;
        case "turn":
          acc.turn = { conversationId: ev.conversationId, messageId: ev.messageId };
          flush(true);
          break;
        case "done":
          acc.ms = ev.ms;
          acc.model = ev.model ?? acc.model;
          flush(true);
          break;
        case "error":
          throw new Error(ev.message);
      }
    }
  }
  flush(true);
  return acc;
}
