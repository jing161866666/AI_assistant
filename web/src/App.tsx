import { useCallback, useEffect, useMemo, useState } from "react";
import type { Day, PlanBlock, PlanResponse, WeekResponse } from "./types.ts";
import { CATEGORY_LABEL, METRIC_LABEL } from "./types.ts";

const WD_NAME = ["一", "二", "三", "四", "五", "六", "日"];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

function fmtDate(d: string): string {
  const [, m, day] = d.split("-");
  return `${Number(m)}.${Number(day)}`;
}

export default function App() {
  const [week, setWeek] = useState<number | null>(null);
  const [data, setData] = useState<WeekResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [perDay, setPerDay] = useState(120);
  const [plan, setPlan] = useState<PlanBlock[] | null>(null);
  const [planning, setPlanning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (w: number | null) => {
    setLoading(true);
    setError(null);
    try {
      const q = w == null ? "" : `?week=${w}`;
      const d = await api<WeekResponse>(`/api/week${q}`);
      setData(d);
      setWeek(d.week);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(null);
  }, [load]);

  const maxWeek = data?.term.total_weeks ?? 18;

  const goWeek = (delta: number) => {
    if (week == null) return;
    const next = Math.min(maxWeek, Math.max(1, week + delta));
    setPlan(null);
    void load(next);
  };

  const runPlan = async () => {
    if (!data) return;
    setPlanning(true);
    setNotice(null);
    try {
      const r = await api<PlanResponse>("/api/plan", {
        method: "POST",
        body: JSON.stringify({ week: data.week, perDayMinutes: perDay }),
      });
      setPlan(r.blocks);
      setNotice(
        r.blocks.length === 0
          ? "这一周排不出学习块：可能被假期、正课或偏好限制占满。"
          : `建议 ${r.blocks.length} 个块，合计 ${r.totalMinutes} 分钟（未写入日程）。`,
      );
    } catch (e) {
      setNotice(`排期失败：${(e as Error).message}`);
    } finally {
      setPlanning(false);
    }
  };

  const planByDate = useMemo(() => {
    const m = new Map<string, PlanBlock[]>();
    for (const b of plan ?? []) {
      const list = m.get(b.date) ?? [];
      list.push(b);
      m.set(b.date, list);
    }
    return m;
  }, [plan]);

  if (loading && !data) {
    return <div className="center">加载中…</div>;
  }
  if (error) {
    return (
      <div className="center">
        <div className="err">
          <strong>接口出错</strong>
          <pre>{error}</pre>
          <p>请确认后端已启动：npm run dev</p>
        </div>
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="logo">◉</span>
          <div>
            <h1>AI 学习伙伴</h1>
            <p className="sub">
              {data.term.name} · 第 {data.week} 周 · {data.from} ~ {data.to}
            </p>
          </div>
        </div>

        <div className="nav">
          <button type="button" onClick={() => goWeek(-1)} disabled={data.week <= 1}>
            ← 上一周
          </button>
          <span className="weekbox">
            第 {data.week} / {maxWeek} 周
          </span>
          <button type="button" onClick={() => goWeek(1)} disabled={data.week >= maxWeek}>
            下一周 →
          </button>
        </div>
      </header>

      <section className="context">
        <div className="ctx-item">
          <span className="k">今天</span>
          <span className="v">{data.today}</span>
        </div>
        <div className="ctx-item">
          <span className="k">当前教学周</span>
          <span className="v">
            {data.context.currentWeek > 0 ? `第 ${data.context.currentWeek} 周` : "不在学期内"}
          </span>
        </div>
        <div className="ctx-item">
          <span className="k">课程</span>
          <span className="v">{data.context.courses.length} 门</span>
        </div>
        {data.context.capacities.map((c) => (
          <div className="ctx-item" key={`${c.period}-${c.metric}`}>
            <span className="k">
              {c.period === "week" ? "每周" : "每天"}
              {METRIC_LABEL[c.metric] ?? c.metric}
            </span>
            <span className="v">
              {c.max_value != null ? `≤ ${c.max_value}` : `≥ ${c.min_value}`}
            </span>
          </div>
        ))}
      </section>

      <div className="layout">
        <main className="grid">
          {data.days.map((d) => (
            <DayColumn
              key={d.date}
              day={d}
              isToday={d.date === data.today}
              plan={planByDate.get(d.date) ?? []}
            />
          ))}
        </main>

        <aside className="side">
          <section className="card">
            <h2>排学习计划</h2>
            <p className="hint">只在空闲且未被偏好排除的时段里排，绝不占用正课与睡眠。</p>
            <label className="field">
              <span>每天学习分钟数</span>
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
              {planning ? "排期中…" : "生成本周建议"}
            </button>
            {notice && <p className="notice">{notice}</p>}
          </section>

          <section className="card">
            <h2>课程</h2>
            <ul className="list">
              {data.context.courses.map((c) => (
                <li key={c.title}>
                  <span className="dot cat-academic" />
                  <span className="name">{c.title}</span>
                  <span className="meta">{c.count} 节</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="card">
            <h2>时段偏好</h2>
            {data.context.preferences.length === 0 ? (
              <p className="hint">尚未设置。告诉助手「晚上不想学」就会记下来。</p>
            ) : (
              <ul className="list">
                {data.context.preferences.map((p) => (
                  <li key={`${p.weekday_from}-${p.weekday_to}-${p.start_time}-${p.mode}`}>
                    <span className={p.mode === "avoid" ? "dot cat-work" : "dot cat-life"} />
                    <span className="name">
                      周{WD_NAME[p.weekday_from - 1]}
                      {p.weekday_to !== p.weekday_from ? `~周${WD_NAME[p.weekday_to - 1]}` : ""}{" "}
                      {p.start_time ? `${p.start_time}-${p.end_time}` : "全天"}
                    </span>
                    <span className="meta">{p.mode === "avoid" ? "不想学" : "适合学"}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card legend">
            <h2>图例</h2>
            <ul className="list">
              {Object.entries(CATEGORY_LABEL).map(([k, label]) => (
                <li key={k}>
                  <span className={`dot cat-${k}`} />
                  <span className="name">{label}</span>
                </li>
              ))}
              <li>
                <span className="dot cat-free" />
                <span className="name">空闲（可排）</span>
              </li>
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}

function DayColumn({ day, isToday, plan }: { day: Day; isToday: boolean; plan: PlanBlock[] }) {
  const wk = WD_NAME.indexOf(day.weekday);
  const isWeekend = wk >= 5;
  return (
    <div className={`col${isToday ? " today" : ""}${isWeekend ? " weekend" : ""}`}>
      <div className="colhead">
        <span className="wk">周{day.weekday}</span>
        <span className="dt">{fmtDate(day.date)}</span>
      </div>

      {day.teaching && (
        <div className={`badge badge-${day.teaching.kind}`}>
          {day.teaching.kind === "holiday" && "放假"}
          {day.teaching.kind === "suspended" && "停课"}
          {day.teaching.kind === "makeup" && "调休补课"}
          {day.teaching.note ? ` · ${day.teaching.note}` : ""}
        </div>
      )}

      <div className="blocks">
        {day.blocks.length === 0 && !day.teaching && <div className="empty">无安排</div>}
        {day.blocks.map((b) => (
          <div className={`blk cat-${b.category}`} key={`${b.start}-${b.title}`}>
            <div className="time">
              {b.start}-{b.end}
            </div>
            <div className="title">{b.title}</div>
            {b.intent && <div className="intent">{b.intent}</div>}
          </div>
        ))}
        {plan.map((p) => (
          <div className="blk cat-plan" key={`plan-${p.start}`}>
            <div className="time">
              {p.start}-{p.end}
            </div>
            <div className="title">学习计划</div>
            <div className="intent">{p.minutes} 分钟 · 建议</div>
          </div>
        ))}
      </div>

      <div className="free">
        {day.free.slice(0, 4).map((f) => (
          <div className={`slot${f.warning ? " warn" : ""}`} key={f.start} title={f.warning ?? ""}>
            {f.start}-{f.end}
            {f.warning ? " ⚠" : ""}
          </div>
        ))}
        {day.free.length > 4 && <div className="slot more">+{day.free.length - 4}</div>}
      </div>
    </div>
  );
}
