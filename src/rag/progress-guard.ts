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

export interface GuardResult {
  beyond: BeyondItem[];
  allWithin: boolean;
}

const GUARD_SYSTEM = `你在做一次"教材进度越界检查"。只判断，不解题、不评价答案对错。

会先给你**本课程教材的真实章节表**。方法的章节归属只能依据这张表，不许凭想象。
如果表里查不到对应章节，chapter_no 给 null，并且不要把它算作越界（存疑不算越界）。

输出 JSON：
{
  "beyond": [{"topic": "方法名", "chapter_no": 章节号(取自章节表,查不到为null), "why": "为什么算越界,20字内"}],
  "all_within": true/false
}

判定规则：
- 解答里用到的方法/定理，若其章节号 > 学生已学上限 → 计入 beyond
- 只用章节表内 ≤ 上限的内容，或用到了表外但无法定位的常识性初等运算 → 不计入
- 同一方法只列一次
- 不要因为"显式写了公式"就判越界，要看这个公式属于哪一章`;

/**
 * @param maxChapter 学生已学到的章节上限；null 表示未设置进度，直接跳过
 * @param outline    教材真实章节表；为空时退化为"存疑不判"
 */
export async function guardProgress(
  question: string,
  answer: string,
  maxChapter: number | null,
  outline: ChapterOutlineItem[] = [],
): Promise<GuardResult> {
  if (maxChapter == null) return { beyond: [], allWithin: true };
  if (outline.length === 0) {
    // 没有章节表就无法可靠判定，宁可不判，也不误报
    console.error("[guard] 缺少章节表，跳过越界检查");
    return { beyond: [], allWithin: true };
  }
  const cfg = getLlmConfig("extract");

  try {
    const r = await llm("extract").chat.completions.create({
      model: cfg.model,
      messages: [
        { role: "system", content: GUARD_SYSTEM },
        {
          role: "user",
          content: [
            `【本课程教材章节表】\n${outlinePrompt(outline)}`,
            `【学生已学】第 1–${maxChapter} 章（第 ${maxChapter + 1} 章及以后未学）`,
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
    const valid = new Set(outline.map((o) => o.chapterNo));
    // 只保留章节表里真实存在、且确实超过进度的项
    const beyond = parsed.beyond
      .filter((b) => b.topic.trim().length > 0)
      .filter((b) => b.chapter_no != null && valid.has(b.chapter_no))
      .filter((b) => (b.chapter_no ?? 0) > maxChapter);
    return { beyond, allWithin: beyond.length === 0 };
  } catch (e) {
    console.error("[guard] 越界检查失败:", (e as Error).message);
    return { beyond: [], allWithin: true };
  }
}
