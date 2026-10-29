import type { DatabaseSync } from "node:sqlite";
import {
  type CourseMatch,
  listLibraries,
  matchCourses as matchCourseTable,
  saveMatchResult,
} from "../memory/course-match.js";
import { addSubject, getSubject, normalizeCourseCode } from "../memory/subjects.js";
import { insertSchedule } from "../schedule/service.js";
import { createEmptyTextbookDb } from "./course-db.js";
import type { TimetableRow } from "./timetable.js";

/**
 * 课表 → 日程表 + 科目 + 空库。
 *
 * 课程名 → 代码的对应统一走 `src/memory/course-match.ts`：
 *   exact / alias / short 三档可直接用，model 档必须用户确认才采用。
 * 这里只负责写库，不再自带一套匹配逻辑。
 *
 * 顺序不能反：
 *   1) 先建空库（登记科目时才能自动绑定）；
 *   2) 再登记科目；
 *   3) 最后写日程（没匹配上的课留 course_code=NULL，日程本身不丢）。
 */

export interface ApplyMatchInput {
  /** 课表课程名（与 rows[].title 对得上） */
  title: string;
  code: string;
  /** 官方课名（可省，默认用 title） */
  name?: string;
}

export interface ApplyTimetableInput {
  rows: TimetableRow[];
  /** 用户核对/改过的对应关系；不传则现场匹配 */
  matches?: ApplyMatchInput[];
  weekStart?: number;
  weekEnd?: number;
}

export interface AppliedSubject {
  code: string;
  name: string;
  subjectCreated: boolean;
  dbCreated: boolean;
  file: string;
  textbookReady: boolean;
}

export interface ApplyTimetableResult {
  scheduleAdded: number;
  subjects: AppliedSubject[];
  /** 没匹配到代码的课程名：日程已写，但课程记忆暂时没有锚点 */
  unmatched: string[];
  /** 需要用户确认的模型猜测（本次不采用） */
  pendingConfirm: Array<{ title: string; code: string; reason: string }>;
}

function toCourseMatch(m: ApplyMatchInput): CourseMatch {
  const code = normalizeCourseCode(m.code);
  const library = listLibraries().find((l) => l.code === code) ?? null;
  return {
    name: m.title,
    code,
    library,
    tier: "model",
    confidence: 0.7,
    reason: "用户在前端确认",
    needsConfirm: false,
  };
}

export async function applyTimetable(
  db: DatabaseSync,
  input: ApplyTimetableInput,
): Promise<ApplyTimetableResult> {
  const titles = [...new Set(input.rows.map((r) => r.title.trim()).filter(Boolean))];

  let matches: CourseMatch[];
  if (input.matches) {
    matches = input.matches.map(toCourseMatch);
  } else {
    const r = await matchCourseTable(db, { courses: titles });
    matches = r.courses;
  }

  const byTitle = new Map<string, CourseMatch>();
  const pendingConfirm: Array<{ title: string; code: string; reason: string }> = [];
  for (const m of matches) {
    if (!m.code) continue;
    if (m.needsConfirm) {
      // 模型猜的对应不自动采用：写进别名表等用户确认，日程照常写
      saveMatchResult(db, m);
      pendingConfirm.push({ title: m.name, code: m.code, reason: m.reason });
      continue;
    }
    byTitle.set(m.name, m);
    saveMatchResult(db, m);
  }

  const weekStart = input.weekStart ?? 1;
  const weekEnd = input.weekEnd ?? 18;
  const subjects: AppliedSubject[] = [];
  const unmatched: string[] = [];

  for (const title of titles) {
    const m = byTitle.get(title);
    if (!m?.code) {
      unmatched.push(title);
      continue;
    }
    const name = m.library?.name ?? title;
    const before = getSubject(db, m.code);
    // 1) 先建空库：addSubject 会按约定文件名自动绑定
    const empty = createEmptyTextbookDb(m.code, name);
    // 2) 再登记科目
    if (!before) addSubject(db, { code: m.code, name });
    if (!before?.textbook_file && empty.file) {
      db.prepare(
        "UPDATE subject SET textbook_file = ?, updated_at = datetime('now') WHERE course_code = ?",
      ).run(empty.file, m.code);
    }
    const after = getSubject(db, m.code)!;
    subjects.push({
      code: m.code,
      name: after.name,
      subjectCreated: !before,
      dbCreated: empty.created,
      file: empty.file,
      textbookReady: after.textbook_ready,
    });
  }

  let scheduleAdded = 0;
  for (const row of input.rows) {
    const m = byTitle.get(row.title);
    insertSchedule(db, {
      title: row.title,
      type: "course",
      category: "academic",
      course_code: m?.code ?? null,
      weekday: row.weekday,
      start_time: row.start,
      end_time: row.end,
      location: row.location,
      recurring: 1,
      week_start: weekStart,
      week_end: weekEnd,
      week_parity: "all",
      flexibility: 0,
      source: "uploaded",
    });
    scheduleAdded++;
  }

  db.prepare("INSERT INTO event (type, ref_type, payload) VALUES (?,?,?)").run(
    "timetable_imported",
    "schedule",
    JSON.stringify({
      rows: scheduleAdded,
      subjects: subjects.map((s) => s.code),
      unmatched,
      pendingConfirm: pendingConfirm.length,
      weekStart,
      weekEnd,
    }),
  );

  return { scheduleAdded, subjects, unmatched, pendingConfirm };
}
