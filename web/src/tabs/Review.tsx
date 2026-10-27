import { useState } from "react";
import { api } from "../api.ts";
import BeyondNotice from "../components/BeyondNotice.tsx";
import ImageInput from "../components/ImageInput.tsx";
import MathText from "../components/MathText.tsx";
import { useJobs } from "../jobs.tsx";
import { runStream, type StreamResult } from "../stream.ts";
import type { BankMatch } from "../types.ts";

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

export default function Review({ onSaved }: { onSaved: () => void }) {
  const [question, setQuestion] = useState("");
  const [myAnswer, setMyAnswer] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [answerImages, setAnswerImages] = useState<string[]>([]);
  /** full = 逐步详细推导；brief = 用户主动选的精简版，省时间 */
  const [detail, setDetail] = useState<"full" | "brief">("full");
  const [localErr, setLocalErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
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

  const submit = (): void => {
    if (!question.trim() && images.length === 0) {
      setLocalErr("题目文字或题目图片至少给一个");
      return;
    }
    setLocalErr(null);
    setSaved(false);
    jobs.run(JOB_ID, myAnswer.trim() || answerImages.length ? "批改" : "解题", (patch) =>
      runStream(
        {
          question: question.trim(),
          myAnswer: myAnswer.trim() || undefined,
          images,
          answerImages,
          detail,
        },
        // 流式增量写进任务表：切页面回来还能看到已生成的部分
        (acc) => patch({ result: acc }),
      ),
    );
  };

  const save = async (): Promise<void> => {
    if (!res) return;
    try {
      await api.saveMistake({
        title: (question || "图片题").slice(0, 200),
        raw_text: question,
        my_answer: myAnswer,
        correct_answer: res.text,
        error_type: res.grade?.error_type ?? "none",
        error_detail: res.grade?.cause ?? "",
        kp_codes: res.grade?.related_kps ?? [],
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
            <span className="meta">
              {view.model} {view.ms != null ? `· ${(view.ms / 1000).toFixed(1)}s` : ""}
              {busy ? " · 生成中" : ""}
            </span>
          </div>

          <BeyondNotice beyond={view.beyond} maxChapterNo={view.maxChapterNo} />

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
            <button
              type="button"
              className="primary"
              onClick={() => void save()}
              disabled={saved || busy}
            >
              {saved ? "已存入错题本 ✓" : "存入错题本"}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
