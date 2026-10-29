import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import type { CourseMatchRow } from "../types.ts";

/**
 * 课表课名 → 教材库 的匹配面板。
 *
 * 三档来源一眼看清：
 *   exact / short（简称逐字可验）→ 直接用，只标注，不用你操心
 *   alias（你确认过的别名）→ 直接用
 *   model（模型猜的）→ 必须你点「确认」，点过之后永久生效
 *
 * 为什么模型结果必须确认：这一步决定后面用哪本书答题，
 * 猜错会一路错下去而且看不出来（例如把「大学物理(B)II」配到「大学物理实验」）。
 */
const TIER_LABEL: Record<string, string> = {
  exact: "名称一致",
  alias: "已确认别名",
  short: "简称可验",
  model: "模型猜测",
  none: "未匹配",
};

const TIER_CLS: Record<string, string> = {
  exact: "v-ok",
  alias: "v-ok",
  short: "v-ok",
  model: "v-part",
  none: "v-bad",
};

export default function CourseMatchPanel({ onChanged }: { onChanged: () => void }) {
  const [rows, setRows] = useState<CourseMatchRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [withModel, setWithModel] = useState(true);

  const load = useCallback(async (model: boolean): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.subjectMatches(model);
      setRows(r.courses);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  const decide = async (row: CourseMatchRow, accepted: boolean): Promise<void> => {
    if (!row.code) return;
    setMsg(null);
    setErr(null);
    try {
      const r = await api.confirmAlias(row.name, row.code, accepted);
      setMsg(r.message);
      onChanged();
      await load(withModel);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const pending = rows.filter((r) => r.needs_confirm).length;

  return (
    <section className="panel">
      <div className="row between">
        <h2>课表课名 → 教材库</h2>
        <span className="meta">
          {busy ? "匹配中…" : `${rows.length} 门课`}
          {pending > 0 ? ` · ${pending} 条待确认` : ""}
        </span>
      </div>
      <p className="hint">
        课表里写的是<b>官方课名</b>，你的教材库文件夹可能叫「大物下」「工数」这种简称。
        简称能逐字对上的（大物下→大学物理下、工数→工科数学分析）自动认；
        对不上的（CPP→编程语言基础）由模型猜，<b>但必须你点确认才会当依据用</b>。
      </p>

      <div className="row">
        <label className="meta">
          <input
            type="checkbox"
            checked={withModel}
            onChange={(e) => {
              setWithModel(e.target.checked);
              void load(e.target.checked);
            }}
          />{" "}
          让模型补猜（关掉只看已确认的映射）
        </label>
        <button type="button" onClick={() => void load(withModel)} disabled={busy}>
          重新匹配
        </button>
      </div>

      {err && <div className="alert errbox">{err}</div>}
      {msg && <div className="alert">{msg}</div>}

      {rows.length === 0 ? (
        <p className="hint">课程表里还没有课程。先在「首次设置」里导入课表。</p>
      ) : (
        <ul className="mdlist">
          {rows.map((r) => (
            <li key={r.name}>
              <span className={`verdict ${TIER_CLS[r.tier] ?? ""}`}>
                {TIER_LABEL[r.tier] ?? r.tier}
              </span>{" "}
              <b>{r.name}</b>
              {r.library ? (
                <>
                  {" → "}
                  <b>{r.library.name}</b>{" "}
                  <span className="meta">
                    ({r.library.code} · {r.library.chunks} 片 / {r.library.chapters} 章 ·{" "}
                    {r.library.chapter_nos === 0 ? "仅正文 L3" : "章级 L2"})
                  </span>
                </>
              ) : (
                <span className="meta"> → 没有可用的教材库</span>
              )}
              <div className="meta">
                {r.reason}
                {r.confidence > 0 ? ` · 把握 ${(r.confidence * 100).toFixed(0)}%` : ""}
                {r.ai_enabled ? " · 已允许 AI 辅助" : ""}
              </div>
              {r.needs_confirm && r.code && (
                <div className="row">
                  <button type="button" className="primary" onClick={() => void decide(r, true)}>
                    就用这个（{r.code}）
                  </button>
                  <button type="button" onClick={() => void decide(r, false)}>
                    不对
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
