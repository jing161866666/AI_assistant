import { useState } from "react";
import { api } from "../api.ts";
import ImageInput from "../components/ImageInput.tsx";
import MathText from "../components/MathText.tsx";
import type { ReviewResponse } from "../types.ts";

const VERDICT: Record<string, { label: string; cls: string }> = {
  correct: { label: "答对了", cls: "v-ok" },
  partially: { label: "部分正确", cls: "v-part" },
  wrong: { label: "答错了", cls: "v-bad" },
  unsolved: { label: "只解题", cls: "v-solve" },
};

export default function Review({ onSaved }: { onSaved: () => void }) {
  const [question, setQuestion] = useState("");
  const [myAnswer, setMyAnswer] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [answerImages, setAnswerImages] = useState<string[]>([]);
  const [res, setRes] = useState<ReviewResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const submit = async (): Promise<void> => {
    if (!question.trim() && images.length === 0) {
      setErr("题目文字或题目图片至少给一个");
      return;
    }
    setBusy(true);
    setErr(null);
    setRes(null);
    setSaved(false);
    try {
      setRes(
        await api.review(question.trim(), myAnswer.trim() || undefined, {
          images,
          answerImages,
        }),
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async (): Promise<void> => {
    if (!res) return;
    const v = res.view;
    try {
      await api.saveMistake({
        title: (res.question || "图片题").slice(0, 200),
        raw_text: res.question,
        my_answer: res.myAnswer ?? "",
        correct_answer: v.correction,
        error_type: v.error_type,
        error_detail: v.cause,
        kp_codes: v.related_kps,
      });
      setSaved(true);
      onSaved();
    } catch (e) {
      setErr(`保存失败：${(e as Error).message}`);
    }
  };

  const v = res?.view;
  const isSolve = res?.mode === "solve";

  return (
    <div className="page">
      <section className="panel">
        <h2>改错 / 解题</h2>
        <p className="hint">
          题目和你的作答都可以拍照上传。<b>不填作答就只解题、不分析错因</b>，但同样能存进错题本。
          图片会先转录用于检索，原图同时交给推理模型，图形信息不会丢。
        </p>

        <label className="fld">
          <span>题目</span>
          <ImageInput
            kind="question"
            label="题目图片"
            onImages={setImages}
            onText={(t) => setQuestion((prev) => (prev.trim() ? `${t}\n\n${prev}` : t))}
          />
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={4}
            placeholder="题目原文，或上传图片后在此校对识别结果"
          />
        </label>

        <label className="fld">
          <span>
            我的答案 <em>（留空则只解题，不分析错因）</em>
          </span>
          <ImageInput
            kind="answer"
            label="手写作答图片"
            onImages={setAnswerImages}
            onText={(t) => setMyAnswer((prev) => (prev.trim() ? `${t}\n\n${prev}` : t))}
          />
          <textarea
            value={myAnswer}
            onChange={(e) => setMyAnswer(e.target.value)}
            rows={3}
            placeholder="数值、公式或整段推导。留空即只解题。"
          />
        </label>

        <div className="row">
          <button type="button" className="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? "处理中…" : myAnswer.trim() || answerImages.length ? "开始批改" : "解题"}
          </button>
        </div>
      </section>

      {err && <div className="alert errbox">{err}</div>}

      {res && v && (
        <section className="panel">
          <div className="row between">
            <span className={`verdict ${VERDICT[v.verdict]?.cls ?? ""}`}>
              {VERDICT[v.verdict]?.label ?? v.verdict}
            </span>
            {!isSolve && <span className="tag">{v.errorTypeLabel}</span>}
            <span className="meta">
              {v.model} · {v.ms}ms
            </span>
          </div>

          {isSolve ? (
            <>
              <h3>标准解答</h3>
              <MathText text={v.correction} />
            </>
          ) : (
            <>
              <h3>错在哪</h3>
              <p>{v.cause}</p>
              <h3>正确答案</h3>
              <MathText text={v.correction} />
              {v.hints.length > 0 && (
                <>
                  <h3>下次注意</h3>
                  <ul className="mdlist">
                    {v.hints.map((h) => (
                      <li key={h}>{h}</li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}

          {v.related_kps.length > 0 && (
            <>
              <h3>相关知识点</h3>
              <div className="chips">
                {v.related_kps.map((k) => (
                  <span className="chip static" key={k}>
                    {k}
                  </span>
                ))}
              </div>
            </>
          )}

          {v.references.length > 0 && (
            <>
              <h3>引用来源</h3>
              <ol className="cites">
                {v.references.map((c) => (
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
            <button type="button" className="primary" onClick={() => void save()} disabled={saved}>
              {saved ? "已存入错题本 ✓" : "存入错题本"}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
