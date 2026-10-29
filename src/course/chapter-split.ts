/**
 * 教材正文切章与切片（纯函数，可单测，不碰 DB / 不调模型）。
 *
 * 为什么单独成模块：build-course.ts 是 CLI，一 import 就会执行建库流程；
 * 章切分是它最容易出错的一环，必须能单独测。
 */

const CN_DIGIT: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 中文章号 → 整数（十一 → 11，二十 → 20） */
export function cnNumber(raw: string): number | null {
  const s = raw.replace(/\s+/g, "");
  if (/^\d+$/.test(s)) return Number(s);
  let total = 0;
  let cur = 0;
  for (const ch of s) {
    if (ch === "十") {
      total += (cur || 1) * 10;
      cur = 0;
    } else if (ch === "百") {
      total += (cur || 1) * 100;
      cur = 0;
    } else if (ch in CN_DIGIT) {
      cur = CN_DIGIT[ch]!;
    } else {
      return null;
    }
  }
  return total + cur;
}

const CHAPTER_RE = /^\s*第\s*([一二两三四五六七八九十百零0-9]+)\s*章\s*(.*)$/;
/** 章节内的小节号：§2.1 / § 1.3（目录里也有，要排除） */
const SECTION_RE = /^\s*§\s*([0-9]{1,2})\s*[.．]\s*([0-9]{1,2})/;
/** 目录行：结尾是页码，或带制表符 */
const TOC_LINE_RE = /(\t|\s{2,})[\s.]*\d{1,4}\s*$/;

export interface ChapterBody {
  no: number;
  title: string;
  text: string;
}

/** 从所有「第N章 标题」行里取章名（目录行更干净；正文标题可能是 "-" 或图片） */
function chapterTitles(lines: string[]): Map<number, string> {
  const titles = new Map<number, string>();
  for (const line of lines) {
    const m = CHAPTER_RE.exec(line.trim());
    if (!m) continue;
    const no = cnNumber(m[1]!);
    if (no == null) continue;
    const title = m[2]!
      .replace(/(\t|\s{2,})[\s.]*\d{1,4}\s*$/, "")
      .replace(/[\t.\s]+$/, "")
      .replace(/\s+/g, "")
      .trim();
    // 优先中文标题；"-"、"1" 这类残缺标题不采用
    const good = /[\u4e00-\u9fa5]{2,}/.test(title);
    const cur = titles.get(no);
    if (!cur || (good && cur.length < title.length)) titles.set(no, title);
  }
  return titles;
}

/**
 * 切章：三种情况按可靠性依次尝试。
 *
 * 1) **按小节号 §N.M 切**（最可靠）。教材正文标题常是图片或样式丢失（本项目实测
 *    第 1/4/5 章标题在 docx 里根本不存在），但小节号一定在正文里。
 *    §4.3 → 第 4 章，章号从正文自动恢复，不靠标题。
 * 2) 按「第N章」标题切（没有小节号的书）。
 * 3) 都不行 → 返回空，调用方按"整本不参与门控"处理。
 *
 * 章名优先取目录行（"第一章 随机事件及其概率 …… 1"），正文标题只作补充。
 */
export function splitChapters(text: string): ChapterBody[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const titles = chapterTitles(lines);

  // ── 1) 小节号切章 ──
  const sectionMarks: Array<{ line: number; no: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = SECTION_RE.exec(line.trim());
    if (!m) continue;
    if (TOC_LINE_RE.test(line)) continue; // 跳过目录行
    const no = Number(m[1]);
    if (no < 1 || no > 99) continue;
    sectionMarks.push({ line: i, no });
  }
  const distinct = new Set(sectionMarks.map((m) => m.no));
  if (distinct.size >= 2) {
    const byChapter = new Map<number, string[]>();
    for (let i = 0; i < sectionMarks.length; i++) {
      const start = sectionMarks[i]!.line;
      const end = i + 1 < sectionMarks.length ? sectionMarks[i + 1]!.line : lines.length;
      const no = sectionMarks[i]!.no;
      const body = lines.slice(start, end).join("\n").trim();
      byChapter.set(no, [...(byChapter.get(no) ?? []), body]);
    }
    const out: ChapterBody[] = [];
    for (const [no, parts] of [...byChapter.entries()].sort((a, b) => a[0] - b[0])) {
      const body = parts.join("\n\n").trim();
      if (body.length < 120) continue;
      out.push({ no, title: titles.get(no) || `第${no}章`, text: body });
    }
    if (out.length >= 2) return out;
  }

  // ── 2) 按章标题切 ──
  const marks: Array<{ line: number; no: number; title: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = CHAPTER_RE.exec(lines[i]!.trim());
    if (!m) continue;
    const no = cnNumber(m[1]!);
    if (no == null || no < 1 || no > 99) continue;
    const title = titles.get(no) || m[2]!.replace(/[\t.．…\s]+\d*\s*$/, "").trim();
    marks.push({ line: i, no, title: title || `第${no}章` });
  }
  if (marks.length === 0) return [];

  const segments: ChapterBody[] = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i]!.line;
    const end = i + 1 < marks.length ? marks[i + 1]!.line : lines.length;
    segments.push({
      no: marks[i]!.no,
      title: marks[i]!.title,
      text: lines.slice(start, end).join("\n").trim(),
    });
  }
  const best = new Map<number, ChapterBody>();
  for (const seg of segments) {
    const cur = best.get(seg.no);
    if (!cur || seg.text.length > cur.text.length) {
      best.set(seg.no, { ...seg, title: titles.get(seg.no) || seg.title });
    }
  }
  return [...best.values()].sort((a, b) => a.no - b.no);
}

/** 按段落切成 ~700 字的片段，保留段落边界 */
export function chunkText(text: string, max = 700): string[] {
  const paras = text
    .split(/\n+/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);
  const out: string[] = [];
  let buf = "";
  for (const p of paras) {
    if (buf.length + p.length + 1 > max && buf.length >= 200) {
      out.push(buf);
      buf = "";
    }
    buf = buf ? `${buf}\n${p}` : p;
    if (buf.length >= max * 2) {
      out.push(buf);
      buf = "";
    }
  }
  if (buf.length >= 120) out.push(buf);
  return out;
}
