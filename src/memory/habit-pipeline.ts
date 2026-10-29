import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type ExtractInput,
  type ExtractResult,
  extractHabits,
  rebuildHabitFromEvents,
} from "./habit-extract.js";

/**
 * 习惯抽取流水线：把「一直在产生的行为」变成「可以注入画像的习惯」。
 *
 * 四条来源都要能自动跑，不能让用户手动贴文本：
 * 1. 每一轮解题 / 批改的原文（来自 conversation.message）
 * 2. 图片转录、代码片段（artifact）
 * 3. 结构化动作：错题、重做、日程、计划、进度、学习上限（server 的 onResponse 钩子）
 * 4. 手动粘贴的材料（/api/habits/extract，保留）
 *
 * 关键约束：
 * - **不能拖慢回答**：抽取是 fire-and-forget 串行排队（避免 429），失败只记日志。
 * - **同一份材料只抽一次**：按 sha256(text) 去重。
 * - **每次尝试都留痕**：成功写 event(habit_extract)，材料太短写 event(habit_skip)，
 *   这样界面上能分清「没材料」和「有材料但不足以下结论」。
 * - 抽出来的是事件（habit_inferred），结论表由 rebuildHabitFromEvents 幂等重算。
 */

const MIN_TEXT = 30;
/** 行为摘要最短间隔：用户连续点几下不该打出几次模型调用 */
const DIGEST_MIN_INTERVAL_MS = 5 * 60_000;

const queue: ExtractInput[] = [];
const seen = new Set<string>();
let running = false;

/** 运行态：只为让人看得见，不参与任何判断 */
const stats = {
  processed: 0,
  failed: 0,
  lastError: null as string | null,
  lastAt: null as string | null,
};
const digestAt = new Map<string, number>();

type Runner = (db: DatabaseSync, input: ExtractInput) => Promise<ExtractResult>;
let runner: Runner = extractHabits;

/** 测试注入：不联网也能验证排队 / 去重 / 重建 */
export function setHabitExtractor(fn: Runner): void {
  runner = fn;
}

export function habitQueueState(): {
  pending: number;
  running: boolean;
  processed: number;
  failed: number;
  lastError: string | null;
  lastAt: string | null;
} {
  return { pending: queue.length, running, ...stats };
}

/**
 * 等队列清空（含正在跑的那一条）。
 *
 * 为什么需要它：`drain()` 是 fire-and-forget，`running=true` 时它立刻返回——
 * 脚本/测试里 `await drain(db)` 等于空操作，随后 close 就会撞上
 * 「database is not open」。凡是要读结果的地方都应该先 await 这个。
 */
export async function awaitHabitIdle(timeoutMs = 120_000): Promise<boolean> {
  const t0 = Date.now();
  while (running || queue.length > 0) {
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((res) => setTimeout(res, 100));
  }
  return true;
}

export interface EnqueueResult {
  queued: boolean;
  reason?: string;
}

function keyOf(input: ExtractInput): string {
  // 只按材料内容去重：同一段材料无论从哪一轮来，抽出来的结论都一样，
  // 重复调模型既费钱、又会让证据条数虚增。
  return createHash("sha256").update(input.text.trim()).digest("hex").slice(0, 24);
}

/** 投递一份材料；立即返回，不阻塞调用方 */
export function enqueueHabitExtraction(db: DatabaseSync, input: ExtractInput): EnqueueResult {
  const text = input.text.trim();
  if (text.length < MIN_TEXT) return { queued: false, reason: "材料太短，暂不下结论" };

  const key = keyOf(input);
  if (seen.has(key)) return { queued: false, reason: "同一份材料已抽过" };
  seen.add(key);

  queue.push({ ...input, text });
  void drain(db);
  return { queued: true };
}

const nowIso = (): string => {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** 每次抽取都追加一条事件（成功/失败都记），界面据此解释"为什么还没有习惯" */
function recordRun(
  db: DatabaseSync,
  item: ExtractInput,
  payload: {
    candidates: number;
    enough: boolean;
    ms: number;
    model: string;
    error: string | null;
  },
): void {
  try {
    db.prepare("INSERT INTO event (type, ref_type, ref_id, payload) VALUES (?,?,?,?)").run(
      "habit_extract",
      item.sourceType,
      item.sourceId ?? null,
      JSON.stringify({ course: item.course, kind: item.kind, ...payload }),
    );
  } catch (e) {
    // 留痕失败绝不能影响抽取本身
    console.error(`[habit] 记录抽取结果失败：${(e as Error).message}`);
  }
}

/** 逐条消费队列；导出是为了测试能 await 到清空 */
export async function drain(db: DatabaseSync): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      try {
        const r = await runner(db, item);
        // 抽取只写事件，结论表要重建才生效（幂等）
        rebuildHabitFromEvents(db);
        stats.processed++;
        stats.lastAt = nowIso();
        recordRun(db, item, {
          candidates: r.habits.length,
          enough: r.enoughEvidence,
          ms: r.ms,
          model: r.model,
          error: null,
        });
        console.log(
          `[habit] 抽取完成：${item.sourceType}#${item.sourceId ?? "-"} → ${r.habits.length} 条候选（证据充分=${r.enoughEvidence}）`,
        );
      } catch (e) {
        const msg = (e as Error).message;
        stats.failed++;
        stats.lastAt = nowIso();
        stats.lastError = msg;
        recordRun(db, item, { candidates: 0, enough: false, ms: 0, model: "", error: msg });
        console.error(`[habit] 抽取失败（不影响作答）：${msg}`);
      }
    }
  } finally {
    running = false;
  }
}

