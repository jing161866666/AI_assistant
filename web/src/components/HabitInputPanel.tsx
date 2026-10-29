import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import type { CourseResource, InvestmentSubject, ManualHabit, StudyWindow } from "../types.ts";

/**
 * 「我的学习习惯」—— 用户自己填，不靠模型猜。
 *
 * 三种东西，对应需求里的三类输入：
 *   1. 偏好时段（study_window）：8:00-9:00 写代码 → 排期优先放这个时间
 *   2. 学习方式/投入占比（learn_method / investment）：哪门课要多投入、怎么学
 *   3. 在用的网课/教辅（resource）：本地有就直接用，没有就标"缺"，走上传
 *
 * 作用域：这里默认写「个人共用习惯」（所有科目通用）。
 * 只有错题本 / 举一反三 / 进度三个界面才允许绑定到某一科。
 */

const DIM_OPTIONS: Array<{ value: string; label: string; hint: string }> = [
  {
    value: "study_window",
    label: "偏好时段",
    hint: "key 写 20:00-22:00，value 写这段时间想做什么",
  },
  { value: "learn_method", label: "学习方式", hint: "如：先看网课再做题 / 只看参考书" },
  {
    value: "investment",
    label: "课下投入占比",
    hint: "如 key=数据结构 value=0.4（0-1，用来避开水课）",
  },
  { value: "attention", label: "单次专注时长", hint: "如 key=单次 value=45 分钟" },
  { value: "planning", label: "计划习惯", hint: "如 key=每日 value=先做难的" },
];

const KIND_OPTIONS = [
  { value: "netcourse", label: "网课" },
  { value: "guidebook", label: "教辅书" },
  { value: "textbook", label: "教材" },
  { value: "other", label: "其它" },
];

