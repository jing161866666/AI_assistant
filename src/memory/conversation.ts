import type { DatabaseSync } from "node:sqlite";

/**
 * 对话落库：解题 / 批改的输入输出必须进 conversation + message，
 * 否则「通过对话分析学习习惯」永远没有原料（habit 只能从 event 看"做了什么"，
 * 看不到"怎么说、怎么想"）。
 *
 * 约定：
 * - 一个科目一天一条 conversation，天然把上下文切成"当天会话"，避免无限长。
 * - message 存原文（给模型回放、给用户回看）；meta 存结构化字段（给程序用）。
 * - 结构化字段放 event.payload，message 只放人能读的文本——
 *   这样 message 可以直接拼进下一次的上下文，不需要再解析。
 */

export type TurnKind = "solve" | "grade" | "ask";

/** 批改判定快照：刷新恢复时要能重新画出徽标，不能只剩正文 */
export interface GradeSnapshot {
  verdict: string;
  input_kind: string;
  error_type: string;
  cause: string;
  hints: string[];
  related_kps: string[];
  /** 模型给出的科目代码（未校验）；恢复历史时只作展示，不作判据 */
  subject_guess?: string;
}

/** 题库命中快照，用于恢复「题库命中 #0148」这类标签 */
export interface BankSnapshot {
  qno: string | null;
  kind: string;
  score: number;
  chapter: string;
  has_answer: boolean;
}

export interface TurnMeta {
  course: string;
  kind: TurnKind;
  question: string;
  studentInput?: string;
  detail?: "full" | "brief";
  source?: string;
  qno?: string | null;
  model?: string;
  ms?: number;
  citations?: number;
  grade?: GradeSnapshot;
  bank?: BankSnapshot | null;
}

export interface TurnInput extends TurnMeta {
  answer: string;
}

export interface TurnIds {
  conversationId: number;
  userMessageId: number;
  assistantMessageId: number;
}

export interface StoredTurn {
  conversationId: number;
  assistantMessageId: number;
  answer: string;
  meta: TurnMeta;
  createdAt: string;
}

/** 当天的会话；没有就建一条。一个科目一天一条，重启也跟着日期走 */
export function ensureConversation(db: DatabaseSync, course: string): number {
  const row = db
    .prepare(
      `SELECT id FROM conversation
       WHERE course_code = ? AND date(created_at) = date('now')
       ORDER BY id DESC LIMIT 1`,
    )
    .get(course) as { id: number } | undefined;
  if (row) return row.id;

  const title = `${new Date().toISOString().slice(0, 10)} · ${course}`;
  const r = db
    .prepare("INSERT INTO conversation (title, course_code) VALUES (?,?)")
    .run(title, course);
  return Number(r.lastInsertRowid);
}

/** 人可读的 user 消息：下一次拼上下文时直接可用 */
function userText(input: TurnInput): string {
  const parts = [`【题目】\n${input.question.trim()}`];
  if (input.studentInput?.trim()) parts.push(`【我的作答 / 过程】\n${input.studentInput.trim()}`);
  return parts.join("\n\n");
}

/** 存一轮（user + assistant + event），返回 id 供前端刷新后恢复 */
export function saveTurn(db: DatabaseSync, input: TurnInput): TurnIds {
  const conversationId = ensureConversation(db, input.course);
  const insMsg = db.prepare(
    "INSERT INTO message (conversation_id, role, content, model) VALUES (?,?,?,?)",
  );

  const userMessageId = Number(
    insMsg.run(conversationId, "user", userText(input), null).lastInsertRowid,
  );
  const assistantMessageId = Number(
    insMsg.run(conversationId, "assistant", input.answer, input.model ?? null).lastInsertRowid,
  );

  db.prepare("UPDATE conversation SET updated_at = datetime('now') WHERE id = ?").run(
    conversationId,
  );

  const payload: TurnMeta & { answer_chars: number } = {
    course: input.course,
    kind: input.kind,
    question: input.question,
    studentInput: input.studentInput,
    detail: input.detail,
    source: input.source,
    qno: input.qno ?? null,
    model: input.model,
    ms: input.ms,
    citations: input.citations,
    grade: input.grade,
    bank: input.bank ?? null,
    answer_chars: input.answer.length,
  };
  db.prepare("INSERT INTO event (type, ref_type, ref_id, payload) VALUES (?,?,?,?)").run(
    input.kind === "grade" ? "review" : input.kind,
    "message",
    assistantMessageId,
    JSON.stringify(payload),
  );

  return { conversationId, userMessageId, assistantMessageId };
}

function metaFromEvent(db: DatabaseSync, messageId: number): TurnMeta | null {
  const row = db
    .prepare(
      "SELECT payload FROM event WHERE ref_type='message' AND ref_id=? ORDER BY id DESC LIMIT 1",
    )
    .get(messageId) as { payload: string | null } | undefined;
  if (!row?.payload) return null;
  try {
    return JSON.parse(row.payload) as TurnMeta;
  } catch {
    return null;
  }
}

/** 取某一轮（用于刷新页面后恢复上一次结果） */
export function getTurn(db: DatabaseSync, assistantMessageId: number): StoredTurn | null {
  const msg = db
    .prepare("SELECT id, conversation_id, content, created_at FROM message WHERE id = ?")
    .get(assistantMessageId) as
    | { id: number; conversation_id: number; content: string; created_at: string }
    | undefined;
  if (!msg) return null;
  const meta = metaFromEvent(db, assistantMessageId);
  if (!meta) return null;
  return {
    conversationId: msg.conversation_id,
    assistantMessageId: msg.id,
    answer: msg.content,
    meta,
    createdAt: msg.created_at,
  };
}

/** 最近几轮（倒序），给前端「最近记录」和刷新恢复用 */
export function listTurns(db: DatabaseSync, course: string, limit = 20): StoredTurn[] {
  const rows = db
    .prepare(
      `SELECT m.id AS id, m.conversation_id AS conversation_id, m.content AS content,
              m.created_at AS created_at, e.payload AS payload
       FROM message m
       JOIN conversation c ON c.id = m.conversation_id
       LEFT JOIN event e ON e.ref_type='message' AND e.ref_id = m.id
       WHERE m.role='assistant' AND c.course_code = ?
       ORDER BY m.id DESC
       LIMIT ?`,
    )
    .all(course, limit) as Array<{
    id: number;
    conversation_id: number;
    content: string;
    created_at: string;
    payload: string | null;
  }>;

  const out: StoredTurn[] = [];
  for (const r of rows) {
    if (!r.payload) continue;
    try {
      out.push({
        conversationId: r.conversation_id,
        assistantMessageId: r.id,
        answer: r.content,
        meta: JSON.parse(r.payload) as TurnMeta,
        createdAt: r.created_at,
      });
    } catch {}
  }
  return out;
}
