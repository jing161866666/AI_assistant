import { useCallback, useEffect, useState } from "react";
import { api } from "./api.ts";
import { useJobs } from "./jobs.tsx";
import Ask from "./tabs/Ask.tsx";
import Mistakes from "./tabs/Mistakes.tsx";
import Progress from "./tabs/Progress.tsx";
import Review from "./tabs/Review.tsx";
import Schedule from "./tabs/Schedule.tsx";
import Setup from "./tabs/Setup.tsx";
import Subjects from "./tabs/Subjects.tsx";
import type { CourseInfo, SubjectSummary, WeekResponse } from "./types.ts";

type Tab = "schedule" | "ask" | "review" | "mistakes" | "progress" | "subjects";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "schedule", label: "日程表" },
  { key: "ask", label: "问教材" },
  { key: "review", label: "改错" },
  { key: "mistakes", label: "错题本" },
  { key: "progress", label: "我的进度" },
  { key: "subjects", label: "科目" },
];

/** 用户选过的科目记在本地，下次打开还是它 */
const COURSE_KEY = "ai-study.course";

export default function App() {
  const [tab, setTab] = useState<Tab>("schedule");
  const [data, setData] = useState<WeekResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mkVersion, setMkVersion] = useState(0);
  /** 当前科目：后端不再有隐式默认，选不到科目就不能用错题/解题/进度 */
  const [courses, setCourses] = useState<CourseInfo[]>([]);
  const [subjects, setSubjects] = useState<SubjectSummary[]>([]);
  const [course, setCourse] = useState<string>("");
  /** 首次设置：没有课程日程时自动弹出课表导入 */
  const [setupNeeded, setSetupNeeded] = useState(false);
  const [showSetup, setShowSetup] = useState(false);

  const { jobs, running } = useJobs();
  const busyTabs = new Set(jobs.filter((j) => j.status === "running").map((j) => j.id));

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

  /**
   * 科目清单（注册表 + 每科概况）。
   * 加科目/停用科目后要重新拉一次，否则科目选择器还是旧的。
   */
  const loadCourses = useCallback(async () => {
    try {
      const r = await api.courses();
      /**
       * 兼容旧后端：静态前端是从磁盘现读的，但后端进程可能是改代码之前启动的。
       * 旧版 /api/courses 没有 subjects 字段，直接 set 会让整页白屏——
       * 这里降级成空数组，并明确告诉用户"重启后端"，而不是给一串 undefined。
       */
      const list = Array.isArray(r.courses) ? r.courses : [];
      const subs = Array.isArray(r.subjects) ? r.subjects : [];
      setCourses(list);
      setSubjects(subs);
      if (!Array.isArray(r.subjects)) {
        setError("后端进程还是旧版本（缺少科目接口）：请重启后端，否则科目/进度总览不可用");
        return;
      }
      const saved = localStorage.getItem(COURSE_KEY) ?? "";
      /**
       * 进度与错题本只开放"勾选允许 AI 辅助"的科目：
       * 选择器与默认科目都从 aiCourses 里挑，没勾的课即使有教材库也不选。
       */
      const pool = list.filter((c) => c.aiEnabled);
      const pick =
        pool.find((c) => c.code === saved && c.textbookReady)?.code ??
        pool.find((c) => c.code === r.defaultCourse && c.textbookReady)?.code ??
        pool.find((c) => c.textbookReady)?.code ??
        pool[0]?.code ??
        "";
      setCourse(pick);
      if (!pick) {
        setError(
          list.length === 0
            ? "还没有科目：去「科目」页添加，并用 npm run build:textbook 构建知识库"
            : "还没有勾选「允许 AI 辅助」的科目：去「科目」页勾选后，进度与错题本才可用",
        );
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadCourses();
    void api
      .setupStatus()
      .then((s) => setSetupNeeded(s.needsSetup))
      .catch(() => void 0);
  }, [load, loadCourses]);

  const pickCourse = (code: string): void => {
    setCourse(code);
    localStorage.setItem(COURSE_KEY, code);
  };

  /** 进度/错题本的可选科目：只含用户勾选允许 AI 辅助的课 */
  const aiCourses = courses.filter((c) => c.aiEnabled);

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
              {busyTabs.has(t.key) && <span className="dot" title="后台还在跑，结果会保留" />}
            </button>
          ))}
          {/* 日程/问教材/改错不选科目：由模型在勾选科目里判；只有进度和错题本需要指定科目 */}
          {aiCourses.length > 0 && (tab === "progress" || tab === "mistakes") && (
            <label className="meta" style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>科目</span>
              <select value={course} onChange={(e) => pickCourse(e.target.value)}>
                {aiCourses.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}（{c.code}）{c.textbookReady ? "" : " · 待建库"}
                  </option>
                ))}
              </select>
            </label>
          )}
        </nav>
      </header>

      {running > 0 && (
        <div className="jobbar">
          <span className="spin">⟳</span>
          {jobs
            .filter((j) => j.status === "running")
            .map((j) => j.label)
            .join("、")}
          进行中 —— 可以切到别的页面继续看别的，回来结果还在
        </div>
      )}

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

      {tab === "ask" && (
        // 不传 course：后端先按勾选科目分流，判不出就只作答（不引教材）
        <Ask course="" onPickCourse={pickCourse} />
      )}
      {tab === "review" && <Review course="" onSaved={() => setMkVersion((v) => v + 1)} />}
      {tab === "mistakes" &&
        (course ? (
          <Mistakes key={`${mkVersion}-${course}`} course={course} />
        ) : (
          <div className="center">先在「科目」页勾选允许 AI 辅助的课程，错题本只对这些课程开放</div>
        ))}
      {tab === "progress" &&
        (course ? (
          <Progress
            course={course}
            onPickCourse={pickCourse}
            onChanged={() => void loadCourses()}
          />
        ) : (
          <div className="center">先在「科目」页勾选允许 AI 辅助的课程，进度只对这些课程开放</div>
        ))}
      {tab === "subjects" && (
        <Subjects
          subjects={subjects}
          currentCourse={course}
          onPickCourse={pickCourse}
          onChanged={() => void loadCourses()}
          onOpenSetup={() => setShowSetup(true)}
        />
      )}

      {(setupNeeded || showSetup) && (
        <Setup
          onClose={
            setupNeeded
              ? undefined
              : () => {
                  setShowSetup(false);
                }
          }
          onDone={() => {
            setSetupNeeded(false);
            setShowSetup(false);
            void loadCourses();
            void load();
          }}
        />
      )}
    </div>
  );
}
