import { useCallback, useEffect, useState } from "react";

interface Chapter {
  chapter_no: number;
  chapter_title: string | null;
  status: string;
}

interface Habit {
  dimension: string;
  key: string;
  value: string;
  course_code: string | null;
  confidence: number;
  evidence_count: number;
}

interface ProgressData {
  maxChapterNo: number | null;
  learned: number[];
  chapters: Chapter[];
  habits: Habit[];
  preferences: Array<{
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

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...init });
  const j = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(j.error ?? `${res.status}`);
  return j;
}

export default function Progress() {
  const [data, setData] = useState<ProgressData | null>(null);
  const [prompt, setPrompt] = useState<string>("");
  const [showPrompt, setShowPrompt] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [maxCh, setMaxCh] = useState(18);

  const load = useCallback(async () => {
    try {
      const d = await api<ProgressData>("/api/progress");
      setData(d);
      const p = await api<{ prompt: string }>("/api/profile/prompt");
      setPrompt(p.prompt);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const advance = async (n: number): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const d = await api<ProgressData>("/api/progress/advance", {
        method: "POST",
        body: JSON.stringify({ chapterNo: n }),
      });
      setData(d);
      const p = await api<{ prompt: string }>("/api/profile/prompt");
      setPrompt(p.prompt);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reset = async (): Promise<void> => {
    setBusy(true);
    try {
      const d = await api<ProgressData>("/api/progress", {
        method: "POST",
        body: JSON.stringify({ chapterNo: 1, status: "not_started" }),
      });
      // 逐章清空
      for (let n = 1; n <= maxCh; n++) {
        await api("/api/progress", {
          method: "POST",
          body: JSON.stringify({ chapterNo: n, status: "not_started" }),
        });
      }
      setData(d);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <div className="center">{err ?? "加载中…"}</div>;

  const statusOf = (n: number): string =>
    data.chapters.find((c) => c.chapter_no === n)?.status ?? "not_started";

  const byDim = new Map<string, Habit[]>();
  for (const h of data.habits) {
    const list = byDim.get(h.dimension) ?? [];
    list.push(h);
    byDim.set(h.dimension, list);
  }

  return (
    <div className="page">
      <section className="panel">
        <div className="row between">
          <h2>我的进度</h2>
          <span className="meta">
            {data.maxChapterNo != null ? `已学到第 ${data.maxChapterNo} 章` : "尚未设置"}
          </span>
        </div>
        <p className="hint">
          点章节即把进度推进到该章（前面的章节标为已学完，该章标为在学）。
          <b>模型只会用已学范围里的方法解题</b>；必须用到后面章节时，会明确告诉你「你还没学」。
        </p>

        <div className="chapgrid">
          {Array.from({ length: maxCh }, (_, i) => i + 1).map((n) => {
            const s = statusOf(n);
            const isCurrent = data.maxChapterNo === n;
            return (
              <button
                type="button"
                key={n}
                className={`chap st-${s}${isCurrent ? " cur" : ""}`}
                onClick={() => void advance(n)}
                disabled={busy}
                title={isCurrent ? "当前正在学" : `设进度为第 ${n} 章`}
              >
                <b>{n}</b>
                <span>{s === "done" ? "已学完" : s === "learning" ? "在学" : "未学"}</span>
              </button>
            );
          })}
        </div>

        <div className="row">
          <label className="inline">
            <span>总章数</span>
            <input
              type="number"
              min={6}
              max={40}
              value={maxCh}
              onChange={(e) => setMaxCh(Number(e.target.value) || 18)}
            />
          </label>
          <button type="button" className="danger" onClick={() => void reset()} disabled={busy}>
            清空进度
          </button>
          {busy && <span className="meta">写入中…</span>}
        </div>
        {err && <div className="alert errbox">{err}</div>}
      </section>

      <section className="panel">
        <h2>学习习惯</h2>
        {data.habits.length === 0 ? (
          <p className="hint">
            还没有记录。习惯来自你上传的改错照片、代码片段和对话，由模型判断后落库，
            每条都带证据条数（括号里的数字），可以追问「你凭什么这么说我」。
          </p>
        ) : (
          <div className="habits">
            {[...byDim.entries()].map(([dim, rows]) => (
              <div className="hrow" key={dim}>
                <span className="hdim">{DIM_LABEL[dim] ?? dim}</span>
                <span className="hit">
                  {rows.map((r) => (
                    <i key={`${r.key}-${r.course_code ?? ""}`}>
                      {r.key} → <b>{r.value}</b>
                      <em>({r.evidence_count})</em>
                    </i>
                  ))}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {data.preferences.length > 0 && (
        <section className="panel">
          <h2>时段偏好</h2>
          <ul className="list">
            {data.preferences.map((p) => (
              <li key={`${p.weekday_from}-${p.start_time}-${p.mode}`}>
                <span className={p.mode === "avoid" ? "dot cat-work" : "dot cat-life"} />
                <span className="name">
                  周{WD[p.weekday_from - 1]}
                  {p.weekday_to !== p.weekday_from ? `~周${WD[p.weekday_to - 1]}` : ""}{" "}
                  {p.start_time ? `${p.start_time}-${p.end_time ?? "24:00"}` : "全天"}
                </span>
                <span className="meta">{p.mode === "avoid" ? "不想学" : "适合学"}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

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
