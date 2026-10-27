import { z } from "zod";
import { llm } from "../llm/client.js";
import { getLlmConfig } from "../llm/models.js";
import { type Hit, retrieve } from "./search.js";

export interface Citation {
  index: number;
  textbook: string;
  chapter: string;
  page: number | null;
  excerpt: string;
}

function toCitations(hits: Hit[]): Citation[] {
  return hits.map((h, i) => ({
    index: i + 1,
    textbook: h.textbook,
    chapter: h.chapter,
    page: h.page,
    excerpt: h.text.slice(0, 160),
  }));
}

function buildMaterial(hits: Hit[]): string {
  return hits
    .map((h, i) => {
      const loc =
        h.page != null ? `${h.textbook} ${h.chapter} 第${h.page}页` : `${h.textbook} ${h.chapter}`;
      return `[${i + 1}] （${loc}）\n${h.text}`;
    })
    .join("\n\n");
}

const ASK_SYSTEM = `你是东南大学「大学物理(B)II」课程的助教，正在帮助学生复习。

规则：
1. 优先依据提供的资料作答。资料里没有的内容，直接说「资料里没有这部分」，再补充你自己的知识并标注「（非资料）」。绝不假装资料里有。
2. 凡是引用资料的地方，用 [1] [2] 这样的编号标注，编号对应资料顺序。
3. 物理公式用行内 LaTeX：$F = k\\frac{q_1 q_2}{r^2}$。
4. 解题时分步骤写清楚：已知 → 求 → 用什么原理 → 代入 → 结果（带单位）。
5. 不要复述资料原文，要转成学生能看懂的解释。
6. 篇幅控制在 400 字以内，除非题目需要更详细推导。`;

export interface AskResult {
  answer: string;
  citations: Citation[];
  model: string;
  ms: number;
}

export async function ask(file: string, question: string, k = 6): Promise<AskResult> {
  const t0 = Date.now();
  const hits = await retrieve(file, question, k);
  const cfg = getLlmConfig("reason");

  if (hits.length === 0) {
    const r = await llm("reason").chat.completions.create({
      model: cfg.model,
      messages: [
        { role: "system", content: ASK_SYSTEM },
        { role: "user", content: `资料：无\n\n问题：${question}` },
      ],
      max_tokens: cfg.maxTokens,
      temperature: cfg.temperature,
    });
    return {
      answer: r.choices[0]?.message?.content ?? "",
      citations: [],
      model: cfg.model,
      ms: Date.now() - t0,
    };
  }

  const r = await llm("reason").chat.completions.create({
    model: cfg.model,
    messages: [
      { role: "system", content: ASK_SYSTEM },
      {
        role: "user",
        content: `资料：\n${buildMaterial(hits)}\n\n问题：${question}`,
      },
    ],
    max_tokens: cfg.maxTokens,
    temperature: cfg.temperature,
  });

  return {
    answer: r.choices[0]?.message?.content ?? "",
    citations: toCitations(hits),
    model: cfg.model,
    ms: Date.now() - t0,
  };
}

// ───────────────────────── 改错 ─────────────────────────

export const ERROR_TYPES = [
  "none",
  "concept",
  "misread",
  "boundary",
  "formula",
  "unit",
  "logic",
  "careless",
  "unknown",
] as const;

/**
 * 每个字段都用 .catch() 兜底：模型偶尔会给出枚举外的值（实测答对时返回 "none"），
 * 若整份 schema 一起失败，一条有用的批改结果就被白扔了。
 */
export const reviewSchema = z.object({
  verdict: z.enum(["correct", "partially", "wrong"]).catch("wrong"),
  error_type: z.enum(ERROR_TYPES).catch("unknown"),
  cause: z.string().catch(""),
  correction: z.string().catch(""),
  hints: z.array(z.string()).catch([]),
  related_kps: z.array(z.string()).catch([]),
});

export type ReviewResult = z.infer<typeof reviewSchema> & {
  references: Citation[];
  raw: string;
};

const ERROR_TYPE_LABEL: Record<string, string> = {
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

export function errorTypeLabel(k: string): string {
  return ERROR_TYPE_LABEL[k] ?? k;
}

/** 去掉 ```json 围栏，并截取第一个完整的 JSON 对象 */
function stripFence(s: string): string {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? s).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start >= 0 && end > start) return body.slice(start, end + 1);
  return body;
}

const REVIEW_SYSTEM = `你是大学物理课的批改助教。给你一道题、学生的作答、以及教材资料，请判断对错并归因。

判题流程（必须严格按顺序执行）：
1. 先自己独立解出这道题，得到标准答案（含数量级与单位）。
2. 把学生答案与标准答案逐项比对：数值、数量级、单位、符号、方向。
3. 只要有任意一项不一致，verdict 就不能是 "correct"。
   - 公式写对但代入错 → "wrong"，error_type "careless" 或 "unit"
   - 数量级差 10 的整数次幂 → "wrong"，error_type "unit"
   - 概念性误用 → "wrong"，error_type "concept"

只输出 JSON，不要任何解释文字。字段：
- verdict: "correct" | "partially" | "wrong"
- error_type: "none" | "concept" | "misread" | "boundary" | "formula" | "unit" | "logic" | "careless" | "unknown"
  ⚠ 只有 verdict 为 "correct" 时才能用 "none"；否则必须给出具体错因，不要自造其他值。
- cause: 一句话说清错在哪一步（50 字内）
- correction: 标准答案与关键推导（150 字内，公式用 $...$）
- hints: 字符串数组，1-3 条，下次遇到同类题要注意什么
- related_kps: 字符串数组，相关知识点名称，2-4 个`;

export async function review(
  file: string,
  question: string,
  myAnswer: string,
  correctAnswer?: string,
): Promise<ReviewResult> {
  const hits = await retrieve(file, `${question} ${myAnswer}`.slice(0, 400), 4);
  // 判对错需要推理能力，用 reason 角色；extract 角色（flash 级）实测会把
  // 数量级错 1000 倍的答案判成 correct。
  const cfg = getLlmConfig("reason");

  const user = [
    `题目：${question}`,
    `学生作答：${myAnswer}`,
    correctAnswer ? `参考答案：${correctAnswer}` : "",
    `资料：\n${buildMaterial(hits)}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const r = await llm("reason").chat.completions.create({
    model: cfg.model,
    messages: [
      { role: "system", content: REVIEW_SYSTEM },
      { role: "user", content: user },
    ],
    max_tokens: 1200,
    temperature: 0,
    response_format: { type: "json_object" },
  });

  const raw = r.choices[0]?.message?.content ?? "{}";
  let parsed: z.infer<typeof reviewSchema>;
  try {
    parsed = reviewSchema.parse(JSON.parse(stripFence(raw)));
  } catch (e) {
    console.error("[review] 结构解析失败:", (e as Error).message, "| raw:", raw.slice(0, 300));
    parsed = {
      verdict: "wrong",
      error_type: "unknown",
      cause: "模型返回的结构无法解析",
      correction: "",
      hints: [],
      related_kps: [],
    };
  }
  return { ...parsed, references: toCitations(hits), raw };
}
