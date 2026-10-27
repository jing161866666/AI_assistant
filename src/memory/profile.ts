import type { DatabaseSync } from "node:sqlite";
import {
  type ChapterProgress,
  learnedChapterSet,
  listChapterProgress,
  maxLearnedChapter,
} from "./chapter-progress.js";
import { injectableHabits } from "./habit-extract.js";

/**
 * 学生画像：每次回答前注入的"你面前这个人是谁"。
 *
 * AGENTS.md 硬约束：缺了画像注入，整套产品退化成普通聊天。
 * 这里只负责"组装与措辞"，不产生任何结论——结论都必须有 evidence。
 */

export interface HabitRow {
  id: number;
  dimension: string;
  key: string;
  value: string;
  course_code: string | null;
  context: string | null;
  confidence: number;
  evidence_count: number;
}

export interface PreferenceRow {
  weekday_from: number;
  weekday_to: number;
  start_time: string | null;
  end_time: string | null;
  mode: string;
  applies_to: string;
  strength: number;
  reason: string | null;
}

export interface CapacityRow {
  period: string;
  metric: string;
  min_value: number | null;
  max_value: number | null;
  note: string | null;
}

export interface GoalRow {
  id: number;
  scope: string;
  course_code: string | null;
  title: string;
  target: string | null;
  deadline: string | null;
  status: string;
}

export interface Profile {
  courseCode: string;
  courseName: string;
  chapters: ChapterProgress[];
  learned: Set<number>;
  /** 已学上限；null = 还没设过进度 */
  maxChapterNo: number | null;
  /** 已知的总章数（从 textbook.db 拿不到时用 corpus 里的最大值） */
  habits: HabitRow[];
  preferences: PreferenceRow[];
  capacities: CapacityRow[];
  goals: GoalRow[];
}

const WD = ["一", "二", "三", "四", "五", "六", "日"];

const DIM_LABEL: Record<string, string> = {
  learn_method: "学习方式",
  code_naming: "代码命名",
  notation: "符号偏好",
  error_pattern: "反复出错",
  planning: "计划习惯",
  help_seeking: "求助方式",
  attention: "专注时长",
};

export function loadProfile(
  db: DatabaseSync,
  courseCode: string,
  courseName = courseCode,
): Profile {
  // 只注入满足阈值的习惯（证据≥2 且置信度≥0.6）；不足阈值的只存不注入
  const habits = injectableHabits(db, courseCode) as unknown as HabitRow[];

  const preferences = db
    .prepare("SELECT * FROM time_preference ORDER BY weekday_from, start_time")
    .all() as unknown as PreferenceRow[];

  const capacities = db.prepare("SELECT * FROM capacity_rule").all() as unknown as CapacityRow[];

  const goals = db
    .prepare(
      `SELECT * FROM goal
       WHERE status = 'active' AND (course_code IS NULL OR course_code = ?)
       ORDER BY id DESC`,
    )
    .all(courseCode) as unknown as GoalRow[];

  return {
    courseCode,
    courseName,
    chapters: listChapterProgress(db, courseCode),
    learned: learnedChapterSet(db, courseCode),
    maxChapterNo: maxLearnedChapter(db, courseCode),
    habits,
    preferences,
    capacities,
    goals,
  };
}

/**
 * 该章节是否可放行。
 * 关键：用**集合**判定而不是 `<= 上限`——断层章节（如库里缺第 14 章）
 * 必须算未学，否则模型会默认"在第 11 章下面所以学过"。
 */
export function isLearned(p: Profile, chapterNo: number | null): boolean {
  if (chapterNo == null) return true; // 题库内容不参与门控
  if (p.learned.size === 0) return true; // 没设进度时不拦，但画像会要求提醒用户
  return p.learned.has(chapterNo);
}

/** 断层：≤ 已学上限但没确认学过的章节 */
export function gapsOf(p: Profile): number[] {
  if (p.maxChapterNo == null) return [];
  const out: number[] = [];
  for (let n = 1; n <= p.maxChapterNo; n++) if (!p.learned.has(n)) out.push(n);
  return out;
}

/**
 * 交给检索层做 L1 硬闸的过滤器。
 * `null` = 没设进度（不过滤，由提示词收敛）；空集合 = 设了但一章没学（只放行题库）。
 */
export function progressFilter(p: Profile): Set<number> | null {
  return p.maxChapterNo == null ? null : p.learned;
}