export default function HabitInputPanel({
  subjects,
  onChanged,
}: {
  /** 可选科目清单（来自科目注册表），只用来给习惯/资源选作用域 */
  subjects: Array<{ code: string; name: string }>;
  onChanged: () => void;
}) {
  const [habits, setHabits] = useState<ManualHabit[]>([]);
  const [windows, setWindows] = useState<StudyWindow[]>([]);
  const [resources, setResources] = useState<CourseResource[]>([]);
  const [missing, setMissing] = useState<CourseResource[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  /**
   * 作用域：'' = 个人共用（所有科目通用）。
   * 这是本面板自己的选择，跟「我的进度」页当前在看哪科无关——
   * 否则在进度页切个科目，习惯就被悄悄绑到那一科上了。
   */
  const [scope, setScope] = useState("");

  const [dim, setDim] = useState("study_window");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  /** 正在修改的那条自述习惯；null = 新增 */
  const [editingId, setEditingId] = useState<number | null>(null);

  const [rKind, setRKind] = useState("netcourse");
  const [rTitle, setRTitle] = useState("");
  const [rUrl, setRUrl] = useState("");
  const [rStatus, setRStatus] = useState("available");

  /** 投入占比：每门课一个 0-100 的数（0 = 水课，排期不给它分时间） */
  const [invest, setInvest] = useState<InvestmentSubject[]>([]);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [h, w, r, inv] = await Promise.all([
        api.manualHabits(scope || undefined),
        api.studyWindows(scope || undefined),
        api.resources(scope || undefined),
        api.investments(),
      ]);
      setHabits(h.habits);
      setWindows(w.windows);
      setResources(r.resources);
      setMissing(r.missing);
      setInvest(inv.subjects);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [scope]);

  useEffect(() => {
    void load();
  }, [load]);

  const setWeight = async (code: string, percent: number): Promise<void> => {
    setErr(null);
    setMsg(null);
    try {
      const r = await api.setInvestment(code, percent);
      setMsg(r.message);
      setInvest((prev) =>
        prev.map((s) =>
          s.code.toUpperCase() === code.toUpperCase() ? { ...s, weight: r.weight } : s,
        ),
      );
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const addHabit = async (): Promise<void> => {
    setErr(null);
    setMsg(null);
    try {
      if (editingId != null) {
        const r = await api.updateManualHabit(editingId, {
          dimension: dim,
          key,
          value,
          course: scope || null,
        });
        setMsg(r.message);
        setEditingId(null);
      } else {
        const r = await api.saveManualHabit({
          dimension: dim,
          key,
          value,
          course: scope || undefined,
        });
        setMsg(`${r.message}（作用域：${r.scope}）`);
      }
      setKey("");
      setValue("");
      await load();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  /** 点「修改」：把这一条的内容填回表单，改完按 id 更新而不是新增 */
  const startEdit = (h: ManualHabit): void => {
    setEditingId(h.id);
    setDim(h.dimension);
    setKey(h.key);
    setValue(h.value);
    setScope(h.course_code ?? "");
    setErr(null);
    setMsg(null);
  };

  const cancelEdit = (): void => {
    setEditingId(null);
    setKey("");
    setValue("");
  };

  const addResource = async (): Promise<void> => {
    setErr(null);
    setMsg(null);
    try {
      const r = await api.saveResource({
        course: scope || undefined,
        kind: rKind,
        title: rTitle,
        url: rUrl || undefined,
        local_status: rStatus,
      });
      setMsg(r.message);
      setRTitle("");
      setRUrl("");
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const hint = DIM_OPTIONS.find((d) => d.value === dim)?.hint ?? "";

  return (
    <section className="panel">
      <div className="row between">
        <h2>我的学习习惯（自己填）</h2>
        <span className="meta">
          共用 {habits.filter((h) => !h.course_code).length} 条 · 本学科{" "}
          {habits.filter((h) => h.course_code).length} 条
        </span>
      </div>
      <p className="hint">
        你写的一条 <b>一条就生效</b>（不用等模型观察很多次）。下面这个科目选择
        <b>只决定"这条习惯属于谁"</b>， 和「我的进度」页当前在看哪一科无关：选「个人共用」=
        所有科目通用； 选某门课 = 只在那门课的错题/举一反三/进度里生效，并跟该课进度存在一起。
      </p>

      <div className="row">
        <label className="meta">
          作用域：
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">个人共用（所有科目）</option>
            {subjects.map((s) => (
              <option key={s.code} value={s.code}>
                仅 {s.name}（{s.code}）
              </option>
            ))}
          </select>
        </label>
      </div>

      {err && <div className="alert errbox">{err}</div>}
      {msg && <div className="alert">{msg}</div>}

      <div className="row">
        <select value={dim} onChange={(e) => setDim(e.target.value)}>
          {DIM_OPTIONS.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={dim === "study_window" ? "20:00-22:00" : "名称 / 键"}
        />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={dim === "study_window" ? "这段时间想做什么" : "具体偏好"}
        />
        <button
          type="button"
          className="primary"
          onClick={() => void addHabit()}
          disabled={!key || !value}
        >
          {editingId == null ? "记下来" : "保存修改"}
        </button>
        {editingId != null && (
          <button type="button" onClick={cancelEdit}>
            取消修改
          </button>
        )}
      </div>
      <p className="meta">{hint}</p>

      <h3>课下投入占比（时间怎么分）</h3>
      <p className="hint">
        排期按这个比例把每天的学习时间分给各科；<b>0% = 水课</b>，一块都不排。
        没设过的课按"和其他课一样"处理。
      </p>
      {invest.length === 0 ? (
        <p className="hint">还没有登记科目。先在「科目」页添加，或导入课表。</p>
      ) : (
        <ul className="mdlist">
          {invest.map((s) => {
            const pct = s.weight == null ? "" : String(Math.round(s.weight * 100));
            return (
              <li key={s.code}>
                <b>{s.name}</b>
                <span className="meta">
                  {" "}
                  · {s.code}
                  {s.textbook_ready ? "" : " · 无教材库"}
                </span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={10}
                  value={pct}
                  placeholder="未设"
                  style={{ width: 70, marginLeft: 8 }}
                  onChange={(e) => {
                    const v = e.target.value;
                    setInvest((prev) =>
                      prev.map((x) =>
                        x.code === s.code ? { ...x, weight: v === "" ? null : Number(v) / 100 } : x,
                      ),
                    );
                  }}
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) void setWeight(s.code, v);
                  }}
                />
                <span className="meta"> %</span>
                <button type="button" className="chip" onClick={() => void setWeight(s.code, 0)}>
                  水课（0%）
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {windows.filter((w) => w.start && w.end).length > 0 && (
        <>
          <h3>排期会优先用的时段</h3>
          <ul className="mdlist">
            {windows
              .filter((w) => w.start && w.end)
              .map((w) => (
                <li key={w.id}>
                  <b>
                    {w.start}-{w.end}
                  </b>{" "}
                  → {w.what}
                  {w.course_code ? `（仅 ${w.course_code}）` : "（共用）"}
                  {w.source === "manual" ? " · 你填的" : " · 模型观察到的"}
                </li>
              ))}
          </ul>
        </>
      )}

      <h3>在用的网课 / 教辅</h3>
      <p className="hint">
        本地或线上已有的直接用；没有的标「缺」，之后按上传流程补（功能已预留）。
      </p>
      <div className="row">
        <select value={rKind} onChange={(e) => setRKind(e.target.value)}>
          {KIND_OPTIONS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        <input
          value={rTitle}
          onChange={(e) => setRTitle(e.target.value)}
          placeholder="名称，如 CS50 / 王道数据结构"
        />
        <input
          value={rUrl}
          onChange={(e) => setRUrl(e.target.value)}
          placeholder="链接（可留空）"
        />
        <select value={rStatus} onChange={(e) => setRStatus(e.target.value)}>
          <option value="available">已有</option>
          <option value="missing">缺，待上传</option>
          <option value="unknown">不确定</option>
        </select>
        <button type="button" onClick={() => void addResource()} disabled={!rTitle}>
          添加资源
        </button>
      </div>

      {resources.length > 0 && (
        <ul className="mdlist">
          {resources.map((r) => (
            <li key={r.id}>
              <b>{r.title}</b>
              <span className="meta">
                {" "}
                · {r.kind} · {r.local_status === "missing" ? "缺，待上传" : r.local_status}
                {r.progress != null ? ` · 进度 ${Math.round(r.progress * 100)}%` : ""}
                {r.course_code ? ` · ${r.course_code}` : " · 通识"}
              </span>
            </li>
          ))}
        </ul>
      )}

      {missing.length > 0 && (
        <div className="alert">
          有 {missing.length} 份资源还没有本地文件：{missing.map((m) => m.title).join("、")}。
          讲解涉及它们时，模型会说明「资料还没上传」，不会凭空编内容。
        </div>
      )}

      {habits.length > 0 && (
        <>
          <h3>已记录</h3>
          <ul className="mdlist">
            {habits.map((h) => (
              <li key={h.id}>
                <b>{h.dimension}</b>：{h.key} → {h.value}
                <span className="meta"> {h.course_code ? `· ${h.course_code}` : "· 共用"}</span>
                <button type="button" className="chip" onClick={() => startEdit(h)}>
                  修改
                </button>
                <button
                  type="button"
                  className="chip"
                  onClick={() => {
                    if (!window.confirm(`删除这条自述习惯？\n${h.key} → ${h.value}`)) return;
                    void api.deleteManualHabit(h.id).then(load);
                  }}
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
