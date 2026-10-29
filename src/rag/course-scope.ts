import type { DatabaseSync } from "node:sqlite";
import { gapsOf, loadProfile, progressFilter } from "../memory/profile.js";
import {
  getSubject,
  normalizeCourseCode,
  textbookFileOf,
  textbookMeta,
} from "../memory/subjects.js";
import type { CourseSource } from "./search.js";

/**
 * 一次请求到底该打开哪些科目的知识库。
 *
 * 这里是"要不要调用多科目知识库"的**唯一判断点**，别在别处再写一套：
 *   - 问教材 / 改错 / 图片识别 → **只调用当前科目**的知识库。跨科检索会把高数的
 *     结论塞进物理答案，且两科进度不同，门控没法共用。
 *   - 学习路径 / 排期 / 举一反三 → 允许跨科目：每个科目各用各的教材库，
 *     门控也各用各的已学章节（拿物理进度去过滤高数切片，两种结果都是错的）。
 *
 * 判断是纯代码（可断言），模型不参与"要不要跨科目"的决定。
 */

export type CourseIntent = "ask" | "review" | "extract" | "plan" | "roadmap" | "exercise";

/** 这些功能天然只面对一道题/一科教材，必须单科目 */
const SINGLE_SUBJECT_INTENTS: ReadonlySet<CourseIntent> = new Set(["ask", "review", "extract"]);

export type ScopeSubjectStatus = "ready" | "no-textbook" | "unregistered";

export interface ScopeSubject {
  code: string;
  name: string;
  registered: boolean;
  status: ScopeSubjectStatus;
  /** 教材库文件名；null = 还没构建 */
  file: string | null;
  /** 可按章节门控的章节数 */
  chapters: number;
  /** 该科目自己的已学上限；null = 还没设进度 */
  maxChapterNo: number | null;
  /** 断层章节（已学上限内没确认学过的） */
  gaps: number[];
  note: string | null;
}

export interface ScopeSource {
  code: string;
  name: string;
  file: string;
  chapters: number;
}

export interface CourseScope {
  intent: CourseIntent;
  /** 真正会打开的知识库（去重、只含就绪科目） */
  sources: ScopeSource[];
  /** 是否跨科目（sources.length > 1） */
  multiSubject: boolean;
  /** 请求涉及的科目（含未就绪的，便于前端提示"该科还没建库"） */
  subjects: ScopeSubject[];
  warnings: string[];
  blocked: boolean;
  /** 给人看的一句话，前端可以直接显示 */
  reason: string;
}

/** intent 的中文名，用于提示文案 */
export const INTENT_LABEL: Record<CourseIntent, string> = {
  ask: "问教材",
  review: "改错",
  extract: "图片识别",
  plan: "排期建议",
  roadmap: "学习路径",
  exercise: "举一反三",
};

export interface PlanScopeInput {
  intent: CourseIntent;
  /** 当前科目；单科目功能以它为准 */
  course?: string | null;
  /** 跨科目功能可选传多个科目 */
  courseCodes?: string[] | null;
}

/** 归一化并去重；非法代码只记 warning，不让整个请求失败 */
function collectCodes(raw: Array<string | null | undefined>, warnings: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (item == null) continue;
    const text = String(item).trim();
    if (!text) continue;
    let code: string;
    try {
      code = normalizeCourseCode(text);
    } catch {
      warnings.push(`忽略非法科目代码：${text.slice(0, 20)}`);
      continue;
    }
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

/**
 * 解析一次请求的科目范围。不调模型、不读教材正文，只读注册表 + 进度，可单测。
 */
export function planCourseScope(db: DatabaseSync, input: PlanScopeInput): CourseScope {
  const warnings: string[] = [];
  const label = INTENT_LABEL[input.intent];
  const singleOnly = SINGLE_SUBJECT_INTENTS.has(input.intent);

  // 先把所有请求到的科目收集齐：单科目功能也要"看到多余科目并告警"，
  // 而不是悄悄忽略——用户以为跨科，结果只查了一科，这种误会必须说出来。
  const requested = collectCodes([input.course ?? null, ...(input.courseCodes ?? [])], warnings);

  let codes = requested;
  if (singleOnly && requested.length > 1) {
    codes = requested.slice(0, 1);
    warnings.push(`${label}只调用当前科目的知识库，已忽略：${requested.slice(1).join("、")}`);
  }

  const subjects: ScopeSubject[] = codes.map((code) => {
    const sub = getSubject(db, code);
    const file =
      sub?.textbook_file ?? (textbookMeta(textbookFileOf(code)) ? textbookFileOf(code) : null);
    const meta = textbookMeta(file);
    const profile = loadProfile(db, code);
    const status: ScopeSubjectStatus = !sub
      ? "unregistered"
      : meta == null
        ? "no-textbook"
        : "ready";
    return {
      code,
      name: sub?.name ?? code,
      registered: sub != null,
      status,
      file: meta ? file : null,
      chapters: meta?.chapters ?? 0,
      maxChapterNo: profile.maxChapterNo,
      gaps: gapsOf(profile),
      note: sub?.note ?? null,
    };
  });

  const sources: ScopeSource[] = subjects
    .filter((s) => s.status === "ready" && s.file != null)
    .map((s) => ({ code: s.code, name: s.name, file: s.file!, chapters: s.chapters }));

  for (const s of subjects) {
    if (s.status === "unregistered") warnings.push(`科目 ${s.code} 尚未登记`);
    else if (s.status === "no-textbook")
      warnings.push(`科目 ${s.code} 还没有知识库（待 build:textbook）`);
  }

  const blocked = sources.length === 0;
  let reason: string;
  if (codes.length === 0) {
    reason = `没有指定科目：${label}需要先选一门科目`;
  } else if (blocked) {
    reason = `所选科目都还没有可用知识库，${label}无法调用教材`;
  } else if (sources.length === 1) {
    reason = `只涉及 1 门科目（${sources[0]!.name}）：只打开该科知识库，门控用该科的已学章节`;
  } else {
    reason = `跨 ${sources.length} 门科目（${sources.map((s) => s.name).join("、")}）：各科分别打开知识库、各用各的已学章节门控，结果按 RRF 合并`;
  }

  return {
    intent: input.intent,
    sources,
    multiSubject: sources.length > 1,
    subjects,
    warnings,
    blocked,
    reason,
  };
}

/**
 * 把 scope 变成检索层能直接用的 sources。
 *
 * 关键：filter **按科目各算各的**。返回的值可以直接喂给 `retrieveMany(sources, query, k)`。
 */
export function scopeSources(db: DatabaseSync, scope: CourseScope): CourseSource[] {
  return scope.sources.map((s) => ({
    file: s.file,
    filter: progressFilter(loadProfile(db, s.code)),
  }));
}