/**
 * 组装注入提示词的画像文本。
 * 原则：短、可核对、每个结论带证据量。学生看这一段应当能认出自己。
 */
export function profilePrompt(p: Profile): string {
  const lines: string[] = ["【学生画像】"];
  lines.push(`科目：${p.courseName}（${p.courseCode}）`);

  // ── 进度 ──
  if (p.maxChapterNo == null) {
    lines.push("教材进度：尚未记录。回答时按正常顺序讲，并在结尾提醒学生设置进度。");
  } else {
    const learnedList = [...p.learned].sort((a, b) => a - b);
    const learning = p.chapters.find((c) => c.status === "learning");
    const gaps: number[] = [];
    for (let n = 1; n <= p.maxChapterNo; n++) if (!p.learned.has(n)) gaps.push(n);
    lines.push(
      `教材进度：已学到第 ${p.maxChapterNo} 章（已学：${learnedList.join("、") || "无"}）`,
    );
    if (learning) lines.push(`当前正在学：第 ${learning.chapter_no} 章`);
    if (gaps.length) lines.push(`⚠ 中间有跳过：第 ${gaps.join("、")} 章未确认学过`);
    lines.push(
      `讲授约束：优先只用第 1–${p.maxChapterNo} 章的方法。` +
        `若这题必须用到第 ${p.maxChapterNo + 1} 章及以后的知识，先明确告知「这题要用到第X章，你还没学」，` +
        "再给解法，并尽量补一个只用已学知识的替代思路。不要假装学生应该会。",
    );
  }

  // ── 习惯 ──
  const byDim = new Map<string, HabitRow[]>();
  for (const h of p.habits) {
    const list = byDim.get(h.dimension) ?? [];
    list.push(h);
    byDim.set(h.dimension, list);
  }
  if (p.habits.length === 0) {
    lines.push("学习习惯：暂无记录。");
  } else {
    lines.push("学习习惯（括号内为证据条数）：");
    for (const [dim, rows] of byDim) {
      const label = DIM_LABEL[dim] ?? dim;
      const items = rows
        .slice(0, 6)
        .map((r) => `${r.key} → ${r.value}(${r.evidence_count})`)
        .join("；");
      lines.push(`  - ${label}：${items}`);
    }
  }

  // ── 时间偏好 ──
  if (p.preferences.length) {
    const items = p.preferences.map((r) => {
      const day =
        r.weekday_from === r.weekday_to
          ? `周${WD[r.weekday_from - 1]}`
          : `周${WD[r.weekday_from - 1]}~周${WD[r.weekday_to - 1]}`;
      const time = r.start_time ? `${r.start_time}-${r.end_time ?? "24:00"}` : "全天";
      return `${day}${time}${r.mode === "avoid" ? "不想学" : "适合学"}${r.reason ? `（${r.reason}）` : ""}`;
    });
    lines.push(`时段偏好：${items.join("；")}`);
  }

  if (p.capacities.length) {
    const items = p.capacities.map(
      (c) =>
        `${c.period === "week" ? "每周" : "每天"}${c.metric}${c.max_value != null ? `≤${c.max_value}` : `≥${c.min_value}`}`,
    );
    lines.push(`总量约束：${items.join("；")}`);
  }

  if (p.goals.length) {
    const items = p.goals.map((g) => `${g.title}${g.deadline ? `（${g.deadline}）` : ""}`);
    lines.push(`目标：${items.join("；")}`);
  }

  return lines.join("\n");
}

/** 全量习惯（含未达注入阈值的），供界面展示 */
function allHabits(db: DatabaseSync, courseCode: string): HabitRow[] {
  return db
    .prepare(
      `SELECT * FROM habit
       WHERE course_code IS NULL OR course_code = ?
       ORDER BY dimension, confidence DESC`,
    )
    .all(courseCode) as unknown as HabitRow[];
}

/** 供前端展示的画像摘要 */
export function profileSummary(db: DatabaseSync, courseCode: string) {
  const p = loadProfile(db, courseCode);
  return {
    courseCode: p.courseCode,
    maxChapterNo: p.maxChapterNo,
    learned: [...p.learned].sort((a, b) => a - b),
    gaps: gapsOf(p),
    // 门控状态：没设进度时前端要提示"先设进度，模型才知道该讲多深"
    guard: progressFilter(p) == null ? "no-progress" : "ok",
    chapters: p.chapters,
    habits: allHabits(db, courseCode),
    preferences: p.preferences,
    capacities: p.capacities,
    goals: p.goals,
  };
}
