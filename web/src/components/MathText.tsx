import katex from "katex";
import { type ReactNode, useMemo } from "react";

/**
 * 渲染模型输出的轻量排版。
 *
 * 模型输出公式的写法并不统一，实测同一次回答里同时出现：
 *   \[ ... \]   \( ... \)   $$...$$   $...$
 * 所以必须先整体抽取公式（可能跨行），换成占位符，再做按行解析。
 * 否则跨行的 \[ ... \] 会被按行切断，公式碎成源码。
 */

interface MathTok {
  tex: string;
  display: boolean;
}

const MATH_RE = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^$\n]+?\$)/g;
const TOKEN_RE = /(⟦M\d+⟧)|(\*\*[^*]+\*\*)|(\[\d+\])/g;

function extractMath(text: string): { text: string; tokens: Map<string, MathTok> } {
  const tokens = new Map<string, MathTok>();
  let i = 0;
  const out = text.replace(MATH_RE, (m) => {
    let tex = m;
    let display = false;
    if (m.startsWith("$$")) tex = m.slice(2, -2);
    else if (m.startsWith("\\[")) {
      tex = m.slice(2, -2);
      display = true;
    } else if (m.startsWith("\\(")) tex = m.slice(2, -2);
    else tex = m.slice(1, -1);
    const key = `⟦M${i++}⟧`;
    tokens.set(key, { tex: tex.trim(), display });
    return key;
  });
  return { text: out, tokens };
}

function renderInline(text: string, tokens: Map<string, MathTok>, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null = TOKEN_RE.exec(text);
  while (m) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyPrefix}-${n++}`;
    const mathTok = tokens.get(tok);
    if (mathTok) {
      try {
        out.push(
          <span
            key={key}
            className={mathTok.display ? "math math-display" : "math"}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX 输出为受控 HTML
            dangerouslySetInnerHTML={{
              __html: katex.renderToString(mathTok.tex, {
                throwOnError: false,
                displayMode: mathTok.display,
              }),
            }}
          />,
        );
      } catch {
        out.push(tok);
      }
    } else if (tok.startsWith("**")) {
      out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    } else {
      out.push(
        <sup key={key} className="cite">
          {tok}
        </sup>,
      );
    }
    last = m.index + tok.length;
    m = TOKEN_RE.exec(text);
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export default function MathText({ text }: { text: string }) {
  const nodes = useMemo(() => {
    const { text: plain, tokens } = extractMath(text);
    const lines = plain.split(/\r?\n/);
    const blocks: ReactNode[] = [];
    let list: string[] = [];

    const flush = (): void => {
      if (list.length === 0) return;
      const items = list;
      blocks.push(
        <ul className="mdlist" key={`ul-${blocks.length}`}>
          {items.map((item, i) => (
            <li key={`li-${blocks.length}-${i}`}>
              {renderInline(item, tokens, `li${blocks.length}-${i}`)}
            </li>
          ))}
        </ul>,
      );
      list = [];
    };

    lines.forEach((line, idx) => {
      const t = line.trim();
      if (t.startsWith("- ") || t.startsWith("• ")) {
        list.push(t.slice(2));
        return;
      }
      flush();
      if (t === "") {
        blocks.push(<div className="mdgap" key={`g-${idx}`} />);
        return;
      }
      // 只有独占一行的块级公式时，用 div 承载，避免 p 里塞 display 公式
      const onlyMath = /^⟦M\d+⟧$/.test(t) && tokens.get(t)?.display;
      if (onlyMath) {
        blocks.push(
          <div className="mdformula" key={`f-${idx}`}>
            {renderInline(t, tokens, `f${idx}`)}
          </div>,
        );
        return;
      }
      blocks.push(<p key={`p-${idx}`}>{renderInline(line, tokens, `p${idx}`)}</p>);
    });
    flush();
    return blocks;
  }, [text]);

  return <div className="md">{nodes}</div>;
}
