import "dotenv/config";

// 合成场景用独立数据库，避免污染真实课表与校历
process.env.DB_PATH = "./data/test-schedule.db";

const { getLearnerDb } = await import("../src/db/index.js");
const { addDays, dateOfWeek, insertSchedule, weekdayOf } = await import(
  "../src/schedule/service.js"
);

/** 找最近的周一，保证 week 1 从周一开始 */
function ensureMonday(d: string): string {
  let cur = d;
  while (weekdayOf(cur) !== 1) cur = addDays(cur, -1);
  return cur;
}

const db = getLearnerDb();

// 清空旧测试数据
for (const t of ["schedule", "schedule_exception", "time_preference", "capacity_rule", "term"]) {
  db.exec(`DELETE FROM ${t}`);
}

const TERM_START = ensureMonday("2026-09-07");
const TERM_WEEKS = 16;
db.prepare("INSERT INTO term (name, start_date, total_weeks, is_active) VALUES (?,?,?,1)").run(
  "2026-2027-1",
  TERM_START,
  TERM_WEEKS,
);

console.log(`学期起始日（第1周周一）: ${TERM_START}`);

// ── 正课（不可动）────────────────────────────────────────────
const courses = [
  {
    title: "高等数学A",
    code: "MATH",
    weekday: 1,
    start: "08:00",
    end: "09:40",
    ws: 1,
    we: 16,
    parity: "all",
    loc: "教一101",
  },
  {
    title: "数据结构",
    code: "DS",
    weekday: 1,
    start: "10:00",
    end: "11:40",
    ws: 1,
    we: 16,
    parity: "all",
    loc: "教二203",
  },
  {
    title: "大学英语",
    code: "ENG",
    weekday: 2,
    start: "14:00",
    end: "15:40",
    ws: 1,
    we: 8,
    parity: "all",
    loc: "外语楼305",
  },
  {
    title: "大学物理",
    code: "PHY",
    weekday: 3,
    start: "14:00",
    end: "15:40",
    ws: 1,
    we: 15,
    parity: "odd",
    loc: "教三110",
  },
] as const;

for (const c of courses) {
  insertSchedule(db, {
    title: c.title,
    type: "course",
    category: "academic",
    course_code: c.code,
    weekday: c.weekday,
    start_time: c.start,
    end_time: c.end,
    location: c.loc,
    recurring: 1,
    week_start: c.ws,
    week_end: c.we,
    week_parity: c.parity,
    flexibility: 0,
  });
}

// ── 生活：睡觉跨午夜，学生活块，不是"空着"──────────────────
// 跨午夜无法用单行表达，按 7 天各生成一条
for (let wd = 1; wd <= 7; wd++) {
  insertSchedule(db, {
    title: "睡觉",
    type: "sleep",
    category: "life",
    weekday: wd,
    start_time: "23:30",
    end_time: "07:00",
    recurring: 1,
    week_start: 1,
    week_end: 16,
    flexibility: 0,
    intent: "每天要睡够 7.5 小时",
  });
}

insertSchedule(db, {
  title: "午休",
  type: "rest",
  category: "life",
  weekday: 1,
  start_time: "13:00",
  end_time: "13:40",
  recurring: 1,
  week_start: 1,
  week_end: 16,
  flexibility: 1,
});
for (const wd of [2, 3, 4, 5]) {
  insertSchedule(db, {
    title: "午休",
    type: "rest",
    category: "life",
    weekday: wd,
    start_time: "13:00",
    end_time: "13:40",
    recurring: 1,
    week_start: 1,
    week_end: 16,
    flexibility: 1,
  });
}

// ── 用户意愿：这段我要干别的，别给我排学习 ────────────────────
insertSchedule(db, {
  title: "打篮球",
  type: "sport",
  category: "life",
  weekday: 3,
  start_time: "19:00",
  end_time: "21:00",
  recurring: 1,
  week_start: 1,
  week_end: 16,
  flexibility: 1,
  intent: "周三晚上想打球放松，别安排学习任务",
  priority: 5,
});

insertSchedule(db, {
  title: "兼职",
  type: "work",
  category: "work",
  weekday: 6,
  start_time: "09:00",
  end_time: "17:00",
  recurring: 1,
  week_start: 1,
  week_end: 16,
  flexibility: 0,
  intent: "周末要兼职，回来很累，不想再学",
  priority: 8,
});

// ── 时段偏好 ────────────────────────────────────────────────
db.prepare(
  `INSERT INTO time_preference (weekday_from, weekday_to, start_time, end_time, mode, applies_to, strength, reason)
   VALUES (?,?,?,?,?,?,?,?)`,
).run(1, 5, "21:00", "23:59", "avoid", "study", 3, "晚上效率低，想早点收工");

db.prepare(
  `INSERT INTO time_preference (weekday_from, weekday_to, start_time, end_time, mode, applies_to, strength, reason)
   VALUES (?,?,?,?,?,?,?,?)`,
).run(6, 7, null, null, "avoid", "study", 3, "周末想留给自己");

db.prepare(
  `INSERT INTO time_preference (weekday_from, weekday_to, start_time, end_time, mode, applies_to, strength, reason)
   VALUES (?,?,?,?,?,?,?,?)`,
).run(1, 5, "07:00", "09:00", "prefer", "study", 2, "早上记忆力好");

// ── 总量约束 ────────────────────────────────────────────────
db.prepare(
  "INSERT INTO capacity_rule (period, metric, min_value, max_value, note) VALUES (?,?,?,?,?)",
).run("week", "study_minutes", null, 900, "每周学习不超过 15 小时");
db.prepare(
  "INSERT INTO capacity_rule (period, metric, min_value, max_value, note) VALUES (?,?,?,?,?)",
).run("day", "sleep_minutes", 420, null, "每天至少睡 7 小时");

// ── 例外：第 3 周周三的大学物理，调到周四 ────────────────────
const phy = db.prepare("SELECT id FROM schedule WHERE title = '大学物理'").get() as { id: number };
const w3wed = dateOfWeek(TERM_START, 3, 3);
const w3thu = dateOfWeek(TERM_START, 3, 4);
db.prepare(
  `INSERT INTO schedule_exception (schedule_id, date, kind, new_date, new_start, new_end, note)
   VALUES (?,?,?,?,?,?,?)`,
).run(phy.id, w3wed, "reschedule", w3thu, "14:00", "15:40", "老师调课");

// 第 5 周周三停课
db.prepare(`INSERT INTO schedule_exception (schedule_id, date, kind, note) VALUES (?,?,?,?)`).run(
  phy.id,
  dateOfWeek(TERM_START, 5, 3),
  "cancel",
  "老师出差停课",
);

const counts = {
  schedule: (db.prepare("SELECT COUNT(*) c FROM schedule").get() as { c: number }).c,
  preference: (db.prepare("SELECT COUNT(*) c FROM time_preference").get() as { c: number }).c,
  capacity: (db.prepare("SELECT COUNT(*) c FROM capacity_rule").get() as { c: number }).c,
  exception: (db.prepare("SELECT COUNT(*) c FROM schedule_exception").get() as { c: number }).c,
};

console.log("\n种子数据写入完成：");
console.log(JSON.stringify(counts, null, 2));
console.log(`\n关键日期：第3周周三=${w3wed}（物理调走）→ 第3周周四=${w3thu}`);
console.log(`          第5周周三=${dateOfWeek(TERM_START, 5, 3)}（物理停课）`);
