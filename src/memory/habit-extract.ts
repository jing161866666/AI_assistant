import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { llm } from "../llm/client.js";
import { getLlmConfig } from "../llm/models.js";

/**
 * 习惯抽取与重算。
 *
 * 两条硬约束（AGENTS.md 〇、M2.md 1.3/1.4）：
 *  1. 判断交给模型，落库交给代码；模型只产出 JSON，不碰表。
 *  2. 无证据不写结论：每条习惯挂 habit_evidence，证据不足只存不注入。
 *
 * 写库入口唯一：模型产出 → 追加 event(habit_inferred) → rebuildHabitFromEvents 重算结论表。
 * 重算必须幂等（同事件流两次重算结果一致），这样"改一条证据"才不会留下脏数据。
 */

/** 维度白名单：新增维度要改代码，不允许模型自由命名 */
export const HABIT_DIMENSIONS = [
  "learn_method",
  "code_naming",
  "notation",
  "study_time",
  "error_pattern",
  "planning",
  "help_seeking",
  "attention",
  /** 偏好时段 + 那个时段学什么（日程偏好：key=时段，value=做什么/怎么做） */
  "study_window",
  /** 某门课的课下投入占比（key=科目，value=0-1 或高/中/低；也用于"避开水课"） */
  "investment",
  /** 正在看的网课 / 在用的教辅（key=名称，value=类型+是否本地可用） */
  "resource",
] as const;

export type HabitDimension = (typeof HABIT_DIMENSIONS)[number];

/** learn_method 的取值也是白名单 */
export const LEARN_METHODS = [
  "中文速成网课",
  "中文详细网课",
  "CS英文网课",
  "自学",
  "看参考书",
  "做题",
] as const;

export const habitItemSchema = z.object({
  dimension: z.enum(HABIT_DIMENSIONS).catch("attention"),
  key: z.string().min(1).catch(""),
  value: z.string().min(1).catch(""),
  snippet: z.string().catch(""),
});

export const habitExtractSchema = z.object({
  habits: z.array(habitItemSchema).catch([]),
  /** 模型自评：这段材料信息量够不够下结论 */
  enough_evidence: z.boolean().catch(false),
});

export type HabitItem = z.infer<typeof habitItemSchema>;

const EXTRACT_SYSTEM = `你在观察一个学生的学习痕迹，抽取**稳定可复用的习惯**。只输出 JSON。

维度白名单（只能用这八个）：
- learn_method  在哪个学习阶段习惯用哪种学习方式。key 形如 "阶段:第11章" 或 "阶段:基础/强化/冲刺"；
                value 只能取：中文速成网课 / 中文详细网课 / CS英文网课 / 自学 / 看参考书 / 做题
- code_naming   代码命名偏好。key 形如 "含义:累加器" / "含义:下标"；value 写他实际用的标识符，如 sum / idx
- notation      做题符号偏好。key 形如 "场景:导数" / "场景:向量"；value 写实际符号，如 y' / dy/dx
- study_time    观测到的时段行为。key 形如 "时段:21-24"；value 写这时间在干什么，如 做题 / 看网课 / 改错
- error_pattern 反复出现的错误。key 形如 "错误:单位遗漏"；value 用 careless / concept / formula / unit / logic 之一
- planning      计划与执行习惯（自由但稳定）
- help_seeking  求助方式偏好（自由但稳定）
- attention     注意力和单次专注时长（自由但稳定）

抽取规则：
1. 只抽**能复用**的偏好，不要抽一次性事实（"这题算错了"不是习惯，"总把 nm 当 m 代入"是习惯）。
2. 每条必须给出 snippet：材料里支撑这条判断的**原始短句，≤80 字，去掉姓名学号**。
3. 拿不准就不抽。宁可 0 条，不要凑数。
4. 同一维度同一含义只输出一次。
5. 如果材料太短、看不出稳定偏好，habits 给空数组且 enough_evidence 为 false。

输出格式：
{"habits":[{"dimension":"code_naming","key":"含义:累加器","value":"sum","snippet":"for(int sum=0;...)"}],"enough_evidence":true}`;

export interface ExtractInput {
  /** 材料文本（图片转录、代码片段、对话摘录） */
  text: string;
  kind: "code" | "image" | "chat" | "answer";
  course: string | null;
  sourceType: string;
  sourceId: number | null;
}

export interface ExtractResult {
  habits: HabitItem[];
  enoughEvidence: boolean;
  model: string;
  ms: number;
  written: number;
}

