import { useState } from "react";
import { api } from "../api.ts";
import MathText from "../components/MathText.tsx";
import type { ReviewResponse } from "../types.ts";

const VERDICT: Record<string, { label: string; cls: string }> = {
  correct: { label: "答对了", cls: "v-ok" },
  partially: { label: "部分正确", cls: "v-part" },
  wrong: { label: "答错了", cls: "v-bad" },
};

export default function Review({ onSaved }: { onSaved: () => void }) {
  const [question, setQuestion] = useState("");
  const [myAnswer, setMyAnswer] = useState("");
  const [correct, setCorrect] = useState("");
  const [res, setRes] = useState<ReviewResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const submit = async (): Promise<void> => {
    if (!question.trim() || !myAnswer.trim()) {
      setErr("题目和你的答案都要填");
      return;
    }
    setBusy(true);
    setErr(null);
    setRes(null);
    setSaved(false);
    try {
      setRes(await api.review(question, myAnswer, correct || undefined));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async (): Promise<void> => {
    if (!res) return;
    try {
      await api.saveMistake({
        title: question.slice(0, 200),
        raw_text: question,
        my_answer: myAnswer,
        correct_answer: res.correction,
        error_type: res.error_type,
        error_detail: res.cause,
        kp_codes: res.related_kps,
      });
      setSaved(true);
      onSaved();
    } catch (e) {
      setErr(`保存失败：${(e as Error).message}`);
    }
  };

  return (
    <div className="page">
      <section className="panel">
        <h2>改错</h2>
        <p className="hint">
          贴题目和你的答案（数值或推导都行），会判断对错并归因到具体的错因类型。
          归因是给老师看教学调整用的核心字段，请认真填。
        </p>

        <label className="fld">
          <span>题目</span>
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={3}
            placeholder="把题目原文贴进来"
          />
        </label>

        <label className="fld">
          <span>我的答案</span>
          <textarea
            value={myAnswer}
            onChange={(e) => setMyAnswer(e.target.value)}
            rows={3}
            placeholder="只写数值也行，例如 1.5e-7 m；也可以贴完整推导"
          />
        </label>

        <label className="fld">
          <span>参考答案（可选，有的话判断更准）</span>
          <textarea value={correct} onChange={(e) => setCorrect(e.target.value)} rows={2} />
        </label>

        <div className="row">
          <button type="button" className="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? "批改中…" : "开始批改"}
          </button>
        </div>
      </section>

      {err && <div className="alert errbox">{err}</div>}

      {res && (
        <section className="panel">
          <div className="row between">
            <span className={`verdict ${VERDICT[res.verdict]?.cls ?? ""}`}>
              {VERDICT[res.verdict]?.label ?? res.verdict}
            </span>
            <span className="tag">{res.errorTypeLabel}</span>
          </div>

          <h3>错在哪</h3>
          <p>{res.cause}</p>

          <h3>正确答案</h3>
          <MathText text={res.correction} />

          {res.hints.length > 0 && (
            <>
              <h3>下次注意</h3>
              <ul className="mdlist">
                {res.hints.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
            </>
          )}

          {res.related_kps.length > 0 && (
            <>
              <h3>相关知识点</h3>
              <div className="chips">
                {res.related_kps.map((k) => (
                  <span className="chip static" key={k}>
                    {k}
                  </span>
                ))}
              </div>
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
