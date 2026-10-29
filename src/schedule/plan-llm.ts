import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { llm } from "../llm/client.js";
import { getLlmConfig } from "../llm/models.js";
import {
  addDays,
  busyIntervalsOf,
  expandOccurrences,
  freeSlotsOn,
  listCapacity,
  listQuietWindows,
  quietWindowsFor,
  toMin,
  toTime,
} from "./service.js";

/**
 * 让模型出排期方案，代码只做校验。
 *
 * 分工（AGENTS §一"模型给方案 + 代码做校验"）：
 * - 模型：决定「哪天几点、学哪门、干什么」——这属于判断，规则写不出来
 * - 代码：绝不撞课、不超单次上限、不超每日/每周上限、块之间不重叠
 *
 * 模型给的块只要有一条硬约束不满足，就**丢回**并在 dropped 里说明原因，
 * 不静默修正——用户看到的必须是"哪条没通过、为什么"。
 */

export const PLAN_BLOCK_KINDS = ["review", "practice", "netcourse", "study"] as const;

/** 材料的来源：已有资源 / 让 AI 生成 / 推荐参考书 / 暂无 */
export const SOURCE_KINDS = ["existing", "ai_generated", "reference_book", "none"] as const;

export const proposedBlockSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .catch(""),
  start: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .catch(""),
  end: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .catch(""),
  course_code: z.string().nullable().catch(null),
  kind: z.enum(PLAN_BLOCK_KINDS).catch("study"),
  task: z.string().catch(""),
  /**
   * 材料从哪来：existing = 画像里已有的网课/教辅；ai_generated = 让 AI 出题；
   * reference_book = 建议某本参考书；none = 没想好
   */
  source_kind: z.enum(SOURCE_KINDS).catch("none"),
  /** 具体材料名：网课名+第几讲 / 教辅名+章节 / 建议的书名 */
  source_ref: z.string().catch(""),
  reason: z.string().catch(""),
});

export const planProposalSchema = z.object({
  plan: z.array(proposedBlockSchema).catch([]),
});

export type ProposedBlock = z.infer<typeof proposedBlockSchema>;

export interface PlanGuardOptions {
  from: string;
  to: string;
  perDayMinutes: number;
  minChunk: number;
  maxChunk: number;
  /** 每周学习时长上限（分钟）；null = 不限 */
  weekCap: number | null;
  /** 允许多少分钟误差（模型常把 25 分钟写成 30） */
  tolerance?: number;
}

export interface AcceptedBlock {
  date: string;
  start: string;
  end: string;
  minutes: number;
  course_code: string | null;
  kind: (typeof PLAN_BLOCK_KINDS)[number];
  task: string;
  /** 材料来源：已有 / AI 生成 / 建议参考书 / 未定 */
  source_kind: (typeof SOURCE_KINDS)[number];
  /** 具体材料名与位置 */
  source_ref: string;
  reason: string;
}

export interface RejectedBlock {
  block: ProposedBlock;
  why: string;
}

export interface GuardResult {
  accepted: AcceptedBlock[];
  rejected: RejectedBlock[];
}

/**
 * 模型经常不填 source_kind（返回 none）。这里按内容补：
 * 提到已有资源名 → existing；提到题库/教辅/书 → reference_book；
 * 提到出题/生成 → ai_generated；什么都没有 → none。
 * 只是补齐标签，不改任务内容。
 */
export function inferSourceKind(
  db: DatabaseSync,
  task: string,
  sourceRef: string,
  given: ProposedBlock["source_kind"],
): ProposedBlock["source_kind"] {
  if (given !== "none") return given;
  const text = `${task} ${sourceRef}`;
  const titles = db.prepare("SELECT title FROM course_resource").all() as unknown as Array<{
    title: string;
  }>;
  if (titles.some((t) => t.title && text.includes(t.title))) return "existing";
  if (/题库|教辅|参考书|教材|第\s*\d+\s*章|习题/.test(text)) return "reference_book";
  if (/生成|出题|自拟|我来出/.test(text)) return "ai_generated";
  return "none";
}

/**
 * 硬约束校验：这是"必须等于/不能重叠"那类判断，只能写代码（AGENTS §三）。
 */