/** 模型抽取 → 追加事件 → 重算结论表 */
export async function extractHabits(db: DatabaseSync, input: ExtractInput): Promise<ExtractResult> {
  const t0 = Date.now();
  const cfg = getLlmConfig("extract");
  const text = input.text.trim().slice(0, 6000);
  if (text.length < 30) {
    return { habits: [], enoughEvidence: false, model: cfg.model, ms: 0, written: 0 };
  }

  const r = await llm("extract").chat.completions.create({
    model: cfg.model,
    messages: [
      { role: "system", content: EXTRACT_SYSTEM },
      { role: "user", content: `材料类型：${input.kind}\n\n材料：\n${text}` },
    ],
    max_tokens: 900,
    temperature: 0,
    response_format: { type: "json_object" },
  });

  const raw = r.choices[0]?.message?.content ?? "{}";
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  const json = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;

  let parsed: z.infer<typeof habitExtractSchema>;
  try {
    parsed = habitExtractSchema.parse(JSON.parse(json));
  } catch (e) {
    console.error("[habit] 结构解析失败:", (e as Error).message, raw.slice(0, 200));
    parsed = { habits: [], enough_evidence: false };
  }

  // 清洗：去掉空 key/value，learn_method 强制白名单
  const cleaned = parsed.habits
    .filter((h) => h.key.trim() && h.value.trim())
    .map((h) => {
      if (h.dimension === "learn_method") {
        const hit = LEARN_METHODS.find((m) => h.value.includes(m));
        return hit ? { ...h, value: hit } : null;
      }
      return h;
    })
    .filter((h): h is HabitItem => h !== null);

  const written = appendEvents(db, cleaned, input);
  rebuildHabitFromEvents(db);

  return {
    habits: cleaned,
    enoughEvidence: parsed.enough_evidence,
    model: cfg.model,
    ms: Date.now() - t0,
    written,
  };
}

interface InferredPayload {
  dimension: HabitDimension;
  key: string;
  value: string;
  course: string | null;
  context: string | null;
  snippet: string | null;
  sourceType: string;
  sourceId: number | null;
}

function appendEvents(db: DatabaseSync, items: HabitItem[], input: ExtractInput): number {
  const stmt = db.prepare("INSERT INTO event (type, ref_type, ref_id, payload) VALUES (?,?,?,?)");
  let n = 0;
  for (const h of items) {
    const payload: InferredPayload = {
      dimension: h.dimension,
      key: h.key,
      value: h.value,
      course: input.course,
      context: null,
      snippet: h.snippet.slice(0, 80),
      sourceType: input.sourceType,
      sourceId: input.sourceId,
    };
    stmt.run("habit_inferred", input.sourceType, input.sourceId, JSON.stringify(payload));
    n++;
  }
  return n;
}

// ───────────────────────── 重算（幂等） ─────────────────────────

export interface RebuildReport {
  habits: number;
  evidence: number;
}

const CONFIDENCE_MIN = 0.45;
const CONFIDENCE_STEP = 0.15;
const CONFIDENCE_MAX = 0.95;

/**
 * 从 event 重放重建 habit + habit_evidence。
 *
 * 幂等：清空后重放，同一事件流两次调用结果完全一致。
 * 证据计数按 (sourceType, sourceId) 去重——同一份 artifact 的多个切片只算 1 条。
 */
