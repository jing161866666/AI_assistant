import "dotenv/config";
import {
  type AcademicTerm,
  buildTeachingDays,
  SEU_AUTUMN_2026,
  SEU_CALENDAR,
  SEU_CLASS_SLOTS,
} from "../src/academic/seu-2026-2027.js";
import { getLearnerDb } from "../src/db/index.js";

const db = getLearnerDb();

for (const t of ["term_event", "teaching_day", "class_slot", "term"]) {
  db.exec(`DELETE FROM ${t}`);
}

// 作息时间
for (const s of SEU_CLASS_SLOTS) {
  db.prepare("INSERT INTO class_slot (period, start_time, end_time) VALUES (?,?,?)").run(
    s.period,
    s.start,
    s.end,
  );
}

function insertTerm(term: AcademicTerm, active: number): number {
  const r = db
    .prepare("INSERT INTO term (name, start_date, total_weeks, is_active) VALUES (?,?,?,?)")
    .run(term.name, term.startDate, term.totalWeeks, active);
  return Number(r.lastInsertRowid);
}

for (const term of SEU_CALENDAR.terms) {
  const isActive = term.name === SEU_AUTUMN_2026.name ? 1 : 0;
  const id = insertTerm(term, isActive);

  for (const ev of term.events) {
    db.prepare(
      `INSERT INTO term_event (term_id, kind, start_date, end_date, name, study_allowed)
       VALUES (?,?,?,?,?,?)`,
    ).run(id, ev.kind, ev.start, ev.end, ev.name, ev.studyAllowed ? 1 : 0);
  }

  const days = buildTeachingDays(term);
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO teaching_day (date, kind, week, weekday, note) VALUES (?,?,?,?,?)",
  );
  for (const d of days) {
    stmt.run(d.date, d.kind, d.week ?? null, d.weekday ?? null, d.note ?? null);
  }

  const holidays = days.filter((d) => d.kind === "holiday").length;
  const suspended = days.filter((d) => d.kind === "suspended").length;
  const makeups = days.filter((d) => d.kind === "makeup").length;

  console.log(
    `\n${term.name}  第1周周一=${term.startDate}  共${term.totalWeeks}周  ${isActive ? "[当前学期]" : ""}`,
  );
  console.log(`  教学日例外: 放假 ${holidays} 天 / 停课 ${suspended} 天 / 调休 ${makeups} 天`);
  for (const d of days.filter((x) => x.kind === "makeup")) {
    console.log(
      `    ★ ${d.date} 调休 → 按第${d.week}周周${"一二三四五六日"[d.weekday! - 1]}上课  (${d.note})`,
    );
  }
  for (const n of term.notes) console.log(`    · ${n}`);
}

console.log("\n校历导入完成。");
