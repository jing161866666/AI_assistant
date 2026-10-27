import { useCallback, useEffect, useState } from "react";
import { api } from "./api.ts";
import Ask from "./tabs/Ask.tsx";
import Mistakes from "./tabs/Mistakes.tsx";
import Review from "./tabs/Review.tsx";
import Schedule from "./tabs/Schedule.tsx";
import type { WeekResponse } from "./types.ts";

type Tab = "schedule" | "ask" | "review" | "mistakes";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "schedule", label: "日程表" },
  { key: "ask", label: "问教材" },
  { key: "review", label: "改错" },
  { key: "mistakes", label: "错题本" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("schedule");
  const [data, setData] = useState<WeekResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mkVersion, setMkVersion] = useState(0);

  /** 不传 week 时由服务端按系统时间定位当前周 */
  const load = useCallback(async (week?: number) => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.week(week));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="logo">◉</span>
          <div>
            <h1>AI 学习伙伴</h1>
            <p className="sub">
              {data
                ? `${data.term.name} · 第 ${data.context.currentWeek > 0 ? data.context.currentWeek : "—"} 周 · 今天 ${data.today}`
                : "加载中…"}
            </p>
          </div>
        </div>

        <nav className="tabs">
          {TABS.map((t) => (
            <button
              type="button"
              key={t.key}
              className={tab === t.key ? "on" : ""}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      {error && (
        <div className="alert errbox">
          接口出错：{error}
          <br />
          确认后端已启动（npm run dev），地址 http://127.0.0.1:8787
        </div>
      )}

      {tab === "schedule" &&
        (data ? (
          <Schedule
            data={data}
            loading={loading}
            onWeek={(w) => void load(w)}
            onRefresh={() => void load()}
          />
        ) : (
          <div className="center">加载中…</div>
        ))}

      {tab === "ask" && <Ask />}
      {tab === "review" && <Review onSaved={() => setMkVersion((v) => v + 1)} />}
      {tab === "mistakes" && <Mistakes key={mkVersion} />}
    </div>
  );
}
