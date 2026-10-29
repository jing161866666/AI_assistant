import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import type { SubjectSummary } from "../types.ts";

interface Chapter {
  chapter_no: number;
  /** 合并用户改名后的显示名 */
  chapter_title: string;
  /** 教材库原名，用于「恢复原名」 */
  library_title?: string;
  /** 是否被用户改过名 */
  edited?: boolean;
  status: string;
}

interface Habit {
  id?: number;
  dimension: string;
  key: string;
  value: string;
  course_code: string | null;
  confidence: number;
  evidence_count: number;
  /** /api/habits 会给：是否已达注入阈值 */
  injectable?: boolean;
  status?: string;
  /** manual = 用户自己填的（可改可删）；model = 模型推断（只能否决） */
  source?: string;
}

/** 一次抽取尝试的结果（/api/habits/status 的 runs） */
interface HabitRun {
  id: number;
  ts: string;
  sourceType: string;
  sourceId: number | null;
  candidates: number;
  enough: boolean;
  ms: number;
  model: string;
  error: string | null;
}

interface HabitStatus {
  pending: number;
  running: boolean;
  processed: number;
  failed: number;
  lastError: string | null;
  lastAt: string | null;
  runs: HabitRun[];
}

interface ProgressData {
  courseCode?: string;
  maxChapterNo: number | null;
  learned: number[];
  /** 已学上限之内被跳过的章节（断层），必须提示，否则模型会当学过 */
  gaps?: number[];
  guard?: "ok" | "no-progress";
  chapters: Chapter[];
  habits: Habit[];
  preferences: Array<{
    id?: number;
    weekday_from: number;
    weekday_to: number;
    start_time: string | null;
    end_time: string | null;
    mode: string;
    reason: string | null;
  }>;
  capacities: Array<{
    period: string;
    metric: string;
    min_value: number | null;
    max_value: number | null;
  }>;
  goals: Array<{ title: string; deadline: string | null }>;
}

const DIM_LABEL: Record<string, string> = {
  learn_method: "学习方式",
  code_naming: "代码命名",
  notation: "符号偏好",
  error_pattern: "反复出错",
  planning: "计划习惯",
  help_seeking: "求助方式",
  attention: "专注时长",
};

const WD = ["一", "二", "三", "四", "五", "六", "日"];

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...init });
  const j = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(j.error ?? `${res.status}`);
  return j;
}

/**
 * 「我的进度」。
 *
 * 顶部是**各科目**的进度卡片：每门课各自一条，不合并成一个总进度。
 * 下面才是当前科目的章节网格 + 习惯 + 注入画像。
 */
