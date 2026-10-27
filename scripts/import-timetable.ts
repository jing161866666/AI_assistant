import "dotenv/config";
import { getLearnerDb } from "../src/db/index.js";
import { insertSchedule } from "../src/schedule/service.js";

/**
 * 把教务系统课表截图（2026.10.26–11.01，即第 6 周）导入为结构化日程。
 *
 * 截图只反映"某一周"，推不出起止周，因此这里按 1–18 周全学期录入。
 * 真实产品里应由学生确认每门课的周次范围；节假日/调休由校历表统一抑制。
 */

const db = getLearnerDb();
db.exec("DELETE FROM schedule_exception");
db.exec("DELETE FROM schedule");

// 节次 → 时间，来自 class_slot
const slots = new Map<number, { start: string; end: string }>();
for (const r of db.prepare("SELECT * FROM class_slot").all() as Array<{
  period: number;
  start_time: string;
  end_time: string;
}>) {
  slots.set(r.period, { start: r.start_time, end: r.end_time });
}

if (slots.size === 0) {
  throw new Error("class_slot 为空，请先运行 npm run import:calendar");
}

interface CourseSpec {
  title: string;
  weekday: number;
  from: number; // 起始节次
  to: number; // 结束节次
  location: string;
  courseCode: string;
  note?: string;
}

// 逐条取自截图 2026.10.26–11.01
const COURSES: CourseSpec[] = [
  { title: "大学物理(B)II", weekday: 1, from: 3, to: 4, location: "教四-202", courseCode: "PHY2" },
  { title: "数据结构", weekday: 1, from: 6, to: 7, location: "教二-309", courseCode: "DS" },
  {
    title: "马克思主义基本原理",
    weekday: 1,
    from: 8,
    to: 10,
    location: "教四-303",
    courseCode: "MARX",
  },

  {
    title: "概率统计与随机过程",
    weekday: 2,
    from: 1,
    to: 2,
    location: "教六-101",
    courseCode: "PROB",
  },
  {
    title: "人工智能导论",
    weekday: 2,
    from: 3,
    to: 5,
    location: "教二-108",
    courseCode: "AI",
    note: "截图标注「调整」",
  },
  { title: "计算机组成原理", weekday: 2, from: 6, to: 7, location: "教四-302", courseCode: "CO" },
  { title: "Python编程", weekday: 2, from: 8, to: 10, location: "教四-202", courseCode: "PY" },
  {
    title: "社会主义发展史",
    weekday: 2,
    from: 11,
    to: 12,
    location: "教四-103",
    courseCode: "SOC",
  },

  { title: "计算机组成原理", weekday: 3, from: 3, to: 5, location: "教四-302", courseCode: "CO" },

  { title: "大学物理(B)II", weekday: 4, from: 1, to: 2, location: "教四-202", courseCode: "PHY2" },
  { title: "数据结构", weekday: 4, from: 3, to: 5, location: "教二-309", courseCode: "DS" },
  { title: "体育III", weekday: 4, from: 6, to: 7, location: "梅园田径场", courseCode: "PE3" },
  {
    title: "Python语言与数据科学",
    weekday: 4,
    from: 11,
    to: 13,
    location: "教一-206",
    courseCode: "PYDS",
  },

  {
    title: "大学物理实验(理工)II",
    weekday: 5,
    from: 3,
    to: 5,
    location: "物理实验中心(田家炳楼3-5楼)",
    courseCode: "PHYLAB2",
  },
  {
    title: "概率统计与随机过程",
    weekday: 5,
    from: 6,
    to: 7,
    location: "教六-101",
    courseCode: "PROB",
  },
];

let n = 0;
for (const c of COURSES) {
  const a = slots.get(c.from);
  const b = slots.get(c.to);
  if (!a || !b) throw new Error(`节次 ${c.from}-${c.to} 未定义`);
  insertSchedule(db, {
    title: c.title,
    type: "course",
    category: "academic",
    course_code: c.courseCode,
    weekday: c.weekday,
    start_time: a.start,
    end_time: b.end,
    location: c.location,
    recurring: 1,
    week_start: 1,
    week_end: 18,
    week_parity: "all",
    flexibility: 0,
    intent: c.note ?? null,
    source: "uploaded",
  });
  n++;
}

// 睡觉：生活块，不能被当成空闲。跨午夜按 7 天各一条
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
    week_end: 18,
    flexibility: 0,
    intent: "每天睡够 7.5 小时",
  });
  n++;
}

console.log(`导入 ${COURSES.length} 门课程 + 7 条睡眠块，共 ${n} 条日程。`);
console.log("\n课程一览：");
for (const c of COURSES) {
  const a = slots.get(c.from)!;
  const b = slots.get(c.to)!;
  console.log(
    `  周${"一二三四五六日"[c.weekday - 1]} ${a.start}-${b.end}  ${c.title}  ${String(c.from)}-${c.to}节  ${c.location}`,
  );
}
