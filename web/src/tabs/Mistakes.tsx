import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import MathText from "../components/MathText.tsx";
import { fileToDataUrl } from "../img.ts";
import type { Mistake, MistakeGroup, MistakeStats } from "../types.ts";
import { ERROR_LABEL } from "../types.ts";

/**
 * 错题本。
 *
 * 两种视图：
 *   - 当前科目（默认）：统计与列表同口径，日常改错用；
 *   - 全部科目：按科目归类，每科一组，没有科目的旧记录会单独成组。
 * 切换科目不影响已保存的错题——它们本来就按 course_code 分开放。
 */
export default function Mistakes({ course }: { course?: string }) {
  const [mode, setMode] = useState<"course" | "all">("course");
  const [list, setList] = useState<Mistake[]>([]);
  const [groups, setGroups] = useState<MistakeGroup[]>([]);
  const [stats, setStats] = useState<MistakeStats | null>(null);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  /** 正在补传截图的错题 id（只影响那一张卡片） */
  const [upId, setUpId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      if (mode === "all") {
        const r = await api.mistakeGroups();
        setGroups(r.groups);
        setTotal(r.total);
        setStats(null);
      } else {
        // 只取当前科目的错题：统计与列表必须同口径，否则数字对不上
        const r = await api.mistakes(course);
        setList(r.mistakes);
        setStats(r.stats);
        setGroups([]);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [course, mode]);

  useEffect(() => {
    void load();
  }, [load]);

  const retry = async (id: number, correct: boolean): Promise<void> => {
    try {
      await api.attempt(id, correct);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const remove = async (id: number): Promise<void> => {
    try {
      await api.deleteMistake(id);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const shown = filter ? list.filter((m) => (m.error_type ?? "unknown") === filter) : list;

  /** 补传截图：旧错题保存时没存原图，用户手里还有图就能补回来 */
  const attach = async (id: number, file: File): Promise<void> => {
    setUpId(id);
    setErr(null);
    try {
      const dataUrl = await fileToDataUrl(file);
      await api.attachMistakeImage(id, dataUrl);
      await load();
    } catch (e) {
      setErr(`补传截图失败：${(e as Error).message}`);
    } finally {
      setUpId(null);
    }
  };

  const card = (m: Mistake) => {
    const kps = safeJson(m.kp_codes);
    const expanded = open === m.id;
    /** 题干：旧截图题只有转录文字，标题是占位的「图片题」，这时用 raw_text 展示 */
    const raw = m.raw_text?.trim() ?? "";
    const stem = raw && raw !== m.title ? raw : null;
    return (
      <article className={`mk${m.resolved ? " done" : ""}`} key={m.id}>
        <header>
          {m.course_code && <span className="tag subj">{m.course_code}</span>}
          <span className={`tag et-${m.error_type ?? "unknown"}`}>
            {ERROR_LABEL[m.error_type ?? "unknown"] ?? m.error_type}
          </span>
          {m.resolved === 1 && <span className="tag ok">已掌握</span>}
          <span className="mkdate">{m.saved_at.slice(0, 16)}</span>
          <button type="button" className="link" onClick={() => setOpen(expanded ? null : m.id)}>
            {expanded ? "收起" : "展开"}
          </button>
        </header>
        {m.artifact_id ? (
          // 用户给的是截图：优先显示原图，标题退为说明文字。
          // 转录文字只用来校对/检索，不替代用户自己的图。
          <a
            className="mkimgwrap"
            href={`/api/mistakes/${m.id}/image`}
            target="_blank"
            rel="noreferrer"
            title="点开看原图"
          >
            <img
              className="mkimg"
              src={`/api/mistakes/${m.id}/image`}
              alt="题目截图"
              loading="lazy"
            />
          </a>
        ) : null}
        {m.artifact_id ? (
          <p className="mkq mkcaption">
            {`截图原题${m.title && m.title !== "图片题" ? `：${m.title}` : ""}`}
          </p>
        ) : expanded && stem ? (
          // 没有原图时，至少把题干完整展示出来（截图题的转录文字就在这里）
          <>
            <h4 className="mkstem">题目</h4>
            <MathText text={stem} />
          </>
        ) : (
          <p className="mkq">{m.title}</p>
        )}
        {!m.artifact_id && !expanded && stem && (
          <p className="mkq">{m.title === "图片题" ? "截图题（展开看题干）" : m.title}</p>
        )}
        {!m.artifact_id && (m.source === "photo" || m.title === "图片题") && (
          <p className="mknoimg">
            这张错题是旧版本保存的，没有存原图；可以在下面「补传截图」补回来。
          </p>
        )}
        {m.error_detail && <p className="mkcause">错因：{m.error_detail}</p>}

        {expanded && (
          <div className="mkbody">
            {m.my_answer && (
              <>
                <h4>我的答案</h4>
                <MathText text={m.my_answer} />
              </>
            )}
            {m.correct_answer && (
              <>
                <h4>正确解法</h4>
                <MathText text={m.correct_answer} />
              </>
            )}
            {kps.length > 0 && (
              <div className="chips">
                {kps.map((k) => (
                  <span className="chip static" key={k}>
                    {k}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <footer>
          <span className="meta">
            重做 {m.attempts} 次
            {m.last_attempt_at ? ` · 最近 ${m.last_attempt_at.slice(0, 16)}` : ""}
          </span>
          <span className="acts">
            <label className="link mkupload" title="把截图挂到这条错题上（之后优先显示原图）">
              {upId === m.id ? "上传中…" : m.artifact_id ? "换图" : "补传截图"}
              <input
                type="file"
                accept="image/*"
                hidden
                disabled={upId === m.id}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void attach(m.id, f);
                }}
              />
            </label>
            <button type="button" onClick={() => void retry(m.id, true)}>
              重做对了
            </button>
            <button type="button" onClick={() => void retry(m.id, false)}>
              还是错
            </button>
            <button type="button" className="danger" onClick={() => void remove(m.id)}>
              删除
            </button>
          </span>
        </footer>
      </article>
    );
  };

  return (
    <div className="page">
      <section className="panel">
        <div className="row between">
          <h2>错题本{mode === "course" && course ? ` · ${course}` : " · 全部科目"}</h2>
          <span className="row">
            <button
              type="button"
              className={mode === "course" ? "on" : ""}
              onClick={() => setMode("course")}
            >
              当前科目
            </button>
            <button
              type="button"
              className={mode === "all" ? "on" : ""}
              onClick={() => setMode("all")}
            >
              全部科目
            </button>
            <button type="button" onClick={() => void load()} disabled={busy}>
              刷新
            </button>
          </span>
        </div>

        {mode === "course" && stats && (
          <>
            <div className="stats">
              <div className="stat">
                <b>{stats.total}</b>
                <span>总错题</span>
              </div>
              <div className="stat">
                <b>{stats.unresolved}</b>
                <span>未掌握</span>
              </div>
              {stats.byErrorType.slice(0, 4).map((t) => (
                <div className="stat" key={t.error_type}>
                  <b>{t.n}</b>
                  <span>{ERROR_LABEL[t.error_type] ?? t.error_type}</span>
                </div>
              ))}
            </div>

            {stats.byErrorType.length > 0 && (
              <div className="chips">
                <button
                  type="button"
                  className={`chip${filter === "" ? " on" : ""}`}
                  onClick={() => setFilter("")}
                >
                  全部
                </button>
                {stats.byErrorType.map((t) => (
                  <button
                    type="button"
                    key={t.error_type}
                    className={`chip${filter === t.error_type ? " on" : ""}`}
                    onClick={() => setFilter(t.error_type)}
                  >
                    {ERROR_LABEL[t.error_type] ?? t.error_type} {t.n}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {mode === "all" && (
          <p className="hint">
            按科目归类显示，共 <b>{total}</b> 条。<b>只列已勾选「允许 AI 辅助」的科目</b>
            （可在「科目」页调整）；没有科目的旧记录单独成组，不会丢。
          </p>
        )}

        {err && <div className="alert errbox">{err}</div>}
        {!busy && mode === "course" && shown.length === 0 && (
          <p className="hint">
            这门课还没有错题。去「改错」页贴一道做错的题，批改后点「存入错题本」就会出现在这里。
          </p>
        )}
        {!busy && mode === "all" && groups.length === 0 && (
          <p className="hint">还没有任何错题。改错后点「存入错题本」，会按科目自动归类。</p>
        )}

        {mode === "course" ? (
          <div className="mistakes">{shown.map(card)}</div>
        ) : (
          <div className="mistakegroups">
            {groups.map((g) => (
              <section className="mkgroup" key={g.course_code ?? "__none__"}>
                <div className="row between">
                  <h3>
                    {g.course_name}
                    {g.course_code && <span className="tag subj">{g.course_code}</span>}
                  </h3>
                  <span className="meta">
                    {g.stats.total} 条 · 未掌握 {g.stats.unresolved}
                  </span>
                </div>
                <div className="mistakes">{g.mistakes.map(card)}</div>
              </section>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function safeJson(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
