import { useState } from "react";
import { api } from "../api.ts";
import MathText from "../components/MathText.tsx";
import type { AskResponse } from "../types.ts";

const EXAMPLES = [
  "杨氏双缝干涉的条纹间距公式是什么？什么时候条纹会变宽？",
  "安培环路定理的适用条件是什么？为什么不能用于非稳恒电流？",
  "简谐振动的总能量和振幅是什么关系？为什么动能变化频率是振动频率的两倍？",
  "光电效应的截止频率和遏止电压怎么算？",
];

export default function Ask() {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<AskResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (text?: string): Promise<void> => {
    const question = (text ?? q).trim();
    if (!question) return;
    setBusy(true);
    setErr(null);
    setRes(null);
    try {
      const r = await api.ask(question);
      setRes(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <section className="panel">
        <h2>问教材</h2>
        <p className="hint">
          回答优先依据本地教材库（王雷课件 + 清华题库，1498 段），引用会标编号。
          资料里没有的会明确说明，不会假装。
        </p>
        <textarea
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="把题目或疑问贴进来，例如：一束光垂直入射到折射率 1.5 的薄膜上，反射光相长干涉的条件是什么？"
          rows={4}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void submit();
          }}
        />
        <div className="row">
          <button type="button" className="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? "思考中…" : "提问（Ctrl+Enter）"}
          </button>
          {res && (
            <span className="meta">
              {res.model} · {res.ms}ms · {res.citations.length} 条引用
            </span>
          )}
        </div>
        <div className="chips">
          {EXAMPLES.map((e) => (
            <button
              type="button"
              key={e}
              className="chip"
              onClick={() => {
                setQ(e);
                void submit(e);
              }}
            >
              {e}
            </button>
          ))}
        </div>
      </section>

      {err && <div className="alert errbox">请求失败：{err}</div>}

      {res && (
        <section className="panel">
          <h2>回答</h2>
          <MathText text={res.answer} />
          {res.citations.length > 0 && (
            <>
              <h3>引用来源</h3>
              <ol className="cites">
                {res.citations.map((c) => (
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
        </section>
      )}
    </div>
  );
}