export function validateProposal(
  db: DatabaseSync,
  proposal: ProposedBlock[],
  opts: PlanGuardOptions,
): GuardResult {
  const tol = opts.tolerance ?? 5;
  const occs = expandOccurrences(db, opts.from, opts.to);
  const perDay = new Map<string, number>();
  const usedPerDay = new Map<string, Array<[number, number]>>();
  const weekUsed = new Map<string, number>();
  const accepted: AcceptedBlock[] = [];
  const rejected: RejectedBlock[] = [];

  // 按时间顺序处理，先到先得（后到的重叠块被拒）
  const sorted = [...proposal].sort((a, b) =>
    a.date === b.date ? a.start.localeCompare(b.start) : a.date.localeCompare(b.date),
  );

  for (const b of sorted) {
    if (!b.date || !b.start || !b.end) {
      rejected.push({ block: b, why: "日期或时间格式不对（要 YYYY-MM-DD / HH:MM）" });
      continue;
    }
    if (!/^\d{2}:\d{2}$/.test(b.start) || !/^\d{2}:\d{2}$/.test(b.end)) {
      rejected.push({ block: b, why: `时间格式不对（要 HH:MM，收到 ${b.start}-${b.end}）` });
      continue;
    }
    if (b.date < opts.from || b.date > opts.to) {
      rejected.push({ block: b, why: `不在排期区间 ${opts.from}~${opts.to} 内` });
      continue;
    }
    const s = toMin(b.start);
    const e = toMin(b.end);
    const minutes = e - s;
    if (minutes < opts.minChunk) {
      rejected.push({ block: b, why: `只有 ${minutes} 分钟，短于最小块 ${opts.minChunk} 分钟` });
      continue;
    }
    if (minutes > opts.maxChunk + tol) {
      rejected.push({ block: b, why: `${minutes} 分钟超过单次上限 ${opts.maxChunk} 分钟` });
      continue;
    }

    // 撞课/撞已锁定的安排
    const busy = busyIntervalsOf(occs, b.date);
    if (busy.some(([bs, be]) => s < be && e > bs)) {
      rejected.push({ block: b, why: "与已有安排（课程/睡眠/已保存的计划）重叠" });
      continue;
    }

    // 「不想学」的时段：硬排除。提示词里已经说过，但模型仍可能排进来，
    // 所以必须有代码兜底——否则用户设的"午休/晚上不想学"只是建议。
    const quietHit = quietWindowsFor(db, b.date).find((q) => s < q.endMin && e > q.startMin);
    if (quietHit) {
      rejected.push({
        block: b,
        why: `落在你说了不想学的时段（${quietHit.label}），该时段不排学习`,
      });
      continue;
    }

    // 必须是真正的空闲时段内
    const free = freeSlotsOn(db, occs, b.date, { minMinutes: opts.minChunk });
    const insideFree = free.some((f) => s >= toMin(f.start) && e <= toMin(f.end));
    if (!insideFree) {
      rejected.push({ block: b, why: "落在不可用时段（不在有效学习时间内或总时长为空）" });
      continue;
    }

    // 同一天内块之间不重叠
    const dayUsed = usedPerDay.get(b.date) ?? [];
    if (dayUsed.some(([bs, be]) => s < be && e > bs)) {
      rejected.push({ block: b, why: "与同一天已接受的其他块重叠" });
      continue;
    }

    // 每日总量
    const dayTotal = perDay.get(b.date) ?? 0;
    if (dayTotal + minutes > opts.perDayMinutes + tol) {
      rejected.push({
        block: b,
        why: `当天已排 ${dayTotal} 分钟，再加 ${minutes} 超过每日上限 ${opts.perDayMinutes}`,
      });
      continue;
    }

    // 每周总量
    if (opts.weekCap != null) {
      const wk = b.date.slice(0, 8); // 周内的粗略分组：按自然周近似即可，精确周次已由区间保证
      const used = weekUsed.get(wk) ?? 0;
      if (used + minutes > opts.weekCap) {
        rejected.push({ block: b, why: `本周已排 ${used} 分钟，超过每周上限 ${opts.weekCap}` });
        continue;
      }
      weekUsed.set(wk, used + minutes);
    }

    dayUsed.push([s, e]);
    usedPerDay.set(b.date, dayUsed);
    perDay.set(b.date, dayTotal + minutes);
    accepted.push({
      date: b.date,
      start: toTime(s),
      end: toTime(e),
      minutes,
      course_code: b.course_code,
      kind: b.kind,
      task: b.task,
      source_kind: inferSourceKind(db, b.task, b.source_ref, b.source_kind),
      source_ref: b.source_ref,
      reason: b.reason,
    });
  }

  return { accepted, rejected };
}

