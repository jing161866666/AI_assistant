import { z } from "zod";
import { llm } from "../llm/client.js";
import { getLlmConfig } from "../llm/models.js";
import { type BankLookup, bankPromptBlock, kindLabel, lookupBank } from "./bank.js";
import { embedQuery, type Hit, type LearnedFilter, retrieve } from "./search.js";

/** 引用上限：前端只展示 3 条，提示词里也只给 3 段，避免模型编号到 [5] 却无出处 */
export const CITATION_LIMIT = 3;

export interface Citation {
  index: number;
  textbook: string;
  chapter: string;
  page: number | null;
  excerpt: string;
}

export function toCitations(hits: Hit[]): Citation[] {
  return hits.slice(0, CITATION_LIMIT).map((h, i) => ({
    index: i + 1,
    textbook: h.textbook,
    chapter: h.chapter,
    page: h.page,
    excerpt: h.text.slice(0, 160),
  }));
}

function buildMaterial(hits: Hit[]): string {
  return hits
    .slice(0, CITATION_LIMIT)
    .map((h, i) => {
      const loc =
        h.page != null ? `${h.textbook} ${h.chapter} 第${h.page}页` : `${h.textbook} ${h.chapter}`;
      return `[${i + 1}] （${loc}）\n${h.text}`;
    })
    .join("\n\n");
}

/**
 * 把文字与图片拼成一条用户消息。
 *
 * 图片直接交给模型，而不是先 OCR 再传文字：
 * 物理题的示意图（光路、受力、电路、波形）一旦 OCR 就彻底丢失，
 * 而 qwen3.8-max 本身能看图（实测正确解出了折射角与板内路程）。
 * 所以原图是真相来源，转录文字只用于检索与存档。
 */
export type ContentParts = Array<
  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
>;

export function userContent(text: string, images?: string[]): string | ContentParts {
  if (!images || images.length === 0) return text;
  return [
    { type: "text", text },
    ...images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
  ];
}

/**
 * 画像前缀。只作用于喂给模型的文本，**不参与检索**——
 * 否则画像里的"第11章""泰勒"等词会污染检索结果。
 */
function withProfile(text: string, profileText?: string): string {
  return profileText ? `${profileText}\n\n${text}` : text;
}

const ASK_SYSTEM = `你是【当前科目】的助教，正在帮助学生复习。科目信息见用户消息开头的【学生画像】与【科目路由】。

规则：
1. 优先依据提供的资料作答。资料里没有的内容，直接说「资料里没有这部分」，再补充你自己的知识并标注「（非资料）」。绝不假装资料里有。
2. 凡是引用资料的地方，用 [1] [2] 这样的编号标注，编号对应资料顺序。
3. 物理/数学公式用行内 LaTeX：$F = k\\frac{q_1 q_2}{r^2}$。
4. 解题时分步骤写清楚：已知 → 求 → 用什么原理 → 代入 → 结果（带单位）。
5. 不要复述资料原文，要转成学生能看懂的解释。
6. 如果【科目路由】判断这道题更像另一门已勾选科目的题，第一句如实说明「这道题更像《X》的内容，我按当前科目资料可能讲不全」，再按题目本身作答；不要因为学生当前选的是这一科就硬把它当这科的题。
7. 篇幅控制在 400 字以内，除非题目需要更详细推导。`;

export interface AskResult {
  answer: string;
  citations: Citation[];
  model: string;
  ms: number;
}

