import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  addDays,
  dateOfWeek,
  expandOccurrences,
  freeSlotsOn,
  getActiveTerm,
  insertSchedule,
  listCapacity,
  listPreferences,
  planStudy,
  resolveWeek,
  toTime,
  weekdayOf,
} from "./service.js";

/**
 * 模型可调用的日程表接口。
 *
 * 三条铁律（写在 schema 里，模型看得到）：
 *   1) 永不占用 flexibility=0 的时间块（正课、考试、睡觉、兼职）
 *   2) 永不占用用户 avoid 的时段
 *   3) 永不覆盖 locked=1 的行（用户手改过）
 */

const WEEKDAY_NAMES = ["一", "二", "三", "四", "五", "六", "日"];

export const toolSchemas = [
  {
    name: "schedule_view",
    description:
      "查看某段日期内的完整日程：已占用时间块 + 每天的空闲时段。回答任何与'什么时候'有关的问题前必须先调用它。",
    parameters: z.object({
      from: z.string().describe("起始日期 YYYY-MM-DD"),
      to: z.string().optional().describe("结束日期，默认与 from 相同"),
    }),
  },
  {
    name: "schedule_add",
    description:
      "新增一个日程条目。可以是正课，也可以是用户想做的事（运动、兼职、午休、陪伴家人）。凡是用户说'我周三晚上想打球'，都用这个记录下来，不要当成空闲时间。",
    parameters: z.object({
      title: z.string(),
      category: z.enum(["academic", "life", "work", "rest", "plan"]),
      type: z.string().optional().describe("course/sport/sleep/work/rest/plan/other"),
      weekday: z.number().int().min(1).max(7).optional().describe("1=周一,7=周日；重复日程用"),
      date: z.string().optional().describe("一次性日程用 YYYY-MM-DD"),
      start_time: z.string().describe("HH:MM"),
      end_time: z.string().describe("HH:MM，可跨午夜"),
      week_start: z.number().int().optional(),
      week_end: z.number().int().optional(),
      week_parity: z.enum(["all", "odd", "even"]).optional(),
      flexibility: z.enum(["0", "1", "2"]).optional().describe("0不可动 1可微调 2可被学习计划占用"),
      intent: z.string().optional().describe("用户原话，例如'想打球放松'"),
      location: z.string().optional(),
    }),
  },
  {
    name: "schedule_update",
    description: "修改已有日程。修改后该条会被标记 locked，模型后续不得自动覆盖。",
    parameters: z.object({
      id: z.number().int(),
      start_time: z.string().optional(),
      end_time: z.string().optional(),
      weekday: z.number().int().min(1).max(7).optional(),
      flexibility: z.enum(["0", "1", "2"]).optional(),
      intent: z.string().optional(),
    }),
  },
  {
    name: "schedule_remove",
    description: "删除一条日程。locked=1 的条目必须先征得用户同意。",
    parameters: z.object({ id: z.number().int() }),
  },
  {
    name: "schedule_find_free",
    description: "查找可用空闲时段。返回的每个时段已排除所有占用与用户不想学习的时段。",
    parameters: z.object({
      from: z.string(),
      to: z.string().optional(),
      min_minutes: z.number().int().optional().describe("最短时长，默认 30"),
    }),
  },
  {
    name: "schedule_plan_study",
    description: "把学习任务排进空闲时段，只返回建议不写入。用户确认后再调用 schedule_apply_plan。",
    parameters: z.object({
      from: z.string(),
      to: z.string(),
      minutes_per_day: z.number().int().describe("每天预期学习分钟数"),
    }),
  },
  {
    name: "schedule_apply_plan",
    description: "把用户确认过的学习计划块写入日程。",
    parameters: z.object({
      blocks: z.array(
        z.object({
          date: z.string(),
          start: z.string(),
          end: z.string(),
          title: z.string().optional(),
        }),
      ),
    }),
  },
  {
    name: "preference_set",
    description: "记录用户对某时段的偏好。用户说'晚上不想学''周末留给自己'时调用。",
    parameters: z.object({
      weekday_from: z.number().int().min(1).max(7),
      weekday_to: z.number().int().min(1).max(7),
      start_time: z.string().optional(),
      end_time: z.string().optional(),
      mode: z.enum(["avoid", "prefer"]),
      applies_to: z.enum(["study", "life", "any"]).optional(),
      strength: z.enum(["1", "2", "3"]).optional(),
      reason: z.string().optional(),
    }),
  },
] as const;

