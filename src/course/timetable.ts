import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { llm } from "../llm/client.js";
import { getLlmConfig } from "../llm/models.js";

/**
 * 课表识别：把截图转录/粘贴的课表文本，变成可写入 schedule 的行。
 *
 * 判断（哪段是哪门课、周几、几节）交模型；格式、边界、去重留代码。
 * 节次 → 时间用 class_slot（教务作息，属于先验知识），不让模型自己编时间。
 */

export interface TimetableRow {
  title: string;
  /** 1=周一 … 7=周日 */
  weekday: number;
  start: string;
  end: string;
  location: string | null;
}

export interface TimetableParseResult {
  rows: TimetableRow[];
  /** 被代码丢掉的行（周几越界、时间格式错、缺标题） */
  dropped: Array<{ reason: string; raw: unknown }>;
  model: string;
  ms: number;
}

const slotSchema = z.object({
  title: z.string().catch(""),
  weekday: z.number().int().min(1).max(7).catch(0),
  start: z.string().catch(""),
  end: z.string().catch(""),
  location: z.string().nullable().catch(null),
});
const parseSchema = z.object({ courses: z.array(slotSchema).catch([]) });

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function toMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** 读 class_slot，给模型一份"第 N 节 = 几点到几点"的对照表 */
export function classSlots(
  db: DatabaseSync,
): Array<{ period: number; start: string; end: string }> {
  return db
    .prepare("SELECT period, start_time AS start, end_time AS end FROM class_slot ORDER BY period")
    .all() as unknown as Array<{ period: number; start: string; end: string }>;
}

export interface ParseTimetableInput {
  /** 从图片转录出的文字，或用户直接粘贴的课表文字 */
  text: string;
  /** 学期周次范围（默认 1–18） */
  weekStart?: number;
  weekEnd?: number;
}

export interface NormalizedTimetable {
  rows: TimetableRow[];
  dropped: Array<{ reason: string; raw: unknown }>;
}

/**
 * 校验并规范化模型给出的课程行（纯函数，可单测）：
 * 周几 1–7、时间 HH:MM 且结束晚于开始、同一门课同一时段去重。
 */
export function normalizeTimetableRows(
  courses: Array<z.infer<typeof slotSchema>>,
): NormalizedTimetable {
  const rows: TimetableRow[] = [];
  const dropped: Array<{ reason: string; raw: unknown }> = [];
  const seen = new Set<string>();
  for (const c of courses) {
    const title = c.title.trim();
    if (!title) {
      dropped.push({ reason: "缺课程名", raw: c });
      continue;
    }
    if (c.weekday < 1 || c.weekday > 7) {
      dropped.push({ reason: `周几越界：${c.weekday}`, raw: c });
      continue;
    }
    if (!TIME_RE.test(c.start) || !TIME_RE.test(c.end) || toMin(c.end) <= toMin(c.start)) {
      dropped.push({ reason: `时间不合法：${c.start}-${c.end}`, raw: c });
      continue;
    }
    const key = `${title}|${c.weekday}|${c.start}`;
    if (seen.has(key)) {
      dropped.push({ reason: "重复行", raw: c });
      continue;
    }
    seen.add(key);
    rows.push({
      title,
      weekday: c.weekday,
      start: c.start,
      end: c.end,
      location: c.location?.trim() || null,
    });
  }
  return { rows, dropped };
}

export async function parseTimetable(
  db: DatabaseSync,
  input: ParseTimetableInput,
): Promise<TimetableParseResult> {
  const t0 = Date.now();
  const slots = classSlots(db);
  const slotText =
    slots.length > 0
      ? slots.map((s) => `第 ${s.period} 节 ${s.start}-${s.end}`).join("\n")
      : "（教务作息表未导入：如果课表只写了节次，请按 45 分钟一节从 08:00 起推算，并在 reason 里说明）";

  const cfg = getLlmConfig("extract");
  const r = await llm("extract").chat.completions.create({
    model: cfg.model,
    messages: [
      {
        role: "system",
        content: `你是教务课表解析器。把课表文本转成结构化课程列表，只输出 JSON。

规则：
1. 一门课一周上两次就输出两条（weekday、start、end 不同）。
2. weekday 用 1–7 表示周一到周日。
3. 时间用 24 小时制 HH:MM；课表只写节次时，用【教务作息】换算成起止时间。
4. title 用课表上的课程全名（保留括号、罗马数字），不要自己改写、不要翻译。
5. location 原文照抄；没有就填 null。
6. 不要输出作息表、表头、星期、注意字样这些非课程行。
7. 看不准的行宁可不输出，也不要编。

输出：{"courses":[{"title":"大学物理(B)II","weekday":1,"start":"09:50","end":"11:25","location":"教四-202"}]}`,
      },
      {
        role: "user",
        content: `【教务作息】\n${slotText}\n\n【课表文本】\n${input.text.slice(0, 12000)}`,
      },
    ],
    max_tokens: 2000,
    temperature: 0,
    response_format: { type: "json_object" },
  });

  const raw = r.choices[0]?.message?.content ?? "{}";
  let parsed: z.infer<typeof parseSchema>;
  try {
    parsed = parseSchema.parse(JSON.parse(raw));
  } catch {
    parsed = { courses: [] };
  }

  const { rows, dropped } = normalizeTimetableRows(parsed.courses);
  return { rows, dropped, model: cfg.model, ms: Date.now() - t0 };
}
