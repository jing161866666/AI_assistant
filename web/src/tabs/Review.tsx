import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import BeyondNotice from "../components/BeyondNotice.tsx";
import ImageInput from "../components/ImageInput.tsx";
import MathText from "../components/MathText.tsx";
import { useJobs } from "../jobs.tsx";
import { useDraft, useKept } from "../persist.ts";
import { runStream, type StreamResult } from "../stream.ts";
import type { BankMatch, StoredTurn } from "../types.ts";

const VERDICT: Record<string, { label: string; cls: string }> = {
  correct: { label: "答对了", cls: "v-ok" },
  partially: { label: "部分正确", cls: "v-part" },
  wrong: { label: "答错了", cls: "v-bad" },
  unsolved: { label: "只解题", cls: "v-solve" },
};

const ERROR_LABEL: Record<string, string> = {
  none: "无错误",
  concept: "概念不清",
  misread: "审题出错",
  boundary: "边界条件漏判",
  formula: "公式记错/用错",
  unit: "单位或量纲",
  logic: "推导逻辑断裂",
  careless: "计算粗心",
  unknown: "无法判断",
};

const INPUT_KIND_LABEL: Record<string, string> = {
  answer: "最终答案",
  process: "解题过程 / 思路",
  question: "提问 / 求助",
  empty: "未填写",
  unknown: "无法判断",
};

/** 后台任务 id：切页面不丢结果，靠它取回 */
const JOB_ID = "review";

/** 每个科目记一条"上一轮结果"的本地指针，刷新后据此从库里读回 */
const turnKey = (course: string): string => `ai-study.lastTurn.${course}`;

/** 库里的一轮 → 界面用的结果结构（刷新恢复时用） */
function turnToResult(t: StoredTurn): StreamResult {
  const g = t.meta.grade;
  return {
    mode: t.meta.kind === "grade" ? "grade" : "solve",
    source: t.meta.source as StreamResult["source"],
    bank: t.meta.bank ?? null,
    citations: [],
    model: t.meta.model,
    ms: t.meta.ms,
    grade: g
      ? {
          verdict: g.verdict as "correct" | "partially" | "wrong" | "unsolved",
          input_kind: g.input_kind as "answer" | "process" | "question" | "empty" | "unknown",
          error_type: g.error_type,
          cause: g.cause,
          correction: t.answer,
          hints: g.hints,
          related_kps: g.related_kps,
        }
      : undefined,
    text: t.answer,
    notes: [],
  };
}

/** 题库来源标签：让用户一眼看出这道题的答案是不是题库原文 */
function bankTag(source?: string, bank?: BankMatch | null): string | null {
  if (!source) return null;
  if (source === "bank-answer" && bank) {
    return `题库命中 ${bank.qno ? `#${bank.qno}` : bank.chapter} · 依据题库答案`;
  }
  if (source === "bank-no-answer" && bank) {
    return `题库命中 ${bank.qno ? `#${bank.qno}` : bank.chapter} · 题库无答案，模型自解`;
  }
  if (bank) return `题库最接近 ${bank.qno ? `#${bank.qno}` : bank.chapter} · 未确认同题，模型自解`;
  return "题库未收录 · 模型自解";
}

