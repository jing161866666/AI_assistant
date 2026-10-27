import { useState } from "react";
import { api } from "../api.ts";
import ImageInput from "../components/ImageInput.tsx";
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
  const [images, setImages] = useState<string[]>([]);
  const [res, setRes] = useState<AskResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (text?: string): Promise<void> => {
    const question = (text ?? q).trim();
    if (!question && images.length === 0) {
      setErr("请文字提问，或上传题目图片");
      return;
    }
    setBusy(true);
    setErr(null);
    setRes(null);
    try {
      setRes(await api.ask(question, images));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <section className="panel">
        <h2>问教材 / 解题</h2>
        <p className="hint">
          可以直接贴题图。图片先交给视觉模型转录（公式转 LaTeX、图形转文字描述）用于检索，
          <b>原图本身也会交给推理模型</b>——所以即使转录有偏差，答案仍以图为准。
        </p>

        <ImageInput
          kind="question"
          label="题目图片"
          onImages={setImages}
          onText={(t) => setQ((prev) => (prev.trim() ? `${t}\n\n${prev}` : t))}
        />

        <textarea
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="或直接输入题目 / 疑问。图片识别后可在这里继续修改。"
          rows={5}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void submit();
          }}
        />
        <div className="row">
          <button type="button" className="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? "思考中…（看图约 30-50 秒）" : "提问（Ctrl+Enter）"}
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
