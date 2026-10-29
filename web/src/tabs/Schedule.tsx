import { useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";
import { useDraft, useKept } from "../persist.ts";
import type { Block, Day, PlanBlock, ScheduleWrite, StudyLimits, WeekResponse } from "../types.ts";
import { durationLabel, hm, toMin } from "../types.ts";

const WD = ["一", "二", "三", "四", "五", "六", "日"];

const CATEGORIES: Array<{ key: string; label: string }> = [
  { key: "academic", label: "课程" },
  { key: "life", label: "生活" },
  { key: "work", label: "工作" },
  { key: "rest", label: "休息" },
  { key: "plan", label: "学习计划" },
];

const FLEX_LABEL: Record<number, string> = {
  0: "0 · 不可动（上课/睡觉/上班）",
  1: "1 · 可微调（可整体挪一挪）",
  2: "2 · 可被学习计划占用",
};

type Entry =
  | { kind: "block"; start: string; end: string; block: Block }
  | { kind: "gap"; start: string; end: string; minutes: number; warning: string | null }
  | { kind: "plan"; start: string; end: string; minutes: number; label?: string };

function timeline(day: Day, plan: PlanBlock[]): Entry[] {
  const entries: Entry[] = [
    ...day.blocks.map<Entry>((b) => ({ kind: "block", start: b.start, end: b.end, block: b })),
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
      label: p.label,
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

/** 日期 → 星期几（1=周一） */
function weekdayOfDate(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const g = new Date(y ?? 2000, (m ?? 1) - 1, d ?? 1).getDay();
  return g === 0 ? 7 : g;
}

function guessType(category: string): string {
  if (category === "academic") return "course";
  if (category === "work") return "work";
  if (category === "rest") return "rest";
  if (category === "plan") return "plan";
  return "other";
}

/** 跨午夜的时间块：睡觉 23:30–07:00、跨天兼职 */
function crossesMidnight(start: string, end: string): boolean {
  return toMin(end) <= toMin(start);
}

/**
 * 跨午夜的块结束时间属于次日，必须标出来；
 * 否则 23:30–07:00 看起来像"倒着走了 16 个半小时"。
 */
function spanLabel(start: string, end: string): string {
  return crossesMidnight(start, end) ? `${start}–次日 ${end}` : `${start}–${end}`;
}

/**
 * 块结束时刻，从**块开始那一天**的 0 点算起的分钟数。
 *
 * 跨午夜的块（23:30–07:00）结束在次日，直接取 toMin("07:00")=420 去比"现在几点"，
 * 会让今天还没开始的睡觉块在上午就被判成"已过去"标灰——这正是"没过去也标灰"的 bug。
 * 补 1440 分钟后 1860 > 任何当天时刻，今天的跨午夜块因此只会在它真正跑到次日结束后才变灰。
 */
export function endMinuteFromDayStart(start: string, end: string): number {
  const e = toMin(end);
  return crossesMidnight(start, end) ? e + 24 * 60 : e;
}

/** 编辑用的草稿：表单里全是字符串，保存时再转成接口格式 */
interface Draft {
  id: number | null;
  title: string;
  category: string;
  start: string;
  end: string;
  recurring: boolean;
  weekday: number;
  date: string;
  weekStart: number;
  weekEnd: number;
  parity: "all" | "odd" | "even";
  flexibility: number;
  location: string;
  intent: string;
}

function draftFromBlock(b: Block, dayDate: string, week: number, totalWeeks: number): Draft {
  const recurring = b.recurring === 1;
  return {
    id: b.id,
    title: b.title,
    category: b.category,
    start: b.start,
    end: b.end,
    recurring,
    weekday: b.weekday_no ?? weekdayOfDate(b.date ?? dayDate),
    date: b.date ?? dayDate,
    weekStart: b.week_start ?? week,
    weekEnd: b.week_end ?? totalWeeks,
    parity: (b.week_parity as Draft["parity"]) ?? "all",
    flexibility: b.flexibility ?? 0,
    location: b.location ?? "",
    intent: b.intent ?? "",
  };
}

function draftFromDay(day: Day, week: number, totalWeeks: number): Draft {
  return {
    id: null,
    title: "",
    category: "life",
    start: "08:00",
    end: "09:00",
    recurring: true,
    weekday: WD.indexOf(day.weekday) + 1 || 1,
    date: day.date,
    weekStart: Math.max(1, week),
    weekEnd: totalWeeks,
    parity: "all",
    flexibility: 0,
    location: "",
    intent: "",
  };
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
  // 「每天学多少」是用户的设定，记住它；排期建议是已经算出来的结果，切页也不该丢
  const [perDay, setPerDay] = useDraft("schedule.perDay", 120);
  const [plan, setPlan] = useKept<PlanBlock[] | null>("schedule.plan", null);
  /** 学习习惯：单次学习 / 单次休息上限，存在后端 capacity_rule，这里以后端为准 */
  const [limits, setLimits] = useState<StudyLimits>({ maxBlockMinutes: 60, maxBreakMinutes: 5 });
  const [planning, setPlanning] = useState(false);
  const [savingPlan, setSavingPlan] = useState(false);
  /** 清空「可被占用」日程进行中（防连点，避免两次批量删除） */
  const [clearing, setClearing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * 表单草稿存在 localStorage：切到别的页签、甚至关掉浏览器再回来，
   * 正在填的那条日程都还在（`draftRestored` 用来提示这是恢复出来的）。
   */
  const [draft, setDraft, clearDraft, draftRestored] = useDraft<Draft | null>(
    "schedule.form",
    null,
  );
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  /**
   * 「今天 / 现在几点」要跟着钟走：页面开着跨过整点（尤其跨过午夜）后仍用打开那一刻的值，
   * 灰不灰就和真实时间对不上。每分钟刷一次即可，代价只是一次轻量重渲染。
   */
  const [clock, setClock] = useState(() => ({ today: todayLocal(), nowMin: nowMinutes() }));
  useEffect(() => {
    const id = window.setInterval(() => {
      const t = todayLocal();
      const n = nowMinutes();
      setClock((c) => (c.today === t && c.nowMin === n ? c : { today: t, nowMin: n }));
    }, 60_000);
    return () => window.clearInterval(id);
  }, []);
  const today = clock.today;
  const nowMin = clock.nowMin;
  const totalWeeks = data.term.total_weeks;

  // 上限以后端为准（换设备也一致）；读不到就用默认值，绝不因此挡住排期
  useEffect(() => {
    void api
      .studyLimits()
      .then((r) =>
        setLimits({ maxBlockMinutes: r.maxBlockMinutes, maxBreakMinutes: r.maxBreakMinutes }),
      )
      .catch(() => undefined);
  }, []);

  const planByDate = useMemo(() => {
    const m = new Map<string, PlanBlock[]>();
    for (const b of plan ?? []) {
      const list = m.get(b.date) ?? [];
      list.push(b);
      m.set(b.date, list);
    }
    return m;
  }, [plan]);

  const runPlan = async (mode: "llm" | "rule" = "llm"): Promise<void> => {
    setPlanning(true);
    setNotice(null);
    try {
      const r = await api.plan(data.week, perDay, limits, mode);
      setPlan(r.blocks);
      setLimits(r.limits);
      const src =
        r.source === "llm"
          ? `${r.model ?? "模型"} 规划`
          : r.source === "rule"
            ? "规则版"
            : "模型未排出";
      const dropped = r.dropped?.length ?? 0;
      if (r.source === "failed") {
        setNotice(
          "模型这次没排出可用方案（超时或被拒）。可以点「让 qwen 排一版」重试，" +
            "或点「规则版」看兜底安排——它只是兜底，不代表模型意见。" +
            (dropped > 0 ? ` 被拒 ${dropped} 条。` : ""),
        );
        return;
      }
      setNotice(
        r.blocks.length === 0
          ? "这周排不出学习块：被假期、正课或偏好限制占满了。"
          : `（${src}）建议 ${r.blocks.length} 个块，合计 ${durationLabel(r.totalMinutes)}` +
              `（单次≤${r.limits.maxBlockMinutes} 分钟，块间休息≤${r.limits.maxBreakMinutes} 分钟）。` +
              (dropped > 0
                ? ` 有 ${dropped} 条建议被拒：${(r.dropped ?? [])
                    .slice(0, 2)
                    .map((d) => `${d.date} ${d.start}：${d.why}`)
                    .join("；")}${dropped > 2 ? "…" : ""}。`
                : "") +
              " 点「保存到日程」才会写进去。",
      );
    } catch (e) {
      setNotice(`排期失败：${(e as Error).message}`);
    } finally {
      setPlanning(false);
    }
  };

  /** 把建议写进日程：冲突块由后端跳过并回报，不硬塞 */
  const savePlan = async (): Promise<void> => {
    if (!plan || plan.length === 0) return;
    setSavingPlan(true);
    setNotice(null);
    try {
      const r = await api.applyPlan(plan);
      setNotice(
        r.message + (r.skipped.length > 0 ? `；首个跳过原因：${r.skipped[0]!.reason}` : ""),
      );
      setPlan(null);
      onRefresh();
    } catch (e) {
      setNotice(`保存失败：${(e as Error).message}`);
    } finally {
      setSavingPlan(false);
    }
  };

  const openEdit = (b: Block, dayDate: string): void => {
    setFormErr(null);
    setDraft(draftFromBlock(b, dayDate, data.week, totalWeeks));
  };

  const openAdd = (day: Day): void => {
    setFormErr(null);
    setDraft(draftFromDay(day, data.week, totalWeeks));
  };

  const patchDraft = (p: Partial<Draft>): void => {
    setDraft((d) => (d ? { ...d, ...p } : d));
  };

  const save = async (): Promise<void> => {
    if (!draft) return;
    if (!draft.title.trim()) {
      setFormErr("标题不能为空");
      return;
    }
    setSaving(true);
    setFormErr(null);
    try {
      const body: ScheduleWrite = {
        title: draft.title.trim(),
        category: draft.category,
        type: guessType(draft.category),
        start_time: draft.start,
        end_time: draft.end,
        recurring: draft.recurring ? 1 : 0,
        weekday: draft.recurring ? draft.weekday : null,
        date: draft.recurring ? null : draft.date,
        week_start: draft.weekStart,
        week_end: draft.weekEnd,
        week_parity: draft.parity,
        flexibility: draft.flexibility,
        location: draft.location.trim() || null,
        intent: draft.intent.trim() || null,
      };
      const r =
        draft.id == null
          ? await api.scheduleCreate(body)
          : await api.scheduleUpdate(draft.id, body);
      const clash =
        r.conflicts.length > 0
          ? `⚠ 与已有安排重叠 ${r.conflicts.length} 处：${r.conflicts.slice(0, 2).join("；")}`
          : null;
      setNotice([r.message, clash].filter(Boolean).join("　"));
      clearDraft();
      onRefresh();
    } catch (e) {
      setFormErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!draft || draft.id == null) return;
    const yes = window.confirm(
      `删除「${draft.title}」？\n这会同时移除它名下的调课/停课记录，且不能撤销。`,
    );
    if (!yes) return;
    setSaving(true);
    setFormErr(null);
    try {
      const r = await api.scheduleDelete(draft.id);
      setNotice(r.message ?? "已删除");
      clearDraft();
      onRefresh();
    } catch (e) {
      setFormErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /**
   * 清空所有「可被学习计划占用」的日程（flexibility=2）。
   *
   * 两步：先向后端要清单（几条第几块），弹确认框让用户看见再删。
   * 这类块是容器：可能是排期写进去的计划，也可能是用户自己留的空档，
   * 所以不做一键静默清空——删了不能恢复。
   */
  const clearOccupiable = async (): Promise<void> => {
    setNotice(null);
    try {
      const p = await api.scheduleOccupiable();
      if (p.count === 0) {
        setNotice("没有「可被学习计划占用」的日程，不需要清理。");
        return;
      }
      const sample = p.rows
        .slice(0, 6)
        .map((r) => `· ${r.when} ${r.title}`)
        .join("\n");
      const more = p.count > 6 ? `\n… 还有 ${p.count - 6} 条` : "";
      const yes = window.confirm(
        `将删除 ${p.count} 条「可被学习计划占用」的日程（全学期）：\n${sample}${more}\n\n` +
          "正课、可微调的安排不受影响；删除后不能恢复。确定删除？",
      );
      if (!yes) {
        setNotice(`已取消，没有删除任何日程（共 ${p.count} 条候选）。`);
        return;
      }
      setClearing(true);
      const r = await api.scheduleDeleteOccupiable();
      setNotice(r.message);
      onRefresh();
    } catch (e) {
      setNotice(`清理失败：${(e as Error).message}`);
    } finally {
      setClearing(false);
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
          <button
            type="button"
            className="primary"
            onClick={() => {
              const monday = data.days[0];
              if (monday) openAdd(monday);
            }}
          >
            ＋ 新建日程
          </button>
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
          <label className="lim" title="学习习惯：单次学习不超过这么多分钟">
            单次学
            <input
              type="number"
              min={10}
              max={240}
              step={5}
              value={limits.maxBlockMinutes}
              onChange={(e) => setLimits({ ...limits, maxBlockMinutes: Number(e.target.value) })}
            />
            分钟
          </label>
          <label className="lim" title="学习习惯：块间休息不超过这么多分钟（课间不算）">
            休息
            <input
              type="number"
              min={0}
              max={60}
              step={1}
              value={limits.maxBreakMinutes}
              onChange={(e) => setLimits({ ...limits, maxBreakMinutes: Number(e.target.value) })}
            />
            分钟
          </label>
          <button type="button" onClick={() => void runPlan("llm")} disabled={planning}>
            {planning ? "排期中…（qwen 在排）" : "让 qwen 排一版"}
          </button>
          <button type="button" onClick={() => void runPlan("rule")} disabled={planning}>
            规则版（不用模型）
          </button>
          {plan && plan.length > 0 && (
            <>
              <button type="button" className="primary" onClick={savePlan} disabled={savingPlan}>
                {savingPlan ? "保存中…" : `保存到日程（${plan.length} 块）`}
              </button>
              <button type="button" onClick={() => setPlan(null)}>
                清除
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => void clearOccupiable()}
            disabled={clearing}
            title="只删 flexibility=2 的块（可被学习计划占用的空档/已保存的计划块）；正课与可微调安排不动。会先列出清单让你确认。"
          >
            {clearing ? "正在清理…" : "清空「可被占用」的日程"}
          </button>
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
            onEdit={openEdit}
            onAdd={openAdd}
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
        <span className="lg">点时间块可编辑，点「＋ 添加」可补一条</span>
      </div>

      {draft && (
        <div className="modalback">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={draft.id == null ? "新建日程" : "编辑日程"}
          >
            <h3>{draft.id == null ? "新建日程" : "编辑日程"}</h3>

            <div className="formgrid">
              <label className="span2">
                标题
                <input
                  value={draft.title}
                  maxLength={40}
                  placeholder="例如：打篮球、线性代数复习、兼职"
                  onChange={(e) => patchDraft({ title: e.target.value })}
                />
              </label>

              <label>
                类别
                <select
                  value={draft.category}
                  onChange={(e) => patchDraft({ category: e.target.value })}
                >
                  {CATEGORIES.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                可动性
                <select
                  value={draft.flexibility}
                  onChange={(e) => patchDraft({ flexibility: Number(e.target.value) })}
                >
                  {[0, 1, 2].map((f) => (
                    <option key={f} value={f}>
                      {FLEX_LABEL[f]}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                开始
                <input
                  type="time"
                  value={draft.start}
                  onChange={(e) => patchDraft({ start: e.target.value })}
                />
              </label>
              <label>
                结束
                <input
                  type="time"
                  value={draft.end}
                  onChange={(e) => patchDraft({ end: e.target.value })}
                />
              </label>

              <label className="span2">
                重复方式
                <span className="seg">
                  <button
                    type="button"
                    className={draft.recurring ? "" : "on"}
                    onClick={() => patchDraft({ recurring: false })}
                  >
                    仅此一天
                  </button>
                  <button
                    type="button"
                    className={draft.recurring ? "on" : ""}
                    onClick={() =>
                      patchDraft({
                        recurring: true,
                        // 一次性日程的周次范围是占位值 1~1，切成每周时要扩到学期末
                        weekEnd: draft.weekEnd <= draft.weekStart ? totalWeeks : draft.weekEnd,
                      })
                    }
                  >
                    每周重复
                  </button>
                </span>
              </label>

              {draft.recurring ? (
                <>
                  <label>
                    星期几
                    <select
                      value={draft.weekday}
                      onChange={(e) => patchDraft({ weekday: Number(e.target.value) })}
                    >
                      {WD.map((w, i) => (
                        <option key={w} value={i + 1}>
                          周{w}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    周次范围
                    <span className="segin">
                      <input
                        type="number"
                        min={1}
                        max={totalWeeks}
                        value={draft.weekStart}
                        onChange={(e) => patchDraft({ weekStart: Number(e.target.value) })}
                      />
                      <span className="tilde">~</span>
                      <input
                        type="number"
                        min={1}
                        max={totalWeeks}
                        value={draft.weekEnd}
                        onChange={(e) => patchDraft({ weekEnd: Number(e.target.value) })}
                      />
                    </span>
                  </label>
                  <label>
                    单双周
                    <select
                      value={draft.parity}
                      onChange={(e) => patchDraft({ parity: e.target.value as Draft["parity"] })}
                    >
                      <option value="all">每周都上</option>
                      <option value="odd">仅单周</option>
                      <option value="even">仅双周</option>
                    </select>
                  </label>
                </>
              ) : (
                <label>
                  日期
                  <input
                    type="date"
                    value={draft.date}
                    onChange={(e) => patchDraft({ date: e.target.value })}
                  />
                </label>
              )}

              <label>
                地点
                <input
                  value={draft.location}
                  maxLength={40}
                  placeholder="可不填"
                  onChange={(e) => patchDraft({ location: e.target.value })}
                />
              </label>

              <label className="span2">
                意愿 / 备注（模型会原话引用，别写成标签）
                <textarea
                  value={draft.intent}
                  maxLength={200}
                  placeholder="例如：周三晚上想打球放松，别安排学习任务"
                  onChange={(e) => patchDraft({ intent: e.target.value })}
                />
              </label>
            </div>

            {formErr && <div className="alert errbox formerr">{formErr}</div>}

            <div className="formfoot">
              {draft.id != null && (
                <button type="button" className="danger" onClick={remove} disabled={saving}>
                  删除这条
                </button>
              )}
              <span className="grow" />
              <button type="button" onClick={clearDraft} disabled={saving}>
                取消
              </button>
              <button type="button" className="primary" onClick={save} disabled={saving}>
                {saving ? "保存中…" : "保存"}
              </button>
            </div>

            <p className="formhint">
              {draftRestored && <b>已恢复上次没保存的草稿。</b>}
              这里改的是整条日程（每周重复的会一起生效）。单次调课/停课请用
              <code>schedule_exception</code>，别改系列。点「取消」会丢弃这份草稿。
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function DayCol({
  day,
  plan,
  today,
  nowMin,
  onEdit,
  onAdd,
}: {
  day: Day;
  plan: PlanBlock[];
  today: string;
  nowMin: number;
  onEdit: (b: Block, dayDate: string) => void;
  onAdd: (day: Day) => void;
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
          const past = isPastDay || (isToday && endMinuteFromDayStart(e.start, e.end) <= nowMin);
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
                <span className="title">{e.label ?? "学习计划"}</span>
                <span className="intent">{e.minutes} 分钟 · 建议</span>
              </div>
            );
          }

          const b = e.block;
          const note = b.intent ?? b.location;
          const inner = (
            <>
              <span className="time">{spanLabel(e.start, e.end)}</span>
              <span className="title">{b.title}</span>
              {note && <span className="intent">{note}</span>}
            </>
          );

          // 调课/补课/额外加课的临时块没有独立行，改它的系列会误导用户
          if (b.id < 0 || b.fromException || b.fromMakeup) {
            const why = b.fromMakeup
              ? "调休补课产生的块，改原课程才会生效"
              : b.id < 0
                ? "临时加课，没有可编辑的日程行"
                : "调课产生的块，改原课程才会生效";
            return (
              <div className={`blk cat-${b.category}${past ? " past" : ""}`} key={key} title={why}>
                <span className="time">{spanLabel(e.start, e.end)}</span>
                <span className="title">{b.title}</span>
                {note && <span className="intent">{note}</span>}
                <span className="exflag">{b.fromMakeup ? "调休" : "调整"}</span>
              </div>
            );
          }

          return (
            <button
              type="button"
              className={`blk cat-${b.category}${past ? " past" : ""} editable`}
              key={key}
              title="点击编辑"
              onClick={() => onEdit(b, day.date)}
            >
              {inner}
              <span className="edt">✎</span>
            </button>
          );
        })}
      </div>

      <div className="foot">
        <span>空闲 {freeMin > 0 ? durationLabel(freeMin) : "无"}</span>
        <button type="button" className="addbtn" onClick={() => onAdd(day)}>
          ＋ 添加
        </button>
      </div>
    </div>
  );
}

export { hm };
