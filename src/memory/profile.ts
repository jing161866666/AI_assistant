import type { DatabaseSync } from "node:sqlite";
import {
  type ChapterProgress,
  learnedChapterSet,
  listChapterProgress,
  maxLearnedChapter,
} from "./chapter-progress.js";
import { injectableHabits } from "./habit-extract.js";
import { listStudyWindows } from "./habit-manual.js";
import { listResources, RESOURCE_KIND_LABEL } from "./resources.js";

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
  /** 在用的网课/教辅（本课程 + 共用） */
  resources: Array<{
    course_code: string | null;
    kind: string;
    title: string;
    local_status: string;
    progress: number | null;
  }>;
  /** 偏好时段（自述优先）：日程排期与讲解风格都要参考 */
  windows: Array<{ start: string | null; end: string | null; what: string; source: string }>;
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
  study_time: "偏好时段",
  study_window: "偏好时段（学什么/怎么学）",
  investment: "课下投入占比",
  resource: "在用的网课/教辅",
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
    resources: listResources(db, courseCode).map((r) => ({
      course_code: r.course_code,
      kind: r.kind,
      title: r.title,
      local_status: r.local_status,
      progress: r.progress,
    })),
    windows: listStudyWindows(db, courseCode).map((w) => ({
      start: w.start,
      end: w.end,
      what: w.what,
      source: w.source,
    })),
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
export function profilePrompt(
  p: Profile,
  /**
   * 教材章节表（含用户改过的章名）。给了就写进画像，让模型按名称判断
   * "这个方法属于哪一章、算不算超纲"；不给则只按章号约束。
   */
  outline?: Array<{ chapterNo: number; title: string }>,
): string {
  const lines: string[] = ["【学生画像】"];
  lines.push(`科目：${p.courseName}（${p.courseCode}）`);

  if (outline && outline.length > 0) {
    lines.push(
      `教材章节表（判断方法属于哪一章时以此为准，名称由学生按习惯命名）：\n${outline
        .map((o) => `第${o.chapterNo}章 ${o.title}`)
        .join("；")}`,
    );
  }

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

  // ── 偏好时段（自述优先；排期与讲解都要参考） ──
  if (p.windows.length) {
    const items = p.windows
      .filter((w) => w.start && w.end)
      .map((w) => `${w.start}-${w.end} 偏好：${w.what}${w.source === "manual" ? "（自述）" : ""}`);
    if (items.length) lines.push(`偏好时段（排任务时优先放这些时间）：${items.join("；")}`);
  }

  // ── 在用的资源（网课/教辅） ──
  if (p.resources.length) {
    const items = p.resources.slice(0, 8).map((r) => {
      const kind = RESOURCE_KIND_LABEL[r.kind] ?? r.kind;
      const scope = r.course_code ? "" : "（通识）";
      const state =
        r.local_status === "missing"
          ? "·缺资源待上传"
          : r.local_status === "available"
            ? "·本地可用"
            : "";
      const prog = r.progress != null ? `·进度${Math.round(r.progress * 100)}%` : "";
      return `${kind}《${r.title}》${scope}${state}${prog}`;
    });
    lines.push(`在用的学习资源：${items.join("；")}`);
    if (p.resources.some((r) => r.local_status === "missing")) {
      lines.push(
        "（有资源本地缺失：如果讲解需要它，明确告诉学生「这份资料还没上传」，不要凭标题编内容）",
      );
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

/**
 * 一次装多个科目的画像（跨科目学习路径规划用）。
 * 去重 + 忽略空值：调用方可能直接拿前端勾选的科目列表传进来。
 */
export function loadProfiles(db: DatabaseSync, courseCodes: string[]): Profile[] {
  const seen = new Set<string>();
  const out: Profile[] = [];
  for (const raw of courseCodes) {
    const code = raw.trim().toUpperCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(loadProfile(db, code));
  }
  return out;
}

/**
 * 多科目画像文本。
 *
 * 与单科目的区别只有两点，但都关键：
 *   1) 每个科目单独一段，进度/习惯按科目隔离，绝不合并成一个"总进度"；
 *   2) 末尾给出跨科目约束——一个科目的方法只能用**该科目**的已学章节，
 *      不能拿物理的进度去放行高数的内容。
 */
export function profilePromptMulti(profiles: Profile[]): string {
  if (profiles.length === 0) return "【学生画像】\n（未选择任何科目）";
  const only = profiles[0];
  if (profiles.length === 1 && only) return profilePrompt(only);

  const lines: string[] = ["【学生画像 · 多科目】"];
  for (const p of profiles) {
    lines.push(`\n■ ${p.courseName}（${p.courseCode}）`);
    if (p.maxChapterNo == null) {
      lines.push("  进度：尚未记录，讲课时按正常顺序并提醒学生设置进度");
    } else {
      const learned = [...p.learned].sort((a, b) => a - b);
      lines.push(`  进度：已学到第 ${p.maxChapterNo} 章（已学：${learned.join("、") || "无"}）`);
      const gaps = gapsOf(p);
      if (gaps.length) lines.push(`  跳过未学：第 ${gaps.join("、")} 章`);
    }
    if (p.habits.length) {
      const byDim = new Map<string, string[]>();
      for (const h of p.habits) {
        const label = DIM_LABEL[h.dimension] ?? h.dimension;
        byDim.set(label, [...(byDim.get(label) ?? []), `${h.key}→${h.value}`]);
      }
      lines.push(`  习惯：${[...byDim].map(([k, v]) => `${k} ${v.join("、")}`).join("；")}`);
    }
    if (p.goals.length) {
      lines.push(`  目标：${p.goals.map((g) => g.title).join("；")}`);
    }
  }
  lines.push(
    "\n跨科目约束：",
    "- 每个科目的方法只能用该科目自己的已学章节；门控按科目分别执行，不得把一个科目的进度套到另一个科目上。",
    "- 排顺序时先排前置科目（如数学基础），再排依赖它的科目内容。",
    "- 每一条计划都要写明所属科目，跨科目条目不能混为一条。",
  );
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