// ───────────────────────── 动作 → 材料（每个用户操作都留痕） ─────────────────────────

export interface ActionInput {
  /** 人对这次操作的描述，写进事件里方便追溯 */
  action: string;
  text: string;
  kind: ExtractInput["kind"];
  course: string | null;
  sourceType: string;
  sourceId?: number | null;
}

export interface ActionResult {
  /** 是否投递给了模型抽取 */
  queued: boolean;
  reason?: string;
  /** 材料太短时是否顺手触发了行为摘要 */
  digestQueued?: boolean;
}

/**
 * 登记一次用户操作。
 *
 * - 材料够长（≥30 字）：投递抽取。
 * - 材料太短（点一下「推进到第 12 章」这种）：**不浪费模型调用**，但写
 *   `habit_skip` 事件留痕，并触发一次行为摘要（有节流），让这次操作依然进模型视野。
 *
 * 这样「每个操作都能记录」是字面成立的：要么进了抽取，要么进了摘要，要么两条都进。
 */
export function recordAction(db: DatabaseSync, rec: ActionInput): ActionResult {
  const text = rec.text.trim();
  if (text.length < MIN_TEXT) {
    try {
      db.prepare("INSERT INTO event (type, ref_type, ref_id, payload) VALUES (?,?,?,?)").run(
        "habit_skip",
        rec.sourceType,
        rec.sourceId ?? null,
        JSON.stringify({
          action: rec.action,
          course: rec.course,
          chars: text.length,
          reason: "材料太短，已计入行为摘要",
        }),
      );
    } catch (e) {
      console.error(`[habit] 记录跳过失败：${(e as Error).message}`);
    }
    return {
      queued: false,
      reason: "材料太短，已计入行为摘要",
      digestQueued: maybeRefreshDigest(db, rec.course),
    };
  }
  return enqueueHabitExtraction(db, {
    text,
    kind: rec.kind,
    course: rec.course,
    sourceType: rec.sourceType,
    sourceId: rec.sourceId ?? null,
  });
}

/** 节流后的行为摘要刷新：同一科目 5 分钟内最多一次 */
export function maybeRefreshDigest(db: DatabaseSync, course: string | null): boolean {
  if (!course) return false;
  const now = Date.now();
  const last = digestAt.get(course) ?? 0;
  if (now - last < DIGEST_MIN_INTERVAL_MS) return false;
  digestAt.set(course, now);
  const r = refreshHabitsFromActivity(db, course);
  return r.queued;
}

/** 最近的抽取尝试（界面用：分清「没材料」还是「有材料但没结论」） */
export function recentHabitRuns(
  db: DatabaseSync,
  limit = 8,
): Array<{
  id: number;
  ts: string;
  sourceType: string;
  sourceId: number | null;
  candidates: number;
  enough: boolean;
  ms: number;
  model: string;
  error: string | null;
}> {
  const rows = db
    .prepare(
      `SELECT id, ts, ref_type, ref_id, payload FROM event
       WHERE type = 'habit_extract' ORDER BY id DESC LIMIT ?`,
    )
    .all(limit) as Array<{
    id: number;
    ts: string;
    ref_type: string | null;
    ref_id: number | null;
    payload: string | null;
  }>;
  return rows.map((r) => {
    let p: Record<string, unknown> = {};
    try {
      p = JSON.parse(r.payload ?? "{}") as Record<string, unknown>;
    } catch {
      /* 坏 payload 不影响列表 */
    }
    return {
      id: r.id,
      ts: r.ts,
      sourceType: r.ref_type ?? "",
      sourceId: r.ref_id ?? null,
      candidates: Number(p.candidates ?? 0),
      enough: Boolean(p.enough),
      ms: Number(p.ms ?? 0),
      model: String(p.model ?? ""),
      error: p.error == null ? null : String(p.error),
    };
  });
}

// ───────────────────────── 行为摘要（日程 / 错题 / 进度） ─────────────────────────

export interface ActivityDigest {
  text: string;
  /** 空摘要：这段时间没有值得抽的行为 */
  empty: boolean;
}

const HOUR_BUCKET = (h: number): string => {
  if (h < 6) return "深夜（0-6 点）";
  if (h < 12) return "上午（6-12 点）";
  if (h < 18) return "下午（12-18 点）";
  return "晚上（18-24 点）";
};

