import { z } from "zod";
import { llm } from "../llm/client.js";
import { getLlmConfig } from "../llm/models.js";
import { type ChapterOutlineItem, outlinePrompt } from "./chapter-outline.js";

/**
 * 越界检查：答案生成之后、返回用户之前，判断有没有用到"还没学"的知识。
 *
 * 为什么要单独一步：提示词里写"不要用泰勒公式"不可靠，模型会忘、会绕过。
 * 为什么必须喂章节表：章节归属是先验知识。实测不给章节表时，模型会把握差
 * 章节（把"光程差"猜成第 12 章，实际在第 11 章），导致误报越界。
 *
 * M2 起判定基准从「已学上限」改为**已学集合**：学到第 11 章不等于学过第 12 章，
 * 也不等于学过被跳过的第 10 章（断层章节必须算未学）。
 */

export const guardSchema = z.object({
  beyond: z
    .array(
      z.object({
        topic: z.string().catch(""),
        chapter_no: z.number().nullable().catch(null),
        why: z.string().catch(""),
      }),
    )
    .catch([]),
  all_within: z.boolean().catch(true),
});

export interface BeyondItem {
  topic: string;
  chapter_no: number | null;
  why: string;
}

/** 检查状态：调用方要把它透给前端，`no-outline` 意味着这道闸这次没生效 */
export type GuardStatus = "ok" | "no-progress" | "no-outline" | "failed";

export interface GuardResult {
  /** 章节表里能定位、且确实没学过的：确定越界 */
  beyond: BeyondItem[];
  /**
   * 模型认为越界、但章节表里定位不到章节的：**不能当确定越界，也不能当没发生**。
   * 之前这种项被静默丢掉，于是「模型说有越界」被过滤成「系统说全部在范围内」。
   */
  uncertain: BeyondItem[];
  allWithin: boolean;
  guard: GuardStatus;
}

/**
 * 过滤 + 分类（纯函数，不调模型，可单测）。
 *
 * 规则：
 *   1) 章节号在表里、且不在已学集合 → beyond（确定越界）
 *   2) 章节号定位不到（null / 表外）→ uncertain（存疑，只在模型整体判定"有越界"时才提示）
 *   3) 章节号在已学集合 → 丢弃（学过的不算越界，哪怕学生是跳着学的）
 *   4) 模型说 all_within=true 时，存疑项不进 uncertain：尊重模型的整体结论，避免过度报警
 */
export function classifyBeyond(
  items: BeyondItem[],
  modelAllWithin: boolean,
  learned: Set<number>,
  outline: ChapterOutlineItem[],
): { beyond: BeyondItem[]; uncertain: BeyondItem[]; allWithin: boolean } {
  const valid = new Set(outline.map((o) => o.chapterNo));
  const beyond: BeyondItem[] = [];
  const unlocated: BeyondItem[] = [];

  for (const b of items) {
    const topic = b.topic.trim();
    if (!topic) continue;
    if (b.chapter_no != null && valid.has(b.chapter_no)) {
      if (!learned.has(b.chapter_no)) beyond.push({ ...b, topic });
    } else {
      unlocated.push({ ...b, topic, chapter_no: null });
    }
  }

  // 模型明确说"不是全部在范围内"，却一条都定位不到：不能静默判为无越界
  const uncertain = modelAllWithin ? [] : unlocated;
  return { beyond, uncertain, allWithin: beyond.length === 0 && uncertain.length === 0 };
}

const GUARD_SYSTEM = `你在做一次"教材进度越界检查"。只判断，不解题、不评价答案对错。

会先给你**本课程教材的真实章节表**，以及学生**已学章节的准确清单**。
方法的章节归属只能依据这张表，不许凭想象。
如果表里查不到对应章节，chapter_no 给 null，并且不要把它算作越界（存疑不算越界）。

输出 JSON：
{
  "beyond": [{"topic": "方法名", "chapter_no": 章节号(取自章节表,查不到为null), "why": "为什么算越界,20字内"}],
  "all_within": true/false
}

判定规则：
- 解答里用到的方法/定理，若其章节**不在已学清单里** → 计入 beyond。注意已学可能不连续：学生跳过没学的章节同样算越界。
- 只用已学清单内的内容，或用到了表外但无法定位的常识性初等运算 → 不计入
- 同一方法只列一次
- 不要因为"显式写了公式"就判越界，要看这个公式属于哪一章`;

const fmtChapters = (list: number[]): string =>
  list.length === 0 ? "（空）" : list.map((n) => `第${n}章`).join("、");

/**
 * @param learned 已学章节集合；`null` = 未设置进度，直接跳过检查
 * @param outline 教材真实章节表；为空时退化为"存疑不判"，并标记 no-outline
 */
export async function guardProgress(
  question: string,
  answer: string,
  learned: Set<number> | null,
  outline: ChapterOutlineItem[] = [],
): Promise<GuardResult> {
  if (!learned || learned.size === 0) {
    return { beyond: [], uncertain: [], allWithin: true, guard: "no-progress" };
  }
  if (outline.length === 0) {
    // 没有章节表就无法可靠判定：宁可不判，也不误报；但必须让调用方知道这道闸没生效
    console.error("[guard] 缺少章节表，越界检查未生效");
    return { beyond: [], uncertain: [], allWithin: true, guard: "no-outline" };
  }
  const cfg = getLlmConfig("extract");
  const learnedSorted = [...learned].sort((a, b) => a - b);
  const unlearned = outline.map((o) => o.chapterNo).filter((n) => !learned.has(n));

  try {
    const r = await llm("extract").chat.completions.create({
      model: cfg.model,
      messages: [
        { role: "system", content: GUARD_SYSTEM },
        {
          role: "user",
          content: [
            `【本课程教材章节表】\n${outlinePrompt(outline)}`,
            `【学生已学】${fmtChapters(learnedSorted)}`,
            `【学生未学】${fmtChapters(unlearned)}`,
            `【题目】\n${question.slice(0, 1200)}`,
            `【解答】\n${answer.slice(0, 3000)}`,
          ].join("\n\n"),
        },
      ],
      max_tokens: 500,
      temperature: 0,
      response_format: { type: "json_object" },
    });

    const raw = r.choices[0]?.message?.content ?? "{}";
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    const json = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
    const parsed = guardSchema.parse(JSON.parse(json));
    const { beyond, uncertain, allWithin } = classifyBeyond(
      parsed.beyond,
      parsed.all_within,
      learned,
      outline,
    );
    if (uncertain.length > 0) {
      console.warn(
        `[guard] ${uncertain.length} 项被判越界但定位不到章节: ${uncertain.map((u) => u.topic).join("、")}`,
      );
    }
    return { beyond, uncertain, allWithin, guard: "ok" };
  } catch (e) {
    console.error("[guard] 越界检查失败:", (e as Error).message);
    return { beyond: [], uncertain: [], allWithin: true, guard: "failed" };
  }
}
