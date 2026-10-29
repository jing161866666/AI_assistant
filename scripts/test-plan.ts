import "dotenv/config";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseWindowKey } from "../src/memory/study-window.js";
import {
  addDays,
  loadPlanWindows,
  type PlanOptions,
  parseInvestment,
  planStudy,
  slotSegments,
  splitMinutes,
  tasksForDay,
  toMin,
  weekdayOf,
} from "../src/schedule/service.js";

/**
 * 排期偏好测试：偏好时段 / 投入占比 / 当天有课没课。
 *
 * 用独立库，不碰 data/learner.db，也不碰 test-schedule.db。
 * 只断言「排序、分配、标签」这三件会在代码里算的东西——内容选择属于模型，不在这里测。
 */

const DB_FILE = resolve(`data/test-plan-${process.pid}.db`);
for (const s of ["", "-wal", "-shm"]) rmSync(DB_FILE + s, { force: true });
const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA foreign_keys = ON");
db.exec(readFileSync(resolve("db/schema/learner.sql"), "utf8"));

// 第 1 周周一 = 2026-09-21（与校历测试一致）
const T0 = "2026-09-21";
db.prepare("INSERT INTO term (name, start_date, total_weeks, is_active) VALUES (?,?,?,1)").run(
  "2026-2027-1",
  T0,
  20,
);