const SYSTEM = `你在给一个大学生排本周的学习日程。只输出 JSON。

硬约束（违反任何一条都算失败）：
1. 只能排在给你的【空闲时段】里，绝不能和课程/睡眠重叠。
2. 单块时长在 minChunk~maxChunk 之间，每天总时长不超过 perDayMinutes。
3. 同一天的块之间不能重叠。
4. 优先排在【偏好时段】里（用户自己说的"这个点我想学什么"最可信）。
5. 每天有课的日子，优先排"温习课上内容"（kind=review，course_code 用那门课）；
   没课的日子排作业/网课（kind=practice / netcourse）。
6. 按【投入占比】分配时长：占比高的课多排，占比 0 的课（水课）一块都不排。
7. 有网课资源（netcourse）的科目，没课日优先排 kind=netcourse。
8. **尽量排满**：每天在不超过 perDayMinutes 的前提下多排（空档够就排 2 块，
   别一天只给一块）；一周内每门"有课或有投入占比"的科目至少覆盖一次。
9. 每块必须写清三件事：
   - task：学什么（章节号/题型/题号范围，如"第 10 章 3.1-3.5 题"）；
   - source_kind：材料从哪来 —— existing（画像里已有的网课/教辅）/ ai_generated（让 AI 出题）/
     reference_book（建议某本参考书）/ none；
   - source_ref：具体名字与位置（如"CS50 第 3 讲""清华大学物理题库 第 10 章"）。
   画像里有现成材料就用 existing；没有就自己给建议（ai_generated 或 reference_book），
   并在 reason 里说明"这份是我建议的，你还没上传"。
10. **不要一天排两块一样的"温习课上内容"**：复习最多占当天一半时间，
    剩下的给做题、看网课、写代码。复习只针对当天有课的科目。
11. **【不能学习的时段】一块都不许排**：用户明确说了那段时间不想学（午休、晚饭、通勤、洗漱）。
    这些时段已经从【空闲时段】里扣掉了；你如果仍把块放进去，代码会拒收并回你原因。
    与其挤进这些时段，不如当天少排一块，并在 reason 里写"剩下的时间属于休息"。

输出格式：
{"plan":[{"date":"2026-10-28","start":"19:00","end":"20:00","course_code":"DS","kind":"review","task":"温习第 4 章：二叉树的遍历","reason":"当天有数据结构课，且 19-20 点是你偏好的时段"}]}
task 要具体到学什么（章节/题型），不要写"学习"两个字。`;

export interface BuildContextInput {
  from: string;
  to: string;
  perDayMinutes: number;
  profileText: string;
  minChunk: number;
  maxChunk: number;
}