export default function Review({ course, onSaved }: { course: string; onSaved: () => void }) {
  // 切页签/关页面都不该把已输入的题目与作答弄丢
  const [question, setQuestion, clearQuestion, questionRestored] = useDraft("review.question", "");
  const [myAnswer, setMyAnswer, clearMyAnswer] = useDraft("review.myAnswer", "");
  const [images, setImages] = useKept<string[]>("review.images", []);
  const [answerImages, setAnswerImages] = useKept<string[]>("review.answerImages", []);
  /** full = 逐步详细推导；brief = 用户主动选的精简版，省时间 */
  const [detail, setDetail] = useKept<"full" | "brief">("review.detail", "full");
  const [localErr, setLocalErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  /** 模型判成别的科目时，默认存到那个科目；这个开关让用户改回当前科目 */
  const [saveToCurrent, setSaveToCurrent] = useState(false);
  /** 题目图和作答图都在本页，Ctrl+V 只能粘到一个，用最后聚焦的那一栏作为目标 */
  const [pasteTarget, setPasteTarget] = useState<"question" | "answer">("question");

  // 结果存在全局任务表里，不在本组件 state 里：
  // 切到别的标签页再回来，请求照样在跑，正文也一路在攒。
  const jobs = useJobs();
  const job = jobs.get<StreamResult>(JOB_ID);
  const busy = job?.status === "running";
  const res = job?.status === "done" ? (job.result ?? null) : null;
  const live = job?.result ?? null;
  const err = localErr ?? (job?.status === "error" ? (job.error ?? "请求失败") : null);
  /** 从库里恢复过结果没有（每个科目只试一次） */
  const restoredFor = useRef<string | null>(null);

  // 刷新页面后：内存里的 jobs 没了，但库里有上一轮 → 读回来重新渲染
  useEffect(() => {
    if (job || restoredFor.current === course) return;
    const saved = localStorage.getItem(turnKey(course));
    if (!saved) return;
    restoredFor.current = course;
    let alive = true;
    void (async () => {
      try {
        const r = await api.turn(Number(saved));
        if (alive) jobs.restore(JOB_ID, "上次结果", turnToResult(r.turn));
      } catch {
        // 库被清过或记录不存在：丢掉指针，别每次刷新都撞一次 404
        localStorage.removeItem(turnKey(course));
      }
    })();
    return () => {
      alive = false;
    };
  }, [course, job, jobs]);

  const submit = (): void => {
    if (!question.trim() && images.length === 0) {
      setLocalErr("题目文字或题目图片至少给一个");
      return;
    }
    setLocalErr(null);
    setSaved(false);
    setSaveToCurrent(false);
    jobs.run(JOB_ID, myAnswer.trim() || answerImages.length ? "批改" : "解题", (patch) =>
      runStream(
        {
          question: question.trim(),
          myAnswer: myAnswer.trim() || undefined,
          images,
          answerImages,
          detail,
          course,
        },
        // 流式增量写进任务表：切页面回来还能看到已生成的部分
        (acc) => {
          // 记下这一轮的 id：刷新后用它从本地库恢复
          if (acc.turn) localStorage.setItem(turnKey(course), String(acc.turn.messageId));
          patch({ result: acc });
        },
      ),
    );
  };

  const save = async (): Promise<void> => {
    if (!res) return;
    // 有确定的科目就存那科；判不出就存成「未归类」，并记下模型的预测名（便于以后认领）
    const target =
      res.subject?.mismatch && res.subject.code && !saveToCurrent
        ? res.subject.code
        : res.subject?.code && !saveToCurrent
          ? (res.subject.code ?? undefined)
          : course || undefined;
    try {
      await api.saveMistake({
        title: (question || "图片题").slice(0, 200),
        course: target,
        predictedCourse: target ? undefined : (res.subject?.raw ?? ""),
        raw_text: question,
        my_answer: myAnswer,
        correct_answer: res.text,
        error_type: res.grade?.error_type ?? "none",
        error_detail: res.grade?.cause ?? "",
        kp_codes: res.grade?.related_kps ?? [],
        // 题目原图优先：错题本要能显示用户自己的截图，而不是只有我们转录的文字。
        // 只存题目图，不存作答图——作答图展示的会是学生的草稿，容易被当成题干。
        images,
      });
      setSaved(true);
      onSaved();
    } catch (e) {
      setLocalErr(`保存失败：${(e as Error).message}`);
    }
  };

  /** 展示数据：已完成的优先，其次用正在攒的（流式过程中也能看到判定与正文） */
  const view = res ?? live;
  const isGrade = view?.mode === "grade";
  const grade = view?.grade;
  const tag = bankTag(view?.source, view?.bank);
  /** 模型判成了别的已勾选科目：提示 + 默认存到那科 */
  const route = view?.subject;
  /** 模型判不出属于哪门勾选科目：只作答，不写入错题本 */
  const unclassified = !!route && route.code == null;
  const mismatch = route?.mismatch && route.code ? route : null;
  const hintTag =
    isGrade && grade?.verdict === "unsolved" && grade.input_kind !== "unknown"
      ? `已识别为：${INPUT_KIND_LABEL[grade.input_kind] ?? grade.input_kind}`
      : null;

  return (
    <div className="page">
      <section className="panel">
        <h2>改错 / 解题</h2>
        <p className="hint">
          题目和你的作答都可以拍照上传。<b>不填作答就只解题、不分析错因</b>，但同样能存进错题本。
          截图<b>直接 Ctrl+V 粘贴</b>即可，不用先点按钮；粘贴到哪一栏看下面这行提示 ——
          <span className={`tag paste-${pasteTarget}`}>
            当前粘贴到：{pasteTarget === "question" ? "题目" : "我的答案"}
          </span>
        </p>
        <p className="hint">
          作答那一栏不一定非得是答案：写<b>过程、草稿、或者直接问「这一步为什么」</b>都可以，
          模型会先判断你写的是哪一种，再决定是批改、接着你的思路讲、还是先回答疑问。
        </p>

        <label className="fld">
          <span>题目</span>
          <ImageInput
            kind="question"
            label="题目图片"
            storageKey="review.question"
            active={pasteTarget === "question"}
            onActivate={() => setPasteTarget("question")}
            onImages={setImages}
            onText={(t) => setQuestion((prev) => (prev.trim() ? `${t}\n\n${prev}` : t))}
          />
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onFocus={() => setPasteTarget("question")}
            onClick={() => setPasteTarget("question")}
            rows={4}
            placeholder="题目原文，或上传图片后在此校对识别结果"
          />
        </label>

        <label className="fld">
          <span>
            我的答案 / 过程 <em>（留空则只解题，不分析错因）</em>
          </span>
          <ImageInput
            kind="answer"
            label="手写作答图片"
            storageKey="review.answer"
            active={pasteTarget === "answer"}
            onActivate={() => setPasteTarget("answer")}
            onImages={setAnswerImages}
            onText={(t) => setMyAnswer((prev) => (prev.trim() ? `${t}\n\n${prev}` : t))}
          />
          <textarea
            value={myAnswer}
            onChange={(e) => setMyAnswer(e.target.value)}
            onFocus={() => setPasteTarget("answer")}
            onClick={() => setPasteTarget("answer")}
            rows={3}
            placeholder="最终答案、半截推导、或者一句「这一步为什么」都可以；留空即只解题"
          />
        </label>

        {questionRestored && (question.trim() || myAnswer.trim()) && (
          <p className="imgnote">
            已恢复上次没提交的输入（存在本机浏览器里）。
            <button
              type="button"
              className="link"
              onClick={() => {
                clearQuestion();
                clearMyAnswer();
                setImages(() => []);
                setAnswerImages(() => []);
              }}
            >
              清空
            </button>
          </p>
        )}

        <div className="row">
          <span className="seg">
            <button
              type="button"
              className={detail === "full" ? "on" : ""}
              onClick={() => setDetail("full")}
            >
              详细推导
            </button>
            <button
              type="button"
              className={detail === "brief" ? "on" : ""}
              onClick={() => setDetail("brief")}
            >
              精简（更快）
            </button>
          </span>
          <button type="button" className="primary" onClick={submit} disabled={busy}>
            {busy
              ? live?.text
                ? "生成中…（往下看）"
                : "思考中…"
              : myAnswer.trim() || answerImages.length
                ? "开始批改"
                : "解题"}
          </button>
          {busy && <span className="meta">已转入后台：切到别的页面也行，回来接着看</span>}
        </div>
      </section>

      {err && <div className="alert errbox">{err}</div>}

      {view && (view.text || grade) && (
        <section className="panel">
          <div className="row between">
            <span className={`verdict ${VERDICT[grade?.verdict ?? "unsolved"]?.cls ?? ""}`}>
              {isGrade
                ? (VERDICT[grade?.verdict ?? "unsolved"]?.label ?? "批改")
                : (VERDICT.unsolved?.label ?? "只解题")}
            </span>
            {isGrade && <span className="tag">{ERROR_LABEL[grade?.error_type ?? ""] ?? "—"}</span>}
            {hintTag && <span className="tag">{hintTag}</span>}
            {!isGrade && tag && <span className="tag">{tag}</span>}
            {view.degraded && <span className="tag">本次未拿到结构化判定</span>}
            {job?.label === "上次结果" && <span className="tag">已从本地库恢复上次结果</span>}
            <span className="meta">
              {view.model} {view.ms != null ? `· ${(view.ms / 1000).toFixed(1)}s` : ""}
              {busy ? " · 生成中" : ""}
            </span>
          </div>

          <BeyondNotice
            beyond={view.beyond}
            uncertain={view.uncertain}
            maxChapterNo={view.maxChapterNo}
          />

          {mismatch && (
            <div className="alert">
              ⚠ {mismatch.reason}。存错题默认归到《{mismatch.name}》。
              <button type="button" className="link" onClick={() => setSaveToCurrent((v) => !v)}>
                {saveToCurrent ? `改回存到《${mismatch.name}》` : `其实是当前科目（${course}）的题`}
              </button>
            </div>
          )}

          {view.notes.map((n) => (
            <div className="alert" key={n}>
              {n}
            </div>
          ))}

          {isGrade && grade?.cause && (
            <>
              <h3>错在哪</h3>
              <p>{grade.cause}</p>
            </>
          )}

          <h3>{isGrade ? "正确答案" : "解答与扩充解析"}</h3>
          {view.text ? (
            <MathText text={view.text} />
          ) : (
            <p className="meta">正在生成第一步…（首字通常 3-5 秒）</p>
          )}

          {grade && grade.hints.length > 0 && (
            <>
              <h3>下次注意</h3>
              <ul className="mdlist">
                {grade.hints.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
            </>
          )}

          {grade && grade.related_kps.length > 0 && (
            <>
              <h3>相关知识点</h3>
              <div className="chips">
                {grade.related_kps.map((k) => (
                  <span className="chip static" key={k}>
                    {k}
                  </span>
                ))}
              </div>
            </>
          )}

          {view.citations.length > 0 && (
            <>
              <h3>引用来源</h3>
              <ol className="cites">
                {view.citations.map((c) => (
                  <li key={c.index}>
                    <div className="ct">
                      <b>{c.textbook}</b> · {c.chapter}
                      {c.page != null ? ` · 第 ${c.page} 页` : ""}
                    </div>
                    <div className="ce">{c.excerpt}…</div>
                  </li>
                ))}
              </ol>
            </>
          )}

          <div className="row">
            {unclassified ? (
              // 判不出属于哪门勾选科目：只作答，明确告诉用户不会入库
              <p className="hint">
                这道题不属于你勾选的科目：本次只作答，<b>不会存入错题本</b>。
                如果是同一门课，先去「科目」页把它加上/勾选再重试。
              </p>
            ) : (
              <button
                type="button"
                className="primary"
                onClick={() => void save()}
                disabled={saved || busy}
              >
                {saved
                  ? "已存入错题本 ✓"
                  : mismatch && !saveToCurrent
                    ? `存入《${mismatch.name}》错题本`
                    : "存入错题本"}
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