// 科目注册表：排期里显示"温习课上内容：数据结构"而不是代码
for (const [code, name] of [
  ["DS", "数据结构"],
  ["PHY2", "大学物理(B)II"],
  ["MARX", "马克思主义基本原理"],
] as const) {
  db.prepare("INSERT INTO subject (course_code, course_name, ai_enabled) VALUES (?,?,1)").run(
    code,
    name,
  );
}

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${(e as Error).message.split("\n")[0]}`);
  }
}

/** 造一门每周固定的课 */
function addClass(code: string, title: string, weekday: number, start: string, end: string): void {
  db.prepare(
    `INSERT INTO schedule
       (title, type, category, course_code, weekday, start_time, end_time,
        recurring, week_start, week_end, week_parity, flexibility)
     VALUES (?, 'course', 'academic', ?, ?, ?, ?, 1, 1, 20, 'all', 0)`,
  ).run(title, code, weekday, start, end);
}

function addHabit(dimension: string, key: string, value: string, course: string | null): void {
  db.prepare(
    `INSERT INTO habit (dimension, key, value, course_code, confidence, evidence_count, status, source)
     VALUES (?,?,?,?,1,1,'active','manual')`,
  ).run(dimension, key, value, course);
}

const plan = (opts: Partial<PlanOptions>): ReturnType<typeof planStudy> =>
  planStudy(db, {
    from: T0,
    to: addDays(T0, 6),
    perDayMinutes: 120,
    minChunk: 20,
    maxChunk: 60,
    ...opts,
  });

console.log("【1】投入占比解析");
check("0.4 / 40% / 高 / 中 / 低 都能读", () => {
  assert.equal(parseInvestment("0.4"), 0.4);
  assert.equal(parseInvestment("40%"), 0.4);
  assert.equal(parseInvestment("高"), 0.6);
  assert.equal(parseInvestment("中"), 0.3);
  assert.equal(parseInvestment("水"), 0);
});

check("读不出来返回 null（不瞎猜）", () => {
  assert.equal(parseInvestment("看情况"), null);
});

check("按权重分配分钟数，总和精确不丢分钟", () => {
  const split = splitMinutes(
    [
      { course_code: "DS", weight: 0.6 },
      { course_code: "PHY2", weight: 0.4 },
    ],
    100,
  );
  assert.equal(
    split.reduce((n, x) => n + x.minutes, 0),
    100,
  );
  assert.ok((split.find((s) => s.course_code === "DS")?.minutes ?? 0) >= 59);
});

console.log("\n【2】当天有课 → 温习课上内容");

addClass("DS", "数据结构", 1, "08:00", "09:30"); // 周一
addHabit("investment", "数据结构", "0.6", "DS");
addHabit("investment", "大学物理(B)II", "0.4", "PHY2");

check("周一的计划是 review，且点名那门课", () => {
  const b = plan({}).filter((x) => x.date === T0);
  assert.ok(b.length > 0, "周一没排东西");
  const reviews = b.filter((x) => x.kind === "review");
  assert.ok(reviews.length > 0, "周一有课却没排温习");
  assert.ok(reviews[0]?.label?.includes("数据结构"), reviews[0]?.label ?? "");
  // 复习不能一边倒：最多占当天一半（用户反馈过"温习时间太多"）
  const reviewMin = reviews.reduce((n, x) => n + x.minutes, 0);
  const totalMin = b.reduce((n, x) => n + x.minutes, 0);
  assert.ok(reviewMin <= Math.floor(totalMin / 2), `温习 ${reviewMin}/${totalMin} 分钟，超过一半`);
});

check("没课的日子排作业/网课，且按投入占比分给多门课", () => {
  const tue = plan({}).filter((x) => x.date === addDays(T0, 1));
  assert.ok(tue.length > 0, "周二没排东西");
  const kinds = new Set(tue.map((x) => x.kind));
  assert.ok(kinds.has("practice") || kinds.has("netcourse"));
  const codes = new Set(tue.map((x) => x.course_code));
  assert.ok(codes.has("DS") && codes.has("PHY2"), `周二科目：${[...codes].join(",")}`);
  const dsMin = tue.filter((x) => x.course_code === "DS").reduce((n, x) => n + x.minutes, 0);
  const phyMin = tue.filter((x) => x.course_code === "PHY2").reduce((n, x) => n + x.minutes, 0);
  assert.ok(dsMin > phyMin, `占比 0.6 的课应拿到更多时间：DS=${dsMin} PHY2=${phyMin}`);
});

console.log("\n【3】偏好时段优先");

// 周二 20:00-22:00 写代码，且周二晚上没有课
addHabit("study_window", "20:00-22:00", "写代码", null);

check("有偏好时段时，排出来的块优先落在该时段", () => {
  const tue = plan({}).filter((x) => x.date === addDays(T0, 1));
  assert.ok(tue.length > 0);
  const inWindow = tue.filter(
    (b) => toMin(b.start) >= toMin("20:00") && toMin(b.start) < toMin("22:00"),
  );
  assert.ok(inWindow.length > 0, `时段内一块都没排：${tue.map((b) => b.start).join(",")}`);
  // 偏好时段里的块应该排在最前面被使用（时间上更晚但优先）
  assert.ok(
    tue.some((b) => b.start >= "20:00"),
    "偏好时段没被用上",
  );
});

check("没有偏好时段时按时间顺序（回归：不改变老行为）", () => {
  db.prepare("DELETE FROM habit WHERE dimension='study_window'").run();
  const tue = plan({}).filter((x) => x.date === addDays(T0, 1));
  const starts = tue.map((b) => toMin(b.start));
  assert.deepEqual(
    starts,
    [...starts].sort((a, b) => a - b),
    "没有偏好时块应按时间升序",
  );
  addHabit("study_window", "20:00-22:00", "写代码", null);
});

console.log("\n【4】水课不排");

addHabit("investment", "马克思主义基本原理", "0", "MARX");

check("投入占比 0 的课一块都不排", () => {
  const all = plan({});
  assert.equal(all.filter((b) => b.course_code === "MARX").length, 0, "水课被排进去了");
});

check("关掉偏好（usePreferences:false）时恢复旧行为：不标科目", () => {
  const b = plan({ usePreferences: false });
  assert.ok(b.length > 0);
  assert.equal(b[0]?.course_code, undefined);
  assert.equal(b[0]?.kind, undefined);
});

console.log("\n【5】硬约束没被破坏");

check("每天总量不超过 perDayMinutes", () => {
  const all = plan({ perDayMinutes: 90 });
  const byDate = new Map<string, number>();
  for (const b of all) byDate.set(b.date, (byDate.get(b.date) ?? 0) + b.minutes);
  for (const [d, m] of byDate) assert.ok(m <= 90, `${d} 排了 ${m} 分钟`);
});

check("绝不占用上课时间（周一 08:00-09:30）", () => {
  const mon = plan({}).filter((b) => b.date === T0);
  for (const b of mon) {
    const overlap = toMin(b.start) < toMin("09:30") && toMin(b.end) > toMin("08:00");
    assert.equal(overlap, false, `${b.start}-${b.end} 撞课了`);
  }
});

check("有可用网课的科目排「看网课」", () => {
  db.prepare(
    `INSERT INTO course_resource (course_code, kind, title, local_status) VALUES ('DS','netcourse','CS50','available')`,
  ).run();
  const tue = plan({}).filter((x) => x.date === addDays(T0, 1));
  const dsBlocks = tue.filter((b) => b.course_code === "DS");
  assert.ok(
    dsBlocks.some((b) => b.kind === "netcourse"),
    "DS 有网课却没排成 netcourse",
  );
});

console.log("\n【6】tasksForDay 直接测（不依赖排期落位）");

check("有课的日子：温习合并同名课，且不超过当天一半", () => {
  const occs = [
    { date: T0, category: "academic", title: "数据结构", course_code: "DS" },
    { date: T0, category: "academic", title: "数据结构", course_code: "DS" },
  ];
  const t = tasksForDay(db, occs, T0, 60);
  const reviews = t.filter((x) => x.kind === "review");
  assert.equal(reviews.length, 1, `两节同名课应合并成 1 条温习，实际 ${reviews.length}`);
  assert.ok(reviews[0]?.label.includes("数据结构"));
  const reviewMin = reviews.reduce((n, x) => n + x.minutes, 0);
  assert.ok(reviewMin <= 30, `60 分钟里温习占了 ${reviewMin}，超过一半`);
});

check("没课且没有任何投入配置时给出兜底任务（不静默丢时间）", () => {
  db.prepare("DELETE FROM habit WHERE dimension='investment'").run();
  const t = tasksForDay(db, [], addDays(T0, 2), 60);
  assert.equal(t.length, 1);
  assert.equal(t[0]?.kind, "study");
  assert.equal(t[0]?.minutes, 60);
});

check("周几推算没被改动", () => {
  assert.equal(weekdayOf("2026-09-21"), 1);
});

console.log("\n【7】偏好时段的写法与作用域");

const hhmm = (w: { start: string; end: string } | null): [string, string] | null =>
  w ? [w.start, w.end] : null;

check("全角冒号 / 时段:21-24 / 21点-23点 / 8-9 都能解析（以前全被静默丢掉）", () => {
  assert.deepEqual(hhmm(parseWindowKey("14：00-16：00")), ["14:00", "16:00"]);
  assert.deepEqual(hhmm(parseWindowKey("时段:21-24")), ["21:00", "24:00"]);
  assert.deepEqual(hhmm(parseWindowKey("21点-23点")), ["21:00", "23:00"]);
  assert.deepEqual(hhmm(parseWindowKey("21:00~24:00")), ["21:00", "24:00"]);
  assert.deepEqual(hhmm(parseWindowKey(" 8-9 ")), ["08:00", "09:00"]);
});

check("跨午夜 / 胡写的一律返回 null，不瞎猜", () => {
  assert.equal(parseWindowKey("22:00-01:00"), null);
  assert.equal(parseWindowKey("晚上"), null);
  assert.equal(parseWindowKey("25:00-26:00"), null);
});

// 一条只属于 PHY2（且用全角冒号，复刻用户库里真实的那条），一条个人共用
db.prepare("DELETE FROM habit WHERE dimension IN ('study_window','study_time')").run();
addHabit("study_window", "14：00-16：00", "复习物理学", "PHY2");
addHabit("study_window", "20:00-22:00", "写代码", null);

check("科目专属时段参与排期（以前 SQL 只放行 course_code IS NULL）", () => {
  const phy = loadPlanWindows(db, ["PHY2"]);
  assert.ok(
    phy.some((w) => w.startMin === 14 * 60 && w.endMin === 16 * 60),
    `PHY2 的 14-16 时段没读到：${JSON.stringify(phy)}`,
  );
  const ds = loadPlanWindows(db, ["DS"]);
  assert.equal(
    ds.some((w) => w.startMin === 14 * 60),
    false,
    "DS 的排期不该用 PHY2 的专属时段",
  );
  assert.ok(
    ds.some((w) => w.startMin === 20 * 60),
    "共用时段应对任何科目都生效",
  );
});

check("不传科目时返回全部时段（界面预览要能看到专属的）", () => {
  assert.equal(loadPlanWindows(db).length, 2);
});

check("排期真的落进科目专属时段（周二无课，PHY2 14-16）", () => {
  const tue = addDays(T0, 1);
  const phy = plan({ courses: ["PHY2"] }).filter((b) => b.date === tue);
  assert.ok(
    phy.some((b) => b.start === "14:00"),
    `PHY2 的块没落进 14:00：${phy.map((b) => b.start).join(",")}`,
  );
  const ds = plan({ courses: ["DS"] }).filter((b) => b.date === tue);
  assert.equal(
    ds.some((b) => b.start === "14:00"),
    false,
    `DS 不该被排进 PHY2 的专属时段：${ds.map((b) => b.start).join(",")}`,
  );
});

check("重叠的偏好段合并，同一空档不会被消费两遍", () => {
  const segs = slotSegments(
    8 * 60,
    22 * 60,
    [
      { startMin: 8 * 60, endMin: 9 * 60, course_code: null, what: "共用" },
      { startMin: 8 * 60, endMin: 9 * 60, course_code: "PHY2", what: "本课" },
    ],
    25,
  );
  const pref = segs.filter((s) => s.pref);
  assert.equal(pref.length, 1, `重叠的偏好段应合并，实际 ${pref.length} 段`);
  assert.deepEqual(pref[0], { s: 8 * 60, e: 9 * 60, pref: true });
});

db.close();
for (const s of ["", "-wal", "-shm"]) rmSync(DB_FILE + s, { force: true });

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