/** 把「空闲时段 + 偏好 + 进度」整理成给模型看的事实 */
export function buildPlanContext(
  db: DatabaseSync,
  input: BuildContextInput,
): { text: string; days: string[] } {
  const occs = expandOccurrences(db, input.from, input.to);
  const lines: string[] = [
    `排期区间：${input.from} ~ ${input.to}；每天最多 ${input.perDayMinutes} 分钟；` +
      `单块 ${input.minChunk}~${input.maxChunk} 分钟。`,
    "",
    "【学生画像（习惯/进度/资源）】",
    input.profileText.slice(0, 2600),
  ];

  const days: string[] = [];
  // 显式给"可用材料清单"和"缺什么"：模型要据此决定 source_kind，不能凭空说"用第 3 讲"
  const res = db
    .prepare(
      `SELECT course_code, kind, title, local_status, progress FROM course_resource
       ORDER BY course_code IS NULL, course_code, kind`,
    )
    .all() as unknown as Array<{
    course_code: string | null;
    kind: string;
    title: string;
    local_status: string;
    progress: number | null;
  }>;
  if (res.length > 0) {
    const label: Record<string, string> = {
      netcourse: "网课",
      guidebook: "教辅",
      textbook: "教材",
      other: "其它",
    };
    lines.push("", "【可用学习材料（source_kind=existing 只能用这里的）】");
    for (const r of res) {
      const state =
        r.local_status === "missing"
          ? "⚠缺文件（不能当已有材料用）"
          : r.local_status === "uploaded"
            ? "已上传"
            : r.local_status === "available"
              ? "可用"
              : "状态未知";
      lines.push(
        `- [${label[r.kind] ?? r.kind}] ${r.title}${r.course_code ? `（${r.course_code}）` : "（通识）"}` +
          ` · ${state}${r.progress != null ? ` · 进度 ${Math.round(r.progress * 100)}%` : ""}`,
      );
    }
  } else {
    lines.push(
      "",
      "【可用学习材料】暂无（没有网课/教辅登记）→ 只能用 source_kind=ai_generated 或 reference_book",
    );
  }

  // 「不想学」的时段要**明说**，不能只靠"空档里没有这段"让模型自己猜。
  // 只隐去空档时，模型会以为是课、也可能把相邻空档硬凑成跨过午休的长块。
  const quiet = listQuietWindows(db);
  if (quiet.length > 0) {
    lines.push("", "【不能学习的时段（用户明确说了，绝对不许排）】");
    const WD = ["一", "二", "三", "四", "五", "六", "日"];
    for (const q of quiet) {
      const from = WD[q.weekday - 1] ?? String(q.weekday);
      const to = WD[(q.weekdayTo ?? q.weekday) - 1] ?? String(q.weekdayTo ?? q.weekday);
      const days = q.weekday === (q.weekdayTo ?? q.weekday) ? `周${from}` : `周${from}~周${to}`;
      lines.push(`- ${days} ${q.label}`);
    }
  }

  lines.push("", "【每天的空闲时段】");
  for (let d = input.from; d <= input.to; d = addDays(d, 1)) {
    days.push(d);
    const free = freeSlotsOn(db, occs, d, { minMinutes: input.minChunk })
      .filter((s) => s.penalty === 0)
      .map((s) => `${s.start}-${s.end}`);
    const classes = occs
      .filter((o) => o.date === d && o.category === "academic")
      .map((o) => `${o.start}-${o.end} ${o.title}`);
    lines.push(
      `${d}：${classes.length > 0 ? `有课（${classes.join("；")}）` : "没课"}；` +
        `空档 ${free.length > 0 ? free.join("、") : "无"}`,
    );
  }
  return { text: lines.join("\n"), days };
}

export type PlanProposer = (context: string) => Promise<ProposedBlock[]>;

async function defaultProposer(context: string): Promise<ProposedBlock[]> {
  // 用 extract 角色（flash）而不是 reason：这是个"按给定事实生成 JSON 方案"的任务，
  // 硬约束由代码校验，不需要最强推理；实测 reason 模型排一周要 90 秒以上，没法用。
  const cfg = getLlmConfig("extract");
  const res = await llm("extract").chat.completions.create(
    {
      model: cfg.model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: context },
      ],
      // 一周 7 天 × 每天最多 2 块，JSON 很容易超过 1500 token；
      // 给少了会被截断成半截 JSON（实测第 3528 字符就断了），整份白扔。
      max_tokens: 3000,
      temperature: 0.3,
      response_format: { type: "json_object" },
    },
    // 单次最多等 60 秒，且不重试（默认 maxRetries:4 会把超时放大成 5 倍）
    { timeout: 60_000, maxRetries: 0 },
  );
  const raw = res.choices[0]?.message?.content ?? "{}";
  return parseProposal(raw);
}

/** 去掉 ```json 围栏并截取第一个 JSON 对象 */
function stripFence(s: string): string {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? s).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start >= 0 && end > start) return body.slice(start, end + 1);
  return body;
}

/**
 * 解析模型给的方案。
 * 实测 DeepSeek 常把科目写成 `subject`（中文课名）而不是 `course_code`，
 * 也可能套 ```json 围栏 —— 两者都要能吃下，不能因为字段名不同就整份丢掉。
 */