// ───────────────────────── 实现 ─────────────────────────

export interface DayView {
  date: string;
  weekday: string;
  week: number;
  blocks: Array<{
    title: string;
    start: string;
    end: string;
    category: string;
    intent: string | null;
  }>;
  free: Array<{ start: string; end: string; minutes: number; warning: string | null }>;
}

function dayView(db: DatabaseSync, occs: ReturnType<typeof expandOccurrences>, d: string): DayView {
  const term = getActiveTerm(db);
  return {
    date: d,
    weekday: WEEKDAY_NAMES[weekdayOf(d) - 1]!,
    week: resolveWeek(d, term.start_date),
    blocks: occs
      .filter((o) => o.date === d)
      .map((o) => ({
        title: o.title,
        start: o.start,
        end: o.end,
        category: o.category,
        intent: o.intent,
      })),
    free: freeSlotsOn(db, occs, d).map((s) => ({
      start: s.start,
      end: s.end,
      minutes: s.minutes,
      warning: s.penalty > 0 ? s.reason : null,
    })),
  };
}

export function runTool(db: DatabaseSync, name: string, args: unknown): unknown {
  const schema = toolSchemas.find((t) => t.name === name);
  if (!schema) throw new Error(`未知工具: ${name}`);
  const a = schema.parameters.parse(args) as Record<string, unknown>;

  switch (name) {
    case "schedule_view": {
      const from = a.from as string;
      const to = (a.to as string | undefined) ?? from;
      const occs = expandOccurrences(db, from, to);
      const days: DayView[] = [];
      for (let d = from; d <= to; d = addDays(d, 1)) days.push(dayView(db, occs, d));
      return { days };
    }

    case "schedule_add": {
      const id = insertSchedule(db, {
        title: a.title as string,
        category: a.category as string,
        type: (a.type as string | undefined) ?? "other",
        weekday: (a.weekday as number | undefined) ?? null,
        date: (a.date as string | undefined) ?? null,
        start_time: a.start_time as string,
        end_time: a.end_time as string,
        week_start: (a.week_start as number | undefined) ?? 1,
        week_end: (a.week_end as number | undefined) ?? getActiveTerm(db).total_weeks,
        week_parity: (a.week_parity as "all" | "odd" | "even" | undefined) ?? "all",
        flexibility: Number((a.flexibility as string | undefined) ?? "0"),
        intent: (a.intent as string | undefined) ?? null,
        location: (a.location as string | undefined) ?? null,
        recurring: a.weekday != null ? 1 : 0,
        source: "generated",
      });
      return { ok: true, id };
    }

    case "schedule_update": {
      const id = a.id as number;
      const row = db.prepare("SELECT * FROM schedule WHERE id = ?").get(id);
      if (!row) throw new Error(`不存在 id=${id}`);
      const sets: string[] = [];
      const vals: Array<string | number | null> = [];
      for (const k of ["start_time", "end_time", "weekday", "flexibility", "intent"]) {
        const v = a[k];
        if (v !== undefined) {
          sets.push(`${k} = ?`);
          vals.push(v as string | number | null);
        }
      }
      sets.push("locked = 1");
      db.prepare(`UPDATE schedule SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
      return { ok: true, id, locked: true };
    }

    case "schedule_remove": {
      const id = a.id as number;
      const r = db.prepare("DELETE FROM schedule WHERE id = ? AND locked = 0").run(id);
      if (Number(r.changes) === 0) {
        return { ok: false, reason: "该条目已被用户手动修改（locked），需用户确认后才能删除" };
      }
      return { ok: true, id };
    }

    case "schedule_find_free": {
      const from = a.from as string;
      const to = (a.to as string | undefined) ?? from;
      const min = (a.min_minutes as number | undefined) ?? 30;
      const occs = expandOccurrences(db, from, to);
      const out = [];
      for (let d = from; d <= to; d = addDays(d, 1)) {
        const slots = freeSlotsOn(db, occs, d, { minMinutes: min })
          .filter((s) => s.penalty === 0)
          .map((s) => ({ start: s.start, end: s.end, minutes: s.minutes }));
        if (slots.length) out.push({ date: d, weekday: WEEKDAY_NAMES[weekdayOf(d) - 1]!, slots });
      }
      return { days: out };
    }

    case "schedule_plan_study": {
      const from = a.from as string;
      const to = a.to as string;
      const blocks = planStudy(db, {
        from,
        to,
        perDayMinutes: a.minutes_per_day as number,
      });
      const term = getActiveTerm(db);
      return {
        blocks,
        total_minutes: blocks.reduce((s, b) => s + b.minutes, 0),
        note: "以上为建议，未写入日程。用户确认后再调用 schedule_apply_plan。",
        weeks: [...new Set(blocks.map((b) => resolveWeek(b.date, term.start_date)))],
      };
    }

    case "schedule_apply_plan": {
      const blocks = a.blocks as Array<{
        date: string;
        start: string;
        end: string;
        title?: string;
      }>;
      const occs = expandOccurrences(
        db,
        blocks[0]?.date ?? "2000-01-01",
        blocks[blocks.length - 1]?.date ?? "2000-01-02",
      );
      const ids: number[] = [];
      for (const b of blocks) {
        // 写入前再校验一次，防止模型给了重叠时段
        const busy = dayView(db, occs, b.date).blocks;
        const clash = busy.some((x) => {
          const toM = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
          return toM(b.start) < toM(x.end) && toM(b.end) > toM(x.start);
        });
        if (clash) continue;
        ids.push(
          insertSchedule(db, {
            title: b.title ?? "学习计划",
            type: "plan",
            category: "plan",
            weekday: null,
            date: b.date,
            start_time: b.start,
            end_time: b.end,
            recurring: 0,
            flexibility: 2,
            source: "generated",
          }),
        );
      }
      return { ok: true, written: ids.length, skipped: blocks.length - ids.length };
    }

    case "preference_set": {
      db.prepare(
        `INSERT INTO time_preference
         (weekday_from, weekday_to, start_time, end_time, mode, applies_to, strength, reason)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(
        a.weekday_from as number,
        a.weekday_to as number,
        (a.start_time as string | undefined) ?? null,
        (a.end_time as string | undefined) ?? null,
        a.mode as string,
        (a.applies_to as string | undefined) ?? "study",
        Number((a.strength as string | undefined) ?? "2"),
        (a.reason as string | undefined) ?? null,
      );
      return { ok: true };
    }

    default:
      throw new Error(`工具未实现: ${name}`);
  }
}

/** 供调试：把用户配置原样带出来，模型据此措辞 */
export function describeUserContext(db: DatabaseSync): string {
  const term = getActiveTerm(db);
  const prefs = listPreferences(db);
  const caps = listCapacity(db);
  const lines: string[] = [
    `学期 ${term.name}，第1周周一 ${term.start_date}，共 ${term.total_weeks} 周`,
  ];
  for (const p of prefs) {
    const day =
      p.weekday_from === p.weekday_to
        ? `周${WEEKDAY_NAMES[p.weekday_from - 1]}`
        : `周${WEEKDAY_NAMES[p.weekday_from - 1]}~周${WEEKDAY_NAMES[p.weekday_to - 1]}`;
    const time = p.start_time ? `${p.start_time}-${p.end_time ?? "24:00"}` : "全天";
    lines.push(
      `${day} ${time} ${p.mode === "avoid" ? "不想" : "适合"}${p.applies_to}：${p.reason ?? ""}`,
    );
  }
  for (const c of caps) {
    lines.push(
      `${c.period} ${c.metric} ${c.max_value != null ? `≤${c.max_value}` : `≥${c.min_value}`}${c.note ? `（${c.note}）` : ""}`,
    );
  }
  return lines.join("\n");
}

export { dateOfWeek, toTime };
