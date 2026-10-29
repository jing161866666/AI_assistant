import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import CourseMatchPanel from "../components/CourseMatchPanel.tsx";
import HabitInputPanel from "../components/HabitInputPanel.tsx";
import type { CourseScopeResponse, SubjectSummary, TimetableCourse } from "../types.ts";

/**
 * 「科目」页 —— 增加科目的框架。
 *
 * 这里只做三件事：
 *   1) 登记科目（代码 + 名称 + 备注），不写任何先验知识；
 *   2) 显示每门课的知识库就绪状态，缺库的明确告诉你跑哪条命令；
 *   3) 勾选"允许 AI 辅助"的科目（候选来自课程表），以及学习路径的科目范围预检。
 */
export default function Subjects({
  subjects,
  currentCourse,
  onPickCourse,
  onChanged,
  onOpenSetup,
}: {
  subjects: SubjectSummary[];
  currentCourse: string;
  onPickCourse: (code: string) => void;
  onChanged: () => void;
  /** 打开课表导入向导（首次设置就是它） */
  onOpenSetup?: () => void;
}) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  /** 正在改名的科目代码；null = 没有在改 */
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editNote, setEditNote] = useState("");

  /** AI 辅助科目的候选（来自课程表）与勾选 */
  const [aiCourses, setAiCourses] = useState<TimetableCourse[]>([]);
  const [aiSelected, setAiSelected] = useState<string[]>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMsg, setAiMsg] = useState<string | null>(null);

  /** 学习路径预检的科目勾选（默认当前科目） */
  const [scopeCodes, setScopeCodes] = useState<string[]>(currentCourse ? [currentCourse] : []);
  const [scope, setScope] = useState<CourseScopeResponse | null>(null);
  const [scopeBusy, setScopeBusy] = useState(false);

  const loadAi = useCallback(async (): Promise<void> => {
    try {
      const r = await api.aiSubjects();
      setAiCourses(r.courses);
      setAiSelected(r.selected);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void loadAi();
  }, [loadAi]);

  useEffect(() => {
    setScopeCodes((prev) => {
      const keep = prev.filter((c) => subjects.some((s) => s.code === c && s.active));
      if (keep.length > 0) return keep;
      return currentCourse ? [currentCourse] : [];
    });
  }, [subjects, currentCourse]);

  const toggleAi = (c: string): void => {
    setAiSelected((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  };

  const saveAi = async (): Promise<void> => {
    setAiBusy(true);
    setErr(null);
    setAiMsg(null);
    try {
      const r = await api.setAiSubjects(aiSelected);
      setAiCourses(r.courses);
      setAiSelected(r.selected);
      setAiMsg(r.message);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setAiBusy(false);
    }
  };

  const submit = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await api.addSubject({
        code: code.trim(),
        name: name.trim() || undefined,
        note: note.trim() || undefined,
      });
      setMsg(r.message);
      setCode("");
      setName("");
      setNote("");
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const archive = async (c: string): Promise<void> => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await api.archiveSubject(c);
      setMsg(r.message);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** 科目名称/备注可改，科目代码是所有记忆的锚点，不在这里改 */
  const startEditSubject = (s: SubjectSummary): void => {
    setEditingCode(s.code);
    setEditName(s.name);
    setEditNote(s.note ?? "");
    setErr(null);
    setMsg(null);
  };

  const saveSubject = async (code: string): Promise<void> => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await api.updateSubject(code, {
        name: editName.trim(),
        note: editNote.trim() || null,
      });
      setMsg(`已更新「${r.subject.name}」（${r.subject.code}）`);
      setEditingCode(null);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runScope = async (): Promise<void> => {
    setScopeBusy(true);
    setErr(null);
    try {
      const r = await api.roadmapScope({
        course: currentCourse,
        courses: scopeCodes,
        intent: "roadmap",
      });
      setScope(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setScopeBusy(false);
    }
  };

  const toggleScope = (c: string): void => {
    setScopeCodes((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  };

  return (
    <div className="page">
      <section className="panel">
        <div className="row between">
          <h2>科目</h2>
          <span className="row">
            {onOpenSetup && (
              <button type="button" onClick={onOpenSetup}>
                导入 / 重新导入课表
              </button>
            )}
            <span className="meta">
              {subjects.filter((s) => s.textbook_ready).length}/{subjects.length} 门课知识库就绪
            </span>
          </span>
        </div>
        <p className="hint">
          一门课 = 一个科目代码 + 一个只读教材库（data/textbook/course-
          <b>代码小写</b>.db）。进度、错题、习惯都按科目分开存，互不影响。
          <br />
          资料放在 <code>课程/&lt;课程简称&gt;/</code>（教材 / 参考书 / 课件），再跑{" "}
          <code>npx tsx scripts/build-course.ts --course 简称 --code 代码</code> 建库——
          系统不会替你编教材。
        </p>

        <div className="formrow">
          <label className="inline">
            <span>科目代码</span>
            <input
              value={code}
              placeholder="如 DS / MATH2 / CS101"
              maxLength={16}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
          </label>
          <label className="inline">
            <span>科目名称</span>
            <input
              value={name}
              placeholder="如 数据结构（不填就用代码）"
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="inline grow">
            <span>备注</span>
            <input
              value={note}
              placeholder="如 教材待补 / C++ 描述版"
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <button type="button" onClick={() => void submit()} disabled={busy || !code.trim()}>
            {busy ? "处理中…" : "添加科目"}
          </button>
        </div>
        {msg && <div className="alert okbox">{msg}</div>}
        {err && <div className="alert errbox">{err}</div>}

        <div className="subjgrid">
          {subjects.map((s) => (
            <article className={`subjcard${s.code === currentCourse ? " cur" : ""}`} key={s.code}>
              <header>
                <b>{s.name}</b>
                <span className="tag subj">{s.code}</span>
                {!s.textbook_ready && (
                  <span className="tag" title="还没有教材库">
                    待建库
                  </span>
                )}
              </header>

              <p className="meta">
                {s.textbook_ready
                  ? `知识库 ${s.chapters} 章 / ${s.chunks} 片${s.version ? ` · ${s.version}` : ""}`
                  : `知识库未构建：npm run build:textbook（COURSE_CODE=${s.code}）`}
              </p>

              <div className="stats">
                <div className="stat">
                  <b>{s.progress.learnedCount}</b>
                  <span>已学章</span>
                </div>
                <div className="stat">
                  <b>{s.progress.maxChapterNo ?? "—"}</b>
                  <span>当前章</span>
                </div>
                <div className="stat">
                  <b>{s.mistakes.total}</b>
                  <span>错题</span>
                </div>
                <div className="stat">
                  <b>{s.mistakes.unresolved}</b>
                  <span>未掌握</span>
                </div>
                <div className="stat">
                  <b>{s.habits}</b>
                  <span>习惯</span>
                </div>
              </div>

              {s.progress.gaps.length > 0 && (
                <p className="meta">⚠ 跳过未学：第 {s.progress.gaps.join("、")} 章</p>
              )}
              {s.note && <p className="meta">备注：{s.note}</p>}

              {editingCode === s.code && (
                <div className="row wrap">
                  <input
                    type="text"
                    value={editName}
                    maxLength={60}
                    placeholder="科目名称，如 大学物理"
                    style={{ width: 180 }}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && editName.trim()) void saveSubject(s.code);
                      if (e.key === "Escape") setEditingCode(null);
                    }}
                  />
                  <input
                    type="text"
                    value={editNote}
                    placeholder="备注（可空）"
                    style={{ width: 160 }}
                    onChange={(e) => setEditNote(e.target.value)}
                  />
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || !editName.trim()}
                    onClick={() => void saveSubject(s.code)}
                  >
                    保存
                  </button>
                  <button type="button" disabled={busy} onClick={() => setEditingCode(null)}>
                    取消
                  </button>
                </div>
              )}

              <footer className="row">
                <button
                  type="button"
                  className={s.code === currentCourse ? "on" : ""}
                  disabled={s.code === currentCourse}
                  onClick={() => onPickCourse(s.code)}
                >
                  {s.code === currentCourse ? "当前科目" : "设为当前科目"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    editingCode === s.code ? setEditingCode(null) : startEditSubject(s)
                  }
                >
                  {editingCode === s.code ? "取消改名" : "改名"}
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => void archive(s.code)}
                >
                  停用
                </button>
              </footer>
            </article>
          ))}
        </div>
      </section>

      <CourseMatchPanel onChanged={onChanged} />

      <HabitInputPanel
        subjects={subjects.map((s) => ({ code: s.code, name: s.name }))}
        onChanged={onChanged}
      />

      <section className="panel">
        <div className="row between">
          <h2>AI 辅助科目</h2>
          <span className="meta">候选来自你的课程表 · 已勾选 {aiSelected.length} 门</span>
        </div>
        <p className="hint">
          只勾你希望 AI 辅助的课。<b>qwen 只会在勾选的科目里</b>判断一道题属于哪一科；
          没勾的课不会被分流，也不会被归档。勾选即授权，会顺手把这门课登记成科目，但
          <b>不会替你建教材库</b>（教材/参考书/课件仍要你提供后再 build:textbook）。
        </p>

        {aiCourses.length === 0 ? (
          <p className="hint">课程表里没有带课程代码的课。先导入课表，或在上面手工添加科目。</p>
        ) : (
          <div className="chips">
            {aiCourses.map((c) => (
              <button
                type="button"
                key={c.code}
                className={`chip${aiSelected.includes(c.code) ? " on" : ""}`}
                onClick={() => toggleAi(c.code)}
                title={
                  c.textbook_ready
                    ? "知识库已就绪"
                    : "知识库未构建：可先勾选，但要 build:textbook 后才能问教材/改错"
                }
              >
                {aiSelected.includes(c.code) ? "✓ " : ""}
                {c.name}
                {c.textbook_ready ? "" : "（待建库）"}
              </button>
            ))}
          </div>
        )}

        <div className="row">
          <button type="button" onClick={() => void saveAi()} disabled={aiBusy}>
            {aiBusy ? "保存中…" : "保存勾选"}
          </button>
          <span className="meta">
            一周几次课：{aiCourses.map((c) => `${c.code}×${c.periods}`).join("、")}
          </span>
        </div>
        {aiMsg && <div className="alert okbox">{aiMsg}</div>}
      </section>

      <section className="panel">
        <h2>学习路径：调用哪些科目的知识库</h2>
        <p className="hint">
          答题/改错永远只用当前科目的库；学习路径可以先勾几门课，由代码判断要不要跨库检索。
          每门课各用各的已学章节做门控，拿物理的进度过滤数据结构是错的。
        </p>
        <div className="chips">
          {subjects.map((s) => (
            <button
              type="button"
              key={s.code}
              className={`chip${scopeCodes.includes(s.code) ? " on" : ""}`}
              onClick={() => toggleScope(s.code)}
            >
              {s.name}
              {s.textbook_ready ? "" : "（待建库）"}
            </button>
          ))}
          <button type="button" onClick={() => void runScope()} disabled={scopeBusy}>
            {scopeBusy ? "判断中…" : "预检"}
          </button>
        </div>

        {scope && (
          <div className={scope.blocked ? "alert errbox" : "alert okbox"}>
            <p>
              <b>{scope.reason}</b>
            </p>
            <p className="meta">
              实际打开的知识库：
              {scope.sources.length === 0
                ? "无"
                : scope.sources.map((s) => `${s.name}（${s.file}）`).join("、")}
            </p>
            {scope.retrieval.length > 0 && (
              <p className="meta">
                门控：
                {scope.retrieval
                  .map(
                    (r) =>
                      `${r.code} ${r.gatedChapters == null ? "未设进度" : `已学 ${r.gatedChapters} 章`}`,
                  )
                  .join("；")}
              </p>
            )}
            {scope.warnings.length > 0 && (
              <ul className="list">
                {scope.warnings.map((w) => (
                  <li key={w}>
                    <span className="dot cat-life" />
                    <span className="name">{w}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