/**
 * 从**被截断的** JSON 里尽量把完整的块捞出来。
 * 模型常因为 max_tokens 把数组写到一半就断，整份丢弃太浪费——
 * 已经完整的对象是能用的（合法性后面还有代码校验兜着）。
 */
export function salvageObjects(raw: string): unknown[] {
  const text = stripFence(raw);
  const start = text.indexOf("["); // 第一个数组就是 plan
  if (start < 0) return [];
  const out: unknown[] = [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  let objStart = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && objStart >= 0) {
        try {
          out.push(JSON.parse(text.slice(objStart, i + 1)));
        } catch {
          /* 这个对象本身坏了，跳过 */
        }
        objStart = -1;
      }
    }
  }
  return out;
}

export function parseProposal(raw: string): ProposedBlock[] {
  let list: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(stripFence(raw));
    // 模型不一定用 plan 这个键：数组、schedule、blocks、日程 都见过
    if (Array.isArray(parsed)) list = parsed;
    else if (parsed && typeof parsed === "object") {
      const o = parsed as Record<string, unknown>;
      for (const key of ["plan", "schedule", "blocks", "日程", "items"]) {
        if (Array.isArray(o[key])) {
          list = o[key] as unknown[];
          break;
        }
      }
    }
  } catch {
    // 截断了：从半截 JSON 里捞完整的对象
    list = salvageObjects(raw);
    if (list.length > 0) {
      console.error(`[plan] JSON 被截断，已从残片里救回 ${list.length} 个块`);
    }
  }
  if (list.length === 0) {
    console.error(`[plan] 方案为空：raw=${raw.slice(0, 160)}`);
    return [];
  }
  return list.map((item) => {
    const o = item as Record<string, unknown>;
    const subject = typeof o.subject === "string" ? o.subject : "";
    const code =
      typeof o.course_code === "string"
        ? o.course_code
        : subject && /^[A-Za-z][A-Za-z0-9_-]{1,15}$/.test(subject)
          ? subject.toUpperCase()
          : null;
    return proposedBlockSchema.parse({
      ...o,
      course_code: code,
      task: typeof o.task === "string" && o.task.trim() ? o.task : subject,
    });
  });
}

let proposer: PlanProposer = defaultProposer;

/** 测试注入：不联网也能验证"模型给坏块 → 被拒 + 原因" */
export function setPlanProposer(fn: PlanProposer): void {
  proposer = fn;
}

export interface LlmPlanResult {
  /** 通过硬约束的块（可直接展示/保存） */
  blocks: AcceptedBlock[];
  /** 被拒的块与原因，必须原样告诉用户 */
  dropped: RejectedBlock[];
  /** 模型是否给了方案（false = 调用失败或格式不对，调用方应回退规则版） */
  ok: boolean;
  model: string;
}

/** 让模型排一版，再用代码校验 */
export async function proposePlanWithLlm(
  db: DatabaseSync,
  input: BuildContextInput,
): Promise<LlmPlanResult> {
  const { text } = buildPlanContext(db, input);
  let proposed: ProposedBlock[] = [];
  try {
    // 第二层保险：不管 SDK 怎么重试，这里最多等 100 秒就放手，让调用方回退规则版
    proposed = await Promise.race([
      proposer(text),
      new Promise<ProposedBlock[]>((resolve) => {
        const t = setTimeout(() => {
          console.error("[plan] 模型排期超时（100s），回退规则版");
          resolve([]);
        }, 100_000);
        // 不让这个定时器拖住进程
        t.unref?.();
      }),
    ]);
  } catch (e) {
    console.error(`[plan] 模型排期失败，回退规则版：${(e as Error).message}`);
  }

  const caps = listCapacity(db);
  const weekCap =
    caps.find((c) => c.period === "week" && c.metric === "study_minutes" && c.max_value != null)
      ?.max_value ?? null;

  const guard = validateProposal(db, proposed, {
    from: input.from,
    to: input.to,
    perDayMinutes: input.perDayMinutes,
    minChunk: input.minChunk,
    maxChunk: input.maxChunk,
    weekCap,
  });

  return {
    blocks: guard.accepted,
    dropped: guard.rejected,
    ok: proposed.length > 0,
    // 排期用的是 extract 角色（快），别把 reason 的模型名报出去误导排查
    model: getLlmConfig("extract").model,
  };
}
