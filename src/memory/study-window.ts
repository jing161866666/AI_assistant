/**
 * 偏好时段（`habit.key`）的统一解析。
 *
 * 为什么单独成文件：同一个 key 有两处读——画像注入（`memory/habit-manual.ts`）和
 * 排期（`schedule/service.ts`）。以前两处各写一份正则，规则还不一样，结果：
 *   - 用户手填的全角冒号「14：00-16：00」两种正则都不认 → 画像里被静默丢掉；
 *   - 模型产出的「时段:21-24」两种正则都不认 → 排期永远用不上。
 * 现在只在这里解析，两处共用；解析不出来才返回 null，由调用方决定怎么提示。
 */

export interface ParsedWindow {
  /** 规范化后的开始，HH:MM */
  start: string;
  /** 规范化后的结束，HH:MM；24:00 表示次日零点 */
  end: string;
  startMin: number;
  /** 分钟数，0–1440 */
  endMin: number;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 分钟数 → HH:MM（1440 → 24:00） */
export function formatMinute(min: number): string {
  return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
}

/**
 * 归一化成 `HH:MM-HH:MM` 的形状，容忍用户和模型的各种写法：
 *   全角数字/冒号、各类破折号与「至/到」、「21点」、以及「时段:」这种标签前缀。
 */
function normalize(raw: string): string {
  return (
    raw
      .trim()
      // 全角数字 → 半角
      .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      // 全角冒号 → 半角
      .replace(/\uFF1A/g, ":")
      // 各种连字符/破折号/波浪号一律当分隔符（含全角减号、波浪破折号）
      .replace(/[\uFF0D\uFF5E\u2010-\u2015\u2212\uFE58\uFE63~\u301C]/g, "-")
      .replace(/[至到]/g, "-")
      // 「21点 / 21时」→ 21（仅当后面不是数字，避免把「8点30」啃成 830）
      .replace(/(\d)[点时](?=\D|$)/g, "$1")
      .replace(/\s+/g, "")
      // 去掉「时段:」「时间：」这类标签前缀（前缀里不能有数字，否则是真时间）
      .replace(/^[^\d:]+:/, "")
      .replace(/^:+/, "")
  );
}

const WINDOW = /^(\d{1,2})(?::(\d{1,2}))?-(\d{1,2})(?::(\d{1,2}))?$/;

/**
 * 解析一个偏好时段的 key。
 * 支持：`14:00-16:00` / `21:00~24:00` / `8-9` / `21点-23点` / `时段:21-24` / 全角冒号。
 * 跨午夜（如 `22:00-01:00`）不算可排时段，返回 null，不自行猜测。
 */
export function parseWindowKey(raw: string): ParsedWindow | null {
  const m = WINDOW.exec(normalize(raw));
  if (!m) return null;
  const sh = Number(m[1]);
  const sm = m[2] === undefined ? 0 : Number(m[2]);
  const eh = Number(m[3]);
  const em = m[4] === undefined ? 0 : Number(m[4]);
  if (![sh, sm, eh, em].every(Number.isInteger)) return null;
  if (sm > 59 || em > 59) return null;
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  if (startMin >= 24 * 60 || endMin > 24 * 60) return null;
  if (endMin <= startMin) return null;
  return { start: formatMinute(startMin), end: formatMinute(endMin), startMin, endMin };
}