export default function Progress({
  course,
  onPickCourse,
  onChanged,
}: {
  course: string;
  onPickCourse: (code: string) => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<ProgressData | null>(null);
  /** 全部科目的进度概况：每门课一张卡，不做加权合并 */
  const [overview, setOverview] = useState<SubjectSummary[]>([]);
  /** 全部习惯（含证据不足的）：画像只用达标的，但界面要能看见全部 */
  const [allHabits, setAllHabits] = useState<Habit[]>([]);
  const [hstatus, setHStatus] = useState<HabitStatus | null>(null);
  const [prompt, setPrompt] = useState<string>("");
  const [showPrompt, setShowPrompt] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 教材库里真实存在的章节（含改名后的名称）；不存在的不显示 */
  const [chapters, setChapters] = useState<Chapter[]>([]);
  /** 重命名模式：开启后点章节不会推进进度，而是打开改名框 */
  const [renameMode, setRenameMode] = useState(false);
  const [editingNo, setEditingNo] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editLibraryTitle, setEditLibraryTitle] = useState("");
  /** 新增「不想学」时段的表单：默认就是最常见的午休 12:00-13:30 */
  const [pref, setPref] = useState({
    weekdayFrom: 1,
    weekdayTo: 7,
    start: "12:00",
    end: "13:30",
    mode: "avoid" as "avoid" | "prefer",
    reason: "午休",
  });
  /** 正在修改的那条自述习惯（id）；null = 没有在编辑 */
  const [editHabit, setEditHabit] = useState<number | null>(null);
  const [editKey, setEditKey] = useState("");
  const [editValue, setEditValue] = useState("");
  const q = `?course=${encodeURIComponent(course)}`;

  const load = useCallback(async () => {
    try {
      const d = await req<ProgressData>(`/api/progress${q}`);
      setData(d);
      const [p, o, hs, st, ch] = await Promise.all([
        req<{ prompt: string }>(`/api/profile/prompt${q}`),
        api.progressOverview(),
        // 进度页只看"属于这门课"的习惯；个人共用习惯在「科目」页维护，不在这里重复
        req<{ habits: Habit[] }>(`/api/habits${q}&scope=course`),
        req<HabitStatus>("/api/habits/status"),
        // 章节以教材库为准：没有的章不显示，名称取用户改名后的
        req<{ chapters: Chapter[] }>(`/api/progress/chapters${q}`),
      ]);
      setPrompt(p.prompt ?? "");
      // 后端可能是旧进程：字段缺失时降级成空集，不能让它把整页打白
      setOverview(Array.isArray(o.subjects) ? o.subjects : []);
      setAllHabits(Array.isArray(hs.habits) ? hs.habits : []);
      setChapters(Array.isArray(ch.chapters) ? ch.chapters : []);
      setHStatus({
        pending: Number(st?.pending ?? 0),
        running: Boolean(st?.running),
        processed: Number(st?.processed ?? 0),
        failed: Number(st?.failed ?? 0),
        lastError: st?.lastError ?? null,
        lastAt: st?.lastAt ?? null,
        runs: Array.isArray(st?.runs) ? st.runs : [],
      });
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [q]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 新增一条「不想学 / 适合学」时段；排期时它会同时进提示词和代码校验 */
  const addPref = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await req("/api/preferences", { method: "POST", body: JSON.stringify(pref) });
      await load();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const removePref = async (id: number): Promise<void> => {
    try {
      await req(`/api/preferences/${id}`, { method: "DELETE" });
      await load();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const advance = async (n: number): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const d = await req<ProgressData>("/api/progress/advance", {
        method: "POST",
        body: JSON.stringify({ chapterNo: n, course }),
      });
      setData(d);
      await load();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reset = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      // 一次删掉该科目的全部章节进度；不要逐章写 not_started（会凭空留下 1..40 个空章）
      await req(`/api/progress${q}`, { method: "DELETE" });
      await load();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** 进入改名：把当前名称与教材原名都带上，便于「恢复原名」 */
  const startRename = (c: Chapter): void => {
    setEditingNo(c.chapter_no);
    setEditTitle(c.chapter_title);
    setEditLibraryTitle(c.library_title ?? "");
    setErr(null);
  };

  const saveRename = async (): Promise<void> => {
    if (editingNo == null) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await req<{ chapters: Chapter[] }>(`/api/progress/chapters/${editingNo}`, {
        method: "PUT",
        body: JSON.stringify({ course, title: editTitle }),
      });
      if (Array.isArray(r.chapters)) setChapters(r.chapters);
      setEditingNo(null);
      // 画像原文里也有章节表，改名后重新拉一次
      await load();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const restoreName = async (): Promise<void> => {
    if (editingNo == null) return;
    setEditTitle("");
    setBusy(true);
    setErr(null);
    try {
      const r = await req<{ chapters: Chapter[] }>(`/api/progress/chapters/${editingNo}`, {
        method: "PUT",
        body: JSON.stringify({ course, title: "" }),
      });
      if (Array.isArray(r.chapters)) setChapters(r.chapters);
      setEditingNo(null);
      await load();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const startEditHabit = (h: Habit): void => {
    if (h.id == null) return;
    setEditHabit(h.id);
    setEditKey(h.key);
    setEditValue(h.value);
    setErr(null);
  };

  const saveEditHabit = async (): Promise<void> => {
    if (editHabit == null) return;
    setBusy(true);
    setErr(null);
    try {
      await api.updateManualHabit(editHabit, { key: editKey.trim(), value: editValue.trim() });
      setEditHabit(null);
      await load();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const removeHabit = async (h: Habit): Promise<void> => {
    if (h.id == null) return;
    if (!window.confirm(`删除这条自述习惯？\n${h.key} → ${h.value}`)) return;
    setBusy(true);
    setErr(null);
    try {
      await api.deleteManualHabit(h.id);
      if (editHabit === h.id) setEditHabit(null);
      await load();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <div className="center">{err ?? "加载中…"}</div>;

  /** 界面用全量习惯（含证据不足的），画像注入用的才是达标子集 */
  const shownHabits = allHabits.length > 0 ? allHabits : (data.habits ?? []);
  const injectCount = shownHabits.filter((h) => h.injectable === true).length;

  const byDim = new Map<string, Habit[]>();
  for (const h of shownHabits) {
    const list = byDim.get(h.dimension) ?? [];
    list.push(h);
    byDim.set(h.dimension, list);
  }

  return (
    <div className="page">
      <section className="panel">
        <div className="row between">
          <h2>各科目进度</h2>
          <span className="meta">共 {overview.length} 门课</span>
        </div>
        <p className="hint">
          每门课各自的进度，<b>不合并成一个总进度</b>——物理的第 5 章和数据结构的第 5 章不是一回事。
          点卡片切换当前科目。这里只列<b>已勾选「允许 AI 辅助」</b>的科目，可在「科目」页调整。
        </p>
        {overview.length === 0 && (
          <p className="hint">
            还没有勾选允许 AI 辅助的课程。去「科目」页勾选后，进度卡片才会出现。
          </p>
        )}
        <div className="subjgrid">
          {overview.map((s) => (
            <button
              type="button"
              key={s.code}
              className={`subjcard${s.code === course ? " cur" : ""}`}
              onClick={() => {
                if (s.code !== course) onPickCourse(s.code);
              }}
            >
              <header>
                <b>{s.name}</b>
                <span className="tag subj">{s.code}</span>
                {!s.textbook_ready && <span className="tag">待建库</span>}
              </header>
              <p className="meta">
                已学 <b>{s.progress.learnedCount}</b> 章
                {s.progress.maxChapterNo != null
                  ? ` · 当前第 ${s.progress.maxChapterNo} 章`
                  : " · 尚未设进度"}
              </p>
              <p className="meta">
                错题 {s.mistakes.total}（未掌握 {s.mistakes.unresolved}） · 习惯 {s.habits}
              </p>
              {s.progress?.gaps && s.progress.gaps.length > 0 && (
                <p className="meta warn">⚠ 跳过未学：第 {s.progress.gaps.join("、")} 章</p>
              )}
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="row between">
          <h2>我的进度</h2>
          <span className="row">
            <span className="meta">
              {data.maxChapterNo != null ? `已学到第 ${data.maxChapterNo} 章` : "尚未设置"}
            </span>
            <button
              type="button"
              className={renameMode ? "on" : ""}
              onClick={() => {
                setRenameMode((v) => !v);
                setEditingNo(null);
              }}
            >
              {renameMode ? "退出改名" : "重命名章节"}
            </button>
          </span>
        </div>
        <p className="hint">
          {renameMode
            ? "点任意章节打开改名框。改成你习惯的叫法（如「静电场与电势」），模型判断是否超纲时会按这个名字对齐。"
            : "点章节即把进度推进到该章（前面的章节标为已学完，该章标为在学）。"}
          这里<b>只显示教材库里真实存在的章节</b>，查不到的章不会出现。
          <b>模型只会用已学范围里的方法解题</b>；必须用到后面章节时，会明确告诉你「你还没学」。
        </p>

        {data.gaps && data.gaps.length > 0 && (
          <div className="alert">
            ⚠ 中间有跳过：第 {data.gaps.join("、")} 章没确认学过。模型会把它们当<b>没学</b>——
            检索时这些章节的正文不会进上下文，讲授也不会默认你会。
          </div>
        )}

        <div className="chapgrid">
          {chapters.map((c) => {
            const n = c.chapter_no;
            const s = c.status;
            const isCurrent = data.maxChapterNo === n;
            return (
              <button
                type="button"
                key={n}
                className={`chap st-${s}${isCurrent ? " cur" : ""}`}
                onClick={() => (renameMode ? startRename(c) : void advance(n))}
                disabled={busy}
                title={
                  renameMode
                    ? `改第 ${n} 章的名称`
                    : isCurrent
                      ? "当前正在学"
                      : `设进度为第 ${n} 章`
                }
              >
                <b>{n}</b>
                <i className="chapname" title={c.chapter_title}>
                  {c.chapter_title}
                  {c.edited ? "（自定义）" : ""}
                </i>
                <span>
                  {renameMode
                    ? "改名"
                    : s === "done"
                      ? "已学完"
                      : s === "learning"
                        ? "在学"
                        : "未学"}
                </span>
              </button>
            );
          })}
        </div>

        {chapters.length === 0 && (
          <p className="hint">
            这门课的教材库没有识别出章节号（可能只切了片），所以无法按章记录进度。 重新跑{" "}
            <code>npm run build:course</code> 或检查教材/课件里有没有「第N章」「§N.M」标记。
          </p>
        )}

        {editingNo != null && (
          <div className="row wrap renamebox">
            <b>第 {editingNo} 章</b>
            <input
              type="text"
              value={editTitle}
              maxLength={60}
              placeholder={editLibraryTitle || "如：静电场"}
              style={{ width: 260 }}
              onChange={(e) => setEditTitle(e.target.value)}
            />
            <button
              type="button"
              className="primary"
              disabled={busy || !editTitle.trim()}
              onClick={() => void saveRename()}
            >
              保存
            </button>
            <button type="button" disabled={busy} onClick={() => setEditingNo(null)}>
              取消
            </button>
            {editLibraryTitle && (
              <button type="button" disabled={busy} onClick={() => void restoreName()}>
                恢复原名（{editLibraryTitle}）
              </button>
            )}
          </div>
        )}

        <div className="row">
          <button type="button" className="danger" onClick={() => void reset()} disabled={busy}>
            清空进度
          </button>
          {busy && <span className="meta">写入中…</span>}
        </div>
        {err && <div className="alert errbox">{err}</div>}
      </section>

      <section className="panel">
        <div className="row between">
          <h2>学习习惯</h2>
          <span className="meta">
            {injectCount} / {shownHabits.length} 条达标并注入画像
          </span>
        </div>

        {hstatus && (
          <p className="hint">
            抽取队列：{hstatus.running ? "正在抽取" : "空闲"}
            {hstatus.pending > 0 ? `，排队 ${hstatus.pending} 条` : ""}
            {` · 已处理 ${hstatus.processed} 次`}
            {hstatus.failed > 0
              ? ` · 失败 ${hstatus.failed} 次${hstatus.lastError ? `（${hstatus.lastError}）` : ""}`
              : ""}
            {hstatus.lastAt ? ` · 最近 ${hstatus.lastAt}` : ""}
          </p>
        )}

        {hstatus && hstatus.runs.length > 0 && (
          <details className="runs">
            <summary className="meta">
              最近 {hstatus.runs.length} 次抽取记录（看清为什么还没结论）
            </summary>
            <ul className="list">
              {hstatus.runs.map((r) => (
                <li key={r.id}>
                  <span className="name">{r.sourceType}</span>
                  <span className="meta">
                    {r.error
                      ? `失败：${r.error}`
                      : r.candidates > 0
                        ? `候选 ${r.candidates} 条${r.enough ? "" : "（模型自评：证据偏弱）"}`
                        : "0 条候选（模型认为这段材料看不出稳定习惯）"}
                    {r.ts ? ` · ${r.ts.slice(5, 16)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}

        {shownHabits.length === 0 ? (
          <p className="hint">
            {hstatus && hstatus.processed > 0
              ? `抽取已经跑过 ${hstatus.processed} 次，但每次都判定「看不出稳定偏好」——不是没在记，是材料还不足以支持结论。`
              : "还没有记录。"}
            习惯来自你的每一次操作：解题/批改的原文、改错照片、代码片段、错题重做、日程与进度调整。
            每条都带证据条数（括号里的数字），可以追问「你凭什么这么说我」。
            <b>证据不足 2 条的习惯只展示、不注入画像</b>。
          </p>
        ) : (
          <div className="habits">
            {[...byDim.entries()].map(([dim, rows]) => (
              <div className="hrow" key={dim}>
                <span className="hdim">{DIM_LABEL[dim] ?? dim}</span>
                <span className="hit">
                  {rows.map((r) => (
                    <i key={`${r.key}-${r.course_code ?? ""}`}>
                      {editHabit === r.id ? (
                        <>
                          <input
                            value={editKey}
                            onChange={(e) => setEditKey(e.target.value)}
                            placeholder="key"
                            style={{ width: 110 }}
                          />
                          {" → "}
                          <input
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            placeholder="value"
                            style={{ width: 150 }}
                          />
                          <button
                            type="button"
                            className="chip"
                            disabled={busy || !editKey.trim() || !editValue.trim()}
                            onClick={() => void saveEditHabit()}
                          >
                            保存
                          </button>
                          <button type="button" className="chip" onClick={() => setEditHabit(null)}>
                            取消
                          </button>
                        </>
                      ) : (
                        <>
                          {r.key} → <b>{r.value}</b>
                          <em>({r.evidence_count})</em>
                          {r.injectable === false && <em className="warn"> 证据不足，暂不注入</em>}
                          {r.source === "manual" && (
                            <>
                              <button
                                type="button"
                                className="chip"
                                onClick={() => startEditHabit(r)}
                              >
                                修改
                              </button>
                              <button
                                type="button"
                                className="chip"
                                onClick={() => void removeHabit(r)}
                              >
                                删除
                              </button>
                            </>
                          )}
                        </>
                      )}
                    </i>
                  ))}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>时段偏好（这个点我不想学）</h2>
        <p className="hint">
          比如午休 12:00-13:30。保存后两件事同时生效：
          <b>排期提示词里会明确列出这段不能排</b>，代码校验也会把排进去的块拒收——
          不再只是「建议别排」。
        </p>

        <div className="row wrap">
          <label className="inline">
            <span>从</span>
            <select
              value={pref.weekdayFrom}
              onChange={(e) => setPref({ ...pref, weekdayFrom: Number(e.target.value) })}
            >
              {WD.map((d, i) => (
                <option key={d} value={i + 1}>
                  周{d}
                </option>
              ))}
            </select>
          </label>
          <label className="inline">
            <span>到</span>
            <select
              value={pref.weekdayTo}
              onChange={(e) => setPref({ ...pref, weekdayTo: Number(e.target.value) })}
            >
              {WD.map((d, i) => (
                <option key={d} value={i + 1}>
                  周{d}
                </option>
              ))}
            </select>
          </label>
          <label className="inline">
            <span>时间</span>
            <input
              type="time"
              value={pref.start}
              onChange={(e) => setPref({ ...pref, start: e.target.value })}
            />
            <span>–</span>
            <input
              type="time"
              value={pref.end}
              onChange={(e) => setPref({ ...pref, end: e.target.value })}
            />
          </label>
          <select
            value={pref.mode}
            onChange={(e) => setPref({ ...pref, mode: e.target.value as "avoid" | "prefer" })}
          >
            <option value="avoid">不想学</option>
            <option value="prefer">适合学</option>
          </select>
          <input
            type="text"
            placeholder="原因（如 午休）"
            value={pref.reason}
            onChange={(e) => setPref({ ...pref, reason: e.target.value })}
          />
          <button type="button" className="primary" onClick={() => void addPref()} disabled={busy}>
            添加
          </button>
        </div>

        {(data.preferences ?? []).length === 0 ? (
          <p className="hint">还没有设置。没设的话，午休时段会被当成空档，模型可以往里排学习块。</p>
        ) : (
          <ul className="list">
            {(data.preferences ?? []).map((p) => (
              <li key={p.id ?? `${p.weekday_from}-${p.start_time}-${p.mode}`}>
                <span className={p.mode === "avoid" ? "dot cat-work" : "dot cat-life"} />
                <span className="name">
                  周{WD[p.weekday_from - 1]}
                  {p.weekday_to !== p.weekday_from ? `~周${WD[p.weekday_to - 1]}` : ""}{" "}
                  {p.start_time ? `${p.start_time}-${p.end_time ?? "24:00"}` : "全天"}
                </span>
                <span className="meta">
                  {p.mode === "avoid" ? "不想学" : "适合学"}
                  {p.reason ? ` · ${p.reason}` : ""}
                </span>
                {p.id != null && (
                  <button type="button" className="link" onClick={() => void removePref(p.id!)}>
                    删除
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <div className="row between">
          <h2>模型实际看到的画像</h2>
          <button type="button" onClick={() => setShowPrompt((v) => !v)}>
            {showPrompt ? "收起" : "展开原文"}
          </button>
        </div>
        <p className="hint">
          每次提问都会把这段原文注入模型。你可以核对它对你的判断准不准——不准就直说。
        </p>
        {showPrompt && <pre className="promptbox">{prompt}</pre>}
      </section>
    </div>
  );
}