export function rebuildHabitFromEvents(db: DatabaseSync): RebuildReport {
  const events = db
    .prepare(
      `SELECT id, type, payload FROM event
       WHERE type IN ('habit_inferred','habit_rejected','habit_confirmed')
       ORDER BY id`,
    )
    .all() as unknown as Array<{ id: number; type: string; payload: string | null }>;

  interface Agg {
    payload: InferredPayload;
    evidence: Array<{ sourceType: string; sourceId: number | null; snippet: string | null }>;
    rejected: boolean;
    confirmed: boolean;
  }
  const groups = new Map<string, Agg>();

  for (const ev of events) {
    let p: InferredPayload;
    try {
      p = JSON.parse(ev.payload ?? "{}") as InferredPayload;
    } catch {
      continue;
    }
    if (!p.dimension || !p.key) continue;

    const k = `${p.dimension}|${p.key}|${p.course ?? ""}|${p.context ?? ""}`;
    const g = groups.get(k) ?? { payload: p, evidence: [], rejected: false, confirmed: false };

    if (ev.type === "habit_inferred") {
      // 同 (sourceType, sourceId) 只记一次证据
      const dup = g.evidence.some(
        (e) => e.sourceType === p.sourceType && e.sourceId === (p.sourceId ?? null),
      );
      if (!dup) {
        g.evidence.push({
          sourceType: p.sourceType,
          sourceId: p.sourceId ?? null,
          snippet: p.snippet ?? null,
        });
      }
      g.payload = { ...g.payload, value: p.value }; // 最新一次的说法覆盖旧值
    } else if (ev.type === "habit_rejected") {
      g.rejected = true;
    } else if (ev.type === "habit_confirmed") {
      g.confirmed = true;
    }
    groups.set(k, g);
  }

  // 只清「模型推断出来的」那部分。
  // 用户自述（source='manual'）和他的证据必须留：重算是拿事件流重算模型结论，
  // 不该把用户明确说过的话删掉——那样他每填一次、后台跑一次就没了。
  db.exec("DELETE FROM habit_evidence WHERE source_type <> 'user'");
  db.exec("DELETE FROM habit WHERE source <> 'manual'");

  const insHabit = db.prepare(
    `INSERT INTO habit
       (dimension, key, value, course_code, context, confidence, evidence_count, status, source)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  const insEv = db.prepare(
    "INSERT INTO habit_evidence (habit_id, source_type, source_id, snippet, weight) VALUES (?,?,?,?,?)",
  );
  // 用户自述优先：同一 (维度,key,科目,场景) 已经有自述时，模型结论不再插一条
  const hasManual = db.prepare(
    `SELECT 1 AS x FROM habit
     WHERE source='manual' AND dimension = ? AND key = ?
       AND COALESCE(course_code,'') = COALESCE(?,'')
       AND COALESCE(context,'') = COALESCE(?,'')`,
  );

  let habitCount = 0;
  let evCount = 0;
  let skipped = 0;
  for (const g of groups.values()) {
    const n = g.evidence.length;
    const confidence = Math.min(CONFIDENCE_MAX, CONFIDENCE_MIN + CONFIDENCE_STEP * n);
    const status = g.rejected ? "rejected" : "active";
    if (
      hasManual.get(
        g.payload.dimension,
        g.payload.key,
        g.payload.course ?? null,
        g.payload.context ?? null,
      )
    ) {
      skipped++;
      continue;
    }
    const r = insHabit.run(
      g.payload.dimension,
      g.payload.key,
      g.payload.value,
      g.payload.course ?? null,
      g.payload.context ?? null,
      Number(confidence.toFixed(2)),
      n,
      status,
      "model",
    );
    const habitId = Number(r.lastInsertRowid);
    habitCount++;
    for (const e of g.evidence) {
      insEv.run(habitId, e.sourceType, e.sourceId, e.snippet, 1);
      evCount++;
    }
  }
  if (skipped > 0) {
    console.log(`[habit] 重建时跳过 ${skipped} 组模型结论（同一键已有用户自述，以用户为准）`);
  }
  return { habits: habitCount, evidence: evCount };
}

/** 用户否决一条习惯（永不注入，但保留证据） */
export function rejectHabit(db: DatabaseSync, habitId: number): void {
  const row = db
    .prepare("SELECT dimension, key, course_code, context FROM habit WHERE id = ?")
    .get(habitId) as
    | { dimension: string; key: string; course_code: string | null; context: string | null }
    | undefined;
  if (!row) throw new Error(`习惯 ${habitId} 不存在`);
  db.prepare("INSERT INTO event (type, ref_type, ref_id, payload) VALUES (?,?,?,?)").run(
    "habit_rejected",
    "habit",
    habitId,
    JSON.stringify({
      dimension: row.dimension,
      key: row.key,
      value: "",
      course: row.course_code,
      context: row.context,
    }),
  );
  rebuildHabitFromEvents(db);
}

// ───────────────────────── 注入阈值 ─────────────────────────

export const INJECT_MIN_EVIDENCE = 2;
export const INJECT_MIN_CONFIDENCE = 0.6;

/** 满足注入条件的习惯（M2.md 1.3） */
export function injectableHabits(db: DatabaseSync, course: string) {
  return db
    .prepare(
      `SELECT * FROM habit
       WHERE status = 'active'
         -- 用户自己填的（source='manual'）不受证据阈值限制：
         -- 他明确说了「我 8-9 点写代码」，这一条比模型观察十次都可信
         AND (source = 'manual' OR (evidence_count >= ? AND confidence >= ?))
         AND (course_code IS NULL OR course_code = ?)
       ORDER BY source = 'manual' DESC, dimension, confidence DESC`,
    )
    .all(INJECT_MIN_EVIDENCE, INJECT_MIN_CONFIDENCE, course) as unknown as Array<{
    id: number;
    dimension: string;
    key: string;
    value: string;
    course_code: string | null;
    confidence: number;
    evidence_count: number;
  }>;
}