export async function ask(
  file: string,
  question: string,
  k = CITATION_LIMIT,
  images?: string[],
  profileText?: string,
  /** 章节门控：未学章节的正文不进上下文（未设进度时传 null） */
  filter: LearnedFilter = null,
): Promise<AskResult> {
  const t0 = Date.now();
  const hits = await retrieve(file, question, k, undefined, filter);
  const cfg = getLlmConfig("reason");

  if (hits.length === 0) {
    const r = await llm("reason").chat.completions.create({
      model: cfg.model,
      messages: [
        { role: "system", content: ASK_SYSTEM },
        {
          role: "user",
          content: userContent(withProfile(`资料：无\n\n问题：${question}`, profileText), images),
        },
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
        content: userContent(
          withProfile(`资料：\n${buildMaterial(hits)}\n\n问题：${question}`, profileText),
          images,
        ),
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

// ───────────────────────── 不带教材的纯回答 ─────────────────────────

/**
 * 题目不属于用户勾选的任何科目时用这个：**只作答，不引教材、不查题库**。
 *
 * 为什么不去借一门科目的教材：借错了会给出"看起来有引用"的错误答案，
 * 比没有引用更糟。宁可让用户看到"这题不在你勾选的科目里"。
 */
export async function askGeneral(
  question: string,
  images?: string[],
  profileText?: string,
): Promise<AskResult> {
  const t0 = Date.now();
  const cfg = getLlmConfig("reason");
  const r = await llm("reason").chat.completions.create({
    model: cfg.model,
    messages: [
      { role: "system", content: ASK_SYSTEM },
      {
        role: "user",
        content: userContent(
          withProfile(
            `资料：无（这道题不在你勾选的科目里，本次不引用任何教材）\n\n问题：${question}`,
            profileText,
          ),
          images,
        ),
      },
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

// ───────────────────────── 只解题（用户没给答案） ─────────────────────────

const SOLVE_SYSTEM = `你是【当前科目】的老师，正在给学生讲一道题。科目信息见用户消息开头的【学生画像】与【科目路由】。

解题前你会拿到一份【题库检索结果】，它只可能处于下面四种状态之一，必须按对应规则处理：

A. 「命中且有答案」——先完整给出题库解答，再补充你自己的推导。
   你可以在题库解答基础上展开、解释、补全缺失的公式，但不能得出与题库矛盾的结论。
   如果题库解答某一步因为公式缺失而断了，标注「（题库原文此步缺失，以下为补全推导）」后补上。
B. 「命中但题库无答案」——第一句先写「题库收录了这道题（题号 X），但没有提供答案，以下为我的解答」，再求解。
C. 「相似但未确认同题」——先自行核对是不是同一道题；是就采用题库答案并说明判断依据，不是就独立求解并指出与原题的差异。
D. 「未命中」——第一句先写「题库中没有找到这道题，以下依据通用物理知识求解」，再求解。

通用规则：
1. **每一道题都必须给出完整、可独立看懂的过程**：已知 → 求 → 依据的原理/公式 → 代入 → 结果（带单位）。
   推导不得跳步，不得写「同理可得」「略」「过程从略」；每一步都要说明为什么这么做。
   宁可长也不要省——学生看的是过程，不是最终那个数。
2. 涉及教材资料的地方用 [1] [2] [3] 编号标注引用；引用编号只对应【教材资料】，
   不要给题库内容编号。资料里没有依据的结论，不要硬挂编号。
3. 公式用 $...$（行内）或 $$...$$（独立成行）。
4. 如果题目里有【图：...】描述，必须依据该描述理解几何关系，并明确说出你从中读到了什么。
5. 不要评价学生水平，不要说「你应该」。
6. 如果【学生输入】一栏给了内容，说明学生自己写了一部分，可能是答案、可能是过程、也可能是提问：
   - 若学生写的是**过程或思路**：顺着他的思路往下走，指出他这一步为什么成立/不成立，再补完剩余推导。
     不要无视他的写法另起一套，也不要直接判定对错。
   - 若学生写的是**疑问**（问「为什么」「这一步怎么来的」）：先正面回答这个疑问，再给完整解答。
   - 若学生写的是**最终答案**：核对这个答案，指出对错并给出完整推导。
7. 解答末尾必须输出「扩充解析」段（不允许省略、不允许只写一句）：

【扩充解析】
- 考点：（这道题真正在考的原理，2-3 条）
- 易错点：（学生最常见的错误形态，2-3 条，要具体到哪一步容易错）
- 同类型题思路：（下次遇到同类题的入手顺序，2-3 条）`;

export type SolveSource = "bank-answer" | "bank-no-answer" | "model-only";

export interface SolveBankInfo {
  qno: string | null;
  kind: string;
  score: number;
  chapter: string;
  has_answer: boolean;
}

export interface SolveResult {
  answer: string;
  citations: Citation[];
  model: string;
  ms: number;
  /** 答案从哪来：题库有答案 / 题库命中但无答案 / 纯模型 */
  source: SolveSource;
  /** 题库匹配信息；未命中为 null */
  bank: SolveBankInfo | null;
}

/** 详细度：full = 逐步完整推导（默认）；brief = 用户在赶时间时主动选的精简版 */
export type Detail = "full" | "brief";

const DETAIL_BRIEF = `

【篇幅：精简（用户在界面上主动选的）】
只写关键步骤与结论，中间代数可以合并，省略重复展开；扩充解析每项只写 1 条。
总长控制在 600 字以内。`;

/** 检索 + 提示词组装，与「怎么调用模型」拆开：流式与非流式共用同一份提示词 */
export interface SolvePrep {
  system: string;
  userText: string;
  images?: string[];
  maxTokens: number;
  temperature: number;
  source: SolveSource;
  bank: SolveBankInfo | null;
  citations: Citation[];
  model: string;
  /** 用哪个角色的客户端发请求（fast 档可能指向另一家供应商） */
  role: "reason" | "fast";
}

export async function prepareSolve(
  file: string,
  question: string,
  k = CITATION_LIMIT,
  images?: string[],
  /** 学生自己写的过程 / 疑问；不是答案时由调用方转到这条路径，作为提示喂给模型 */
  studentInput?: string,
  profileText?: string,
  detail: Detail = "full",
  /** 章节门控：未学章节的正文不进上下文（未设进度时传 null） */
  filter: LearnedFilter = null,
  /**
   * 速度档：smart = reason 模型（准）；fast = 更快的小模型（用户主动选，接受质量下降）。
   * 判对错不走这条路径——判错代价太高，见 review()。
   */
  speed: "smart" | "fast" = "smart",
): Promise<SolvePrep> {
  // 查询向量只算一次：题库比对与教材检索共用，省掉两次 embedding 往返
  const qv = await embedQuery(question);
  // 两条检索并行：题库决定「答案从哪来」，教材资料决定「扩充解析引用什么」
  const [bank, allHits] = await Promise.all([
    lookupBank(file, question, qv).catch(
      (e: Error): BankLookup => ({
        verdict: "none",
        hit: false,
        score: 0,
        question: null,
        total: 0,
        reason: `题库检索失败：${e.message}`,
      }),
    ),
    retrieve(file, question, k, qv, filter),
  ]);

  // 命中的那道题不要同时出现在教材引用里，否则同一段内容被引用两次
  const hits =
    bank.question && bank.verdict !== "none"
      ? allHits.filter((h) => h.chunkId !== bank.question?.chunkId)
      : allHits;

  // 快答档用 fast 角色（默认 flash 级，也可在 .env 指到别家更快的模型）
  const cfg = getLlmConfig(speed === "fast" ? "fast" : "reason");
  const material = buildMaterial(hits) || "（无匹配教材资料）";
  const hasAnswer = bank.verdict === "same" && bank.question?.answer !== null;
  const prior = studentInput?.trim();
  const prompt = [
    `【题库检索结果】\n${bankPromptBlock(bank)}`,
    `【教材资料】\n${material}`,
    `【用户题目】\n${question}`,
    prior ? `【学生输入（可能不是答案，而是过程或疑问，按规则 6 处理）】\n${prior}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const source: SolveSource =
    !bank.question || bank.verdict === "none"
      ? "model-only"
      : hasAnswer
        ? "bank-answer"
        : "bank-no-answer";

  return {
    system: detail === "brief" ? SOLVE_SYSTEM + DETAIL_BRIEF : SOLVE_SYSTEM,
    userText: withProfile(prompt, profileText),
    images,
    // 要求逐题详细推导，2500 会被截断；精简模式下模型自己就不写长，可以压容量省时间
    maxTokens: detail === "brief" ? 1600 : 4000,
    temperature: 0.2,
    source,
    // 未命中时不要把「最接近的题」透出去：0.7 的余弦只是同科目噪声，
    // 显示在界面上会让用户以为命中了题库原题。
    bank:
      bank.question && bank.verdict !== "none"
        ? {
            qno: bank.question.qno,
            kind: kindLabel(bank.question.kind),
            score: bank.score,
            chapter: bank.question.chapter,
            has_answer: hasAnswer,
          }
        : null,
    citations: toCitations(hits),
    model: cfg.model,
    role: speed === "fast" ? "fast" : "reason",
  };
}

export async function solve(
  file: string,
  question: string,
  k = CITATION_LIMIT,
  images?: string[],
  /** 学生自己写的过程 / 疑问；不是答案时由调用方转到这条路径，作为提示喂给模型 */
  studentInput?: string,
  profileText?: string,
  detail: Detail = "full",
  /** 章节门控：未学章节的正文不进上下文（未设进度时传 null） */
  filter: LearnedFilter = null,
  /** 速度档：smart（默认，准）/ fast（快，用户主动选） */
  speed: "smart" | "fast" = "smart",
): Promise<SolveResult> {
  const t0 = Date.now();
  const p = await prepareSolve(
    file,
    question,
    k,
    images,
    studentInput,
    profileText,
    detail,
    filter,
    speed,
  );

  const role = speed === "fast" ? "fast" : "reason";
  const r = await llm(role).chat.completions.create({
    model: p.model,
    messages: [
      { role: "system", content: p.system },
      { role: "user", content: userContent(p.userText, p.images) },
    ],
    max_tokens: p.maxTokens,
    temperature: p.temperature,
  });

  return {
    answer: r.choices[0]?.message?.content ?? "",
    citations: p.citations,
    model: p.model,
    ms: Date.now() - t0,
    source: p.source,
    bank: p.bank,
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

export const INPUT_KINDS = ["answer", "process", "question", "empty", "unknown"] as const;

export const INPUT_KIND_LABEL: Record<string, string> = {
  answer: "最终答案",
  process: "解题过程 / 思路",
  question: "提问 / 求助",
  empty: "未填写",
  unknown: "无法判断",
};

/**
 * 每个字段都用 .catch() 兜底：模型偶尔会给出枚举外的值（实测答对时返回 "none"），
 * 若整份 schema 一起失败，一条有用的批改结果就被白扔了。
 */
export const reviewSchema = z.object({
  verdict: z.enum(["correct", "partially", "wrong", "unsolved"]).catch("wrong"),
  /** 学生输入到底是答案、过程，还是疑问 —— 由模型判断，不靠关键词 */
  input_kind: z.enum(INPUT_KINDS).catch("unknown"),
  error_type: z.enum(ERROR_TYPES).catch("unknown"),
  cause: z.string().catch(""),
  correction: z.string().catch(""),
  hints: z.array(z.string()).catch([]),
  related_kps: z.array(z.string()).catch([]),
  /** 科目分流：只能填【科目路由】里列出的代码，或 unsure。由代码再做白名单校验 */
  subject_guess: z.string().catch(""),
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

/**
 * 批改的共用规则（判断 + 分流 + 判题 + 详细度要求）。
 * 流式与非流式只在「输出格式」上不同，规则必须完全一致，
 * 否则同一个学生输入在两种模式下会得到不同判定。
 */
const REVIEW_RULES = `你是【当前科目】的批改助教。科目信息见用户消息开头的【学生画像】与【科目路由】。给你一道题、学生输入、以及教材资料。

第一步：判断 input_kind —— 这一步判错会让整份结果都不对。
- "answer"   学生给的是最终答案：一个数值、一个选项、一个表达式、或一句话结论。
- "process"  学生给的是解题过程、推导步骤、思路片段：写了多步但没有明确最终答案，或明确是草稿。
- "question" 学生写的是提问或求助（「这题怎么做」「为什么这一步是这样」），不是答案。
- "empty"    学生什么都没写。

第二步：按 input_kind 分流
- answer   → 执行下面的判题流程。
- process  → verdict 固定 "unsolved"，error_type 固定 "none"，cause 写「你给的是解题过程，已作为提示参考」。
  正文写成「接着你的思路」的完整详细解答：先点评他这一步为什么成立、为什么走不通，
  再补完剩余推导与最终结果，最后给【扩充解析】。不要直接判错，也不要抛开他的写法另起一套。
- question → verdict 固定 "unsolved"，error_type 固定 "none"，cause 写「你问的是思路，已按提问回答」。
  正文先正面回答这个疑问，再给完整详细解答与【扩充解析】。
- empty    → verdict 固定 "unsolved"，error_type "none"，cause 留空，正文给完整详细解答与【扩充解析】。

判题流程（仅 input_kind = "answer" 时执行，严格按顺序）：
1. 先自己独立解出这道题，得到标准答案（含数量级与单位）。
2. 把学生答案与标准答案逐项比对：数值、数量级、单位、符号、方向。
3. 只要有任意一项不一致，verdict 就不能是 "correct"。
   - 公式写对但代入错 → "wrong"，error_type "careless" 或 "unit"
   - 数量级差 10 的整数次幂 → "wrong"，error_type "unit"
   - 概念性误用 → "wrong"，error_type "concept"
4. input_kind = "answer" 时 verdict 只能是 correct / partially / wrong，不许用 "unsolved"。

详细要求（所有分流共用）：
- 正文解答必须步骤完整：已知 → 求 → 依据的原理/公式 → 代入 → 结果（带单位）。
- 禁止写「同理可得」「略」「过程从略」；每一步都要说清依据。宁可长，不要省。
- 公式用 $...$，公式里的引用编号只对应【教材资料】，最多 [1] [2] [3]。`;

const REVIEW_FIELD_SPEC = `- verdict: "correct" | "partially" | "wrong" | "unsolved"
- input_kind: "answer" | "process" | "question" | "empty" | "unknown"
- error_type: "none" | "concept" | "misread" | "boundary" | "formula" | "unit" | "logic" | "careless" | "unknown"
  ⚠ 只有 verdict 为 "correct" 或 "unsolved" 时才能用 "none"；否则必须给出具体错因，不要自造其他值。
- cause: 一句话说清（50 字内）
- correction: 完整详细解答（不限字数，含【扩充解析】：考点 / 易错点 / 同类型题思路）
- hints: 字符串数组，1-3 条，下次遇到同类题要注意什么
- related_kps: 字符串数组，相关知识点名称，2-4 个
- subject_guess: 从【科目路由】的候选代码里选一个最可能属于的科目代码；都不像填 "unsure"。
  ⚠ 不要因为当前科目就是它，就默认这道题属于当前科目；这道题可能是别的科目的。`;

const REVIEW_SYSTEM = `${REVIEW_RULES}

只输出 JSON，不要任何解释文字。字段：
${REVIEW_FIELD_SPEC}`;

/**
 * 流式版本的输出格式：第 1 行一个 META JSON，第 2 行起是正文。
 * 这样一次调用就能既拿到结构化判定（先到，界面立刻显示徽标），
 * 又能把正文边生成边打出来（用户不用等 3 分钟才看到第一个字）。
 */
const REVIEW_STREAM_SYSTEM = `${REVIEW_RULES}

输出格式（流式，必须严格遵守，否则前端解析不出来）：
第 1 行只放一个 JSON，用 [[META]] 开头、[[/META]] 结尾，例如：
[[META]]{"verdict":"unsolved","input_kind":"process","error_type":"none","cause":"你给的是解题过程，已作为提示参考","hints":["先写受力分析"],"related_kps":["牛顿第二定律","匀变速直线运动"],"subject_guess":"PHY2"}[[/META]]
从第 2 行开始直接输出正文（Markdown + LaTeX），正文相当于 correction，
必须完整、逐步、结尾含【扩充解析】。正文里不要再重复 META 或 JSON，也不要包代码块围栏。
META 字段：
${REVIEW_FIELD_SPEC.replace("- correction: 完整详细解答（不限字数，含【扩充解析】：考点 / 易错点 / 同类型题思路）", "- correction 不出现在 META 里：它就是你接下来输出的正文")}`;

/** 批改的检索 + 用户消息组装（流式与非流式共用） */
interface ReviewPrepBase {
  userText: string;
  images?: string[];
  citations: Citation[];
  model: string;
}

async function prepareReviewBase(
  file: string,
  question: string,
  myAnswer: string,
  correctAnswer?: string,
  images?: string[],
  profileText?: string,
  filter: LearnedFilter = null,
): Promise<ReviewPrepBase> {
  const hits = await retrieve(
    file,
    `${question} ${myAnswer}`.slice(0, 400),
    CITATION_LIMIT,
    undefined,
    filter,
  );
  const cfg = getLlmConfig("reason");
  const user = [
    `题目：${question}`,
    `学生输入：\n${myAnswer || "（空）"}`,
    correctAnswer ? `参考答案：${correctAnswer}` : "",
    `资料：\n${buildMaterial(hits)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    userText: withProfile(user, profileText),
    images,
    citations: toCitations(hits),
    model: cfg.model,
  };
}

export interface ReviewPrep extends ReviewPrepBase {
  system: string;
  maxTokens: number;
  temperature: number;
}

export async function prepareReviewStream(
  file: string,
  question: string,
  myAnswer: string,
  correctAnswer?: string,
  images?: string[],
  profileText?: string,
  detail: Detail = "full",
  filter: LearnedFilter = null,
): Promise<ReviewPrep> {
  const base = await prepareReviewBase(
    file,
    question,
    myAnswer,
    correctAnswer,
    images,
    profileText,
    filter,
  );
  return {
    ...base,
    system: detail === "brief" ? REVIEW_STREAM_SYSTEM + DETAIL_BRIEF : REVIEW_STREAM_SYSTEM,
    maxTokens: detail === "brief" ? 1600 : 4000,
    // 判对错不能有采样随机性，否则同一个答案两次判出不同结论
    temperature: 0,
  };
}

export async function review(
  file: string,
  question: string,
  myAnswer: string,
  correctAnswer?: string,
  images?: string[],
  profileText?: string,
  detail: Detail = "full",
  filter: LearnedFilter = null,
): Promise<ReviewResult> {
  const base = await prepareReviewBase(
    file,
    question,
    myAnswer,
    correctAnswer,
    images,
    profileText,
    filter,
  );
  const r = await llm("reason").chat.completions.create({
    model: base.model,
    messages: [
      {
        role: "system",
        content: detail === "brief" ? REVIEW_SYSTEM + DETAIL_BRIEF : REVIEW_SYSTEM,
      },
      { role: "user", content: userContent(base.userText, base.images) },
    ],
    // 详细解答 + JSON 包装，1200 会截断成半截 JSON
    max_tokens: detail === "brief" ? 1600 : 4000,
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
      input_kind: "unknown",
      error_type: "unknown",
      cause: "模型返回的结构无法解析",
      correction: "",
      hints: [],
      related_kps: [],
      subject_guess: "",
    };
  }
  return { ...parsed, references: base.citations, raw };
}