/**
 * 把最近一段时间的行为压成一小段「聚合事实」，喂给习惯抽取。
 * 注意：这里只输出统计，不放原始对话内容——隐私面更小，模型也更容易看出规律。
 */
export function buildActivityDigest(db: DatabaseSync, course: string, days = 30): ActivityDigest {
  const since = `-${days} days`;
  const lines: string[] = [
    `材料：学生最近 ${days} 天的行为统计（聚合事实，非原文）。科目 ${course}。`,
  ];

  const byType = db
    .prepare(
      `SELECT type, COUNT(*) AS c FROM event
       WHERE ts >= datetime('now', ?) GROUP BY type ORDER BY c DESC`,
    )
    .all(since) as Array<{ type: string; c: number }>;
  const act = byType.filter((r) => ["solve", "review", "ask"].includes(r.type));
  if (act.length > 0) {
    lines.push(
      `做题活动：${act.map((r) => `${r.type === "review" ? "批改" : r.type === "solve" ? "解题" : "提问"} ${r.c} 次`).join("、")}。`,
    );
  }

  const hours = db
    .prepare(
      `SELECT CAST(strftime('%H', ts) AS INTEGER) AS h, COUNT(*) AS c FROM event
       WHERE type IN ('solve','review','ask') AND ts >= datetime('now', ?)
       GROUP BY h`,
    )
    .all(since) as Array<{ h: number; c: number }>;
  if (hours.length > 0) {
    const bucket = new Map<string, number>();
    for (const r of hours) {
      const b = HOUR_BUCKET(r.h);
      bucket.set(b, (bucket.get(b) ?? 0) + r.c);
    }
    const top = [...bucket.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
    lines.push(`活跃时段：${top.map(([b, c]) => `${b} ${c} 次`).join("，")}。`);
  }

  const mistakes = db
    .prepare(
      `SELECT COALESCE(error_type,'unknown') AS t, COUNT(*) AS c FROM mistake
       WHERE course_code = ? GROUP BY t ORDER BY c DESC`,
    )
    .all(course) as Array<{ t: string; c: number }>;
  if (mistakes.length > 0) {
    const total = mistakes.reduce((n, r) => n + r.c, 0);
    lines.push(`错题 ${total} 道，错因分布：${mistakes.map((r) => `${r.t} ${r.c}`).join("、")}。`);
  }

  const attempts = db
    .prepare(
      `SELECT COUNT(*) AS c, SUM(CASE WHEN resolved=1 THEN 1 ELSE 0 END) AS done FROM mistake
       WHERE course_code = ?`,
    )
    .get(course) as { c: number; done: number | null };
  if (Number(attempts.done ?? 0) > 0) {
    lines.push(`错题已订正 ${attempts.done} / ${attempts.c} 道。`);
  }

  const sched = db
    .prepare(
      `SELECT category, COUNT(*) AS c FROM schedule WHERE course_code = ? OR course_code IS NULL
       GROUP BY category`,
    )
    .all(course) as Array<{ category: string | null; c: number }>;
  if (sched.length > 0) {
    const label: Record<string, string> = {
      academic: "正课",
      plan: "学习计划块",
      rest: "休息",
      life: "生活",
      work: "工作",
    };
    lines.push(
      `日程构成：${sched.map((r) => `${label[r.category ?? ""] ?? r.category ?? "其它"} ${r.c} 条`).join("、")}。`,
    );
  }

  const prog = db
    .prepare("SELECT MAX(chapter_no) AS m FROM chapter_progress WHERE course_code = ?")
    .get(course) as { m: number | null };
  if (prog.m != null) lines.push(`教材进度：已学到第 ${prog.m} 章。`);

  // 学习上限也是习惯材料：「每天最多学多久」本身就是计划习惯
  const limits = db
    .prepare("SELECT metric, min_value, max_value FROM capacity_rule")
    .all() as Array<{
    metric: string;
    min_value: number | null;
    max_value: number | null;
  }>;
  if (limits.length > 0) {
    lines.push(
      `自我约束：${limits
        .map((l) => `${l.metric}${l.max_value != null ? `≤${l.max_value}` : `≥${l.min_value}`}`)
        .join("、")}。`,
    );
  }

  const empty = lines.length <= 1;
  return { text: lines.join("\n"), empty };
}

/**
 * 用行为摘要刷新习惯。返回是否投递成功（投递即返回，不等模型）。
 */
export function refreshHabitsFromActivity(
  db: DatabaseSync,
  course: string,
  days = 30,
): EnqueueResult {
  const digest = buildActivityDigest(db, course, days);
  if (digest.empty) return { queued: false, reason: "最近没有可抽取的行为" };
  // sourceType 带日期：证据按 (sourceType, sourceId) 去重，隔天再跑会累加证据条数，
  // 否则同一条习惯永远只有 1 条证据、到不了注入阈值。
  const today = new Date().toISOString().slice(0, 10);
  return enqueueHabitExtraction(db, {
    text: digest.text,
    kind: "chat",
    course,
    sourceType: `activity:${today}`,
    sourceId: null,
  });
}
