import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import type { Mistake, MistakeStats } from "../types.ts";
import { ERROR_LABEL } from "../types.ts";

export default function Mistakes() {
  const [list, setList] = useState<Mistake[]>([]);
  const [stats, setStats] = useState<MistakeStats | null>(null);
  const [filter, setFilter] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.mistakes();
      setList(r.mistakes);
      setStats(r.stats);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

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

  return (
    <div className="page">
      <section className="panel">
        <div className="row between">
          <h2>错题本</h2>
          <button type="button" onClick={() => void load()} disabled={busy}>
            刷新
          </button>
        </div>

        {stats && (
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
        )}

        {stats && stats.byErrorType.length > 0 && (
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

        {err && <div className="alert errbox">{err}</div>}
        {!busy && shown.length === 0 && (
          <p className="hint">
            还没有错题。去「改错」页贴一道做错的题，批改后点「存入错题本」就会出现在这里。
          </p>
        )}

        <div className="mistakes">
          {shown.map((m) => {
            const kps = safeJson(m.kp_codes);
            const expanded = open === m.id;
            return (
              <article className={`mk${m.resolved ? " done" : ""}`} key={m.id}>
                <header>
                  <span className={`tag et-${m.error_type ?? "unknown"}`}>
                    {ERROR_LABEL[m.error_type ?? "unknown"] ?? m.error_type}
                  </span>
                  {m.resolved === 1 && <span className="tag ok">已掌握</span>}
                  <span className="mkdate">{m.saved_at.slice(0, 16)}</span>
                  <button
                    type="button"
                    className="link"
                    onClick={() => setOpen(expanded ? null : m.id)}
                  >
                    {expanded ? "收起" : "展开"}
                  </button>
                </header>
                <p className="mkq">{m.title}</p>
                {m.error_detail && <p className="mkcause">错因：{m.error_detail}</p>}

                {expanded && (
                  <div className="mkbody">
                    {m.my_answer && (
                      <>
                        <h4>我的答案</h4>
                        <pre>{m.my_answer}</pre>
                      </>
                    )}
                    {m.correct_answer && (
                      <>
                        <h4>正确解法</h4>
                        <pre>{m.correct_answer}</pre>
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
          })}
        </div>
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
