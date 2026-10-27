import { useMemo, useState } from "react";
import { api } from "../api.ts";
import type { Day, PlanBlock, WeekResponse } from "../types.ts";
import { durationLabel, hm, toMin } from "../types.ts";

const WD = ["一", "二", "三", "四", "五", "六", "日"];

type Entry =
  | {
      kind: "block";
      start: string;
      end: string;
      title: string;
      category: string;
      intent: string | null;
    }
  | { kind: "gap"; start: string; end: string; minutes: number; warning: string | null }
  | { kind: "plan"; start: string; end: string; minutes: number };

function timeline(day: Day, plan: PlanBlock[]): Entry[] {
  const entries: Entry[] = [
    ...day.blocks.map<Entry>((b) => ({
      kind: "block",
      start: b.start,
      end: b.end,
      title: b.title,
      category: b.category,
      intent: b.intent,
    })),
    ...day.free.map<Entry>((f) => ({
      kind: "gap",
      start: f.start,
      end: f.end,
      minutes: f.minutes,
      warning: f.warning,
    })),
    ...plan.map<Entry>((p) => ({
      kind: "plan",
      start: p.start,
      end: p.end,
      minutes: p.minutes,
    })),
  ];
  return entries.sort((a, b) => toMin(a.start) - toMin(b.start));
}

function todayLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function nowMinutes(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

export default function Schedule({
  data,
  loading,
  onWeek,
  onRefresh,
}: {
  data: WeekResponse;
  loading: boolean;
  onWeek: (w: number) => void;
  onRefresh: () => void;
}) {
  const [perDay, setPerDay] = useState(120);
  const [plan, setPlan] = useState<PlanBlock[] | null>(null);
  const [planning, setPlanning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const today = todayLocal();
  const nowMin = nowMinutes();

  const planByDate = useMemo(() => {
    const m = new Map<string, PlanBlock[]>();
    for (const b of plan ?? []) {
      const list = m.get(b.date) ?? [];
      list.push(b);
      m.set(b.date, list);
    }
    return m;
  }, [plan]);

  const runPlan = async (): Promise<void> => {
    setPlanning(true);
    setNotice(null);
    try {
      const r = await api.plan(data.week, perDay);
      setPlan(r.blocks);
      setNotice(
        r.blocks.length === 0
          ? "这周排不出学习块：被假期、正课或偏好限制占满了。"
          : `建议 ${r.blocks.length} 个块，合计 ${durationLabel(r.totalMinutes)}（未写入日程）。`,
      );
    } catch (e) {
      setNotice(`排期失败：${(e as Error).message}`);
    } finally {
      setPlanning(false);
    }
  };

  return (
    <div className="schedule">
      <div className="bar">
        <div className="nav">
          <button type="button" onClick={() => onWeek(data.week - 1)} disabled={data.week <= 1}>
            ← 上一周
          </button>
          <button type="button" onClick={onRefresh} className={loading ? "busy" : ""}>
            本周
          </button>
          <button
            type="button"
            onClick={() => onWeek(data.week + 1)}
            disabled={data.week >= data.term.total_weeks}
          >
            下一周 →
          </button>
          <span className="weekbox">
            第 {data.week} / {data.term.total_weeks} 周 · {data.from} ~ {data.to}
          </span>
        </div>

        <div className="planbar">
          <label>
            每天学
            <input
              type="range"
              min={30}
              max={360}
              step={30}
              value={perDay}
              onChange={(e) => setPerDay(Number(e.target.value))}
            />
            <b>{perDay} 分钟</b>
          </label>
          <button type="button" className="primary" onClick={runPlan} disabled={planning}>
            {planning ? "排期中…" : "生成建议"}
          </button>
          {plan && (
            <button type="button" onClick={() => setPlan(null)}>
              清除
            </button>
          )}
        </div>
      </div>

      {notice && <div className="notice">{notice}</div>}

      <div className="grid">
        {data.days.map((d) => (
          <DayCol
            key={d.date}
            day={d}
            plan={planByDate.get(d.date) ?? []}
            today={today}
            nowMin={nowMin}
          />
        ))}
      </div>

      <div className="legend">
        {Object.entries({
          academic: "课程",
          life: "生活",
          rest: "休息",
          plan: "学习计划",
        }).map(([k, label]) => (
          <span key={k} className="lg">
            <i className={`dot cat-${k}`} />
            {label}
          </span>
        ))}
        <span className="lg">
          <i className="dot gapdot" />
          待填充空闲
        </span>
        <span className="lg">
          <i className="dot pastdot" />
          已过去
        </span>
      </div>
    </div>
  );
}

function DayCol({
  day,
  plan,
  today,
  nowMin,
}: {
  day: Day;
  plan: PlanBlock[];
  today: string;
  nowMin: number;
}) {
  const isToday = day.date === today;
  const isPastDay = day.date < today;
  const entries = timeline(day, plan);
  const freeMin = day.free.reduce((s, f) => s + f.minutes, 0);
  const wdIdx = WD.indexOf(day.weekday);

  return (
    <div
      className={`col${isToday ? " today" : ""}${isPastDay ? " pastday" : ""}${wdIdx >= 5 ? " weekend" : ""}`}
    >
      <div className="colhead">
        <span className="wk">周{day.weekday}</span>
        <span className="dt">
          {Number(day.date.slice(5, 7))}.{Number(day.date.slice(8, 10))}
        </span>
      </div>

      {isToday && <div className="badge badge-today">今天</div>}
      {day.teaching && (
        <div className={`badge badge-${day.teaching.kind}`}>
          {day.teaching.kind === "holiday" && "放假"}
          {day.teaching.kind === "suspended" && "停课"}
          {day.teaching.kind === "makeup" && "调休补课"}
        </div>
      )}

      <div className="tl">
        {entries.length === 0 && <div className="empty">无任何安排</div>}
        {entries.map((e, i) => {
          const past = isPastDay || (isToday && toMin(e.end) <= nowMin);
          const key = `${e.kind}-${e.start}-${i}`;
          if (e.kind === "gap") {
            return (
              <div className={`gap${past ? " past" : ""}${e.warning ? " warn" : ""}`} key={key}>
                <span className="gt">
                  {e.start}–{e.end}
                </span>
                <span className="gl">待填充 · {durationLabel(e.minutes)}</span>
                {e.warning && <span className="gw">⚠ {e.warning}</span>}
              </div>
            );
          }
          if (e.kind === "plan") {
            return (
              <div className={`blk cat-plan${past ? " past" : ""}`} key={key}>
                <span className="time">
                  {e.start}–{e.end}
                </span>
                <span className="title">学习计划</span>
                <span className="intent">{e.minutes} 分钟 · 建议</span>
              </div>
            );
          }
          return (
            <div className={`blk cat-${e.category}${past ? " past" : ""}`} key={key}>
              <span className="time">
                {e.start}–{e.end}
              </span>
              <span className="title">{e.title}</span>
              {e.intent && <span className="intent">{e.intent}</span>}
            </div>
          );
        })}
      </div>

      <div className="foot">空闲 {freeMin > 0 ? durationLabel(freeMin) : "无"}</div>
    </div>
  );
}

export { hm };
