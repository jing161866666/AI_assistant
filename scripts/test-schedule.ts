import "dotenv/config";
import assert from "node:assert/strict";

// 与真实数据隔离
process.env.DB_PATH = "./data/test-schedule.db";

const { getLearnerDb } = await import("../src/db/index.js");
const {
  addDays,
  busyIntervalsOf,
  dateOfWeek,
  detectConflicts,
  expandOccurrences,
  freeSlotsOn,
  getActiveTerm,
  planStudy,
  resolveWeek,
  toMin,
  weekdayOf,
} = await import("../src/schedule/service.js");

const db = getLearnerDb();
const term = getActiveTerm(db);
const T0 = term.start_date;

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

console.log(`\n学期: ${term.name}  第1周周一=${T0}  共${term.total_weeks}周\n`);

const all = expandOccurrences(db, T0, addDays(T0, 16 * 7 - 1));
const on = (date: string, title: string) => all.filter((o) => o.date === date && o.title === title);

console.log("【1】单双周与周次范围");
check("第2周周三没有大学物理（单周课）", () => {
  assert.equal(on(dateOfWeek(T0, 2, 3), "大学物理").length, 0);
});
check("第3周周三有大学物理（但已调课，应为 0）", () => {
  assert.equal(on(dateOfWeek(T0, 3, 3), "大学物理").length, 0);
});
check("第1周周三有大学物理", () => {
  assert.equal(on(dateOfWeek(T0, 1, 3), "大学物理").length, 1);
});
check("大学物理总次数 = 8 次单周 - 停课 1 次 = 7", () => {
  const n = all.filter((o) => o.title === "大学物理").length;
  assert.equal(n, 7, `实际 ${n}`);
});
check("大学英语只到第 8 周，第 9 周已结束", () => {
  const late = all.filter((o) => o.title === "大学英语" && o.date >= dateOfWeek(T0, 9, 1));
  assert.equal(late.length, 0);
});
check("高等数学贯穿 16 周 = 16 次", () => {
  assert.equal(all.filter((o) => o.title === "高等数学A").length, 16);
});

console.log("\n【2】调课与停课（例外）");
check("第3周周四出现大学物理（调课结果）", () => {
  const got = on(dateOfWeek(T0, 3, 4), "大学物理");
  assert.equal(got.length, 1);
  assert.equal(got[0]!.fromException, true);
  assert.equal(got[0]!.start, "14:00");
});
check("第5周周三大学物理已停课", () => {
  assert.equal(on(dateOfWeek(T0, 5, 3), "大学物理").length, 0);
});

console.log("\n【3】跨午夜的时间块（睡觉 23:30–07:00）");
check("睡觉被拆成昨天尾段 + 今天头段", () => {
  const d = dateOfWeek(T0, 2, 3); // 周三
  const busy = busyIntervalsOf(all, d);
  const early = busy.filter(([s, e]) => s === 0 && e === 420); // 00:00-07:00
  const late = busy.filter(([s, e]) => s === 1410 && e === 1440); // 23:30-24:00
  assert.equal(early.length, 1, "缺凌晨 00:00-07:00 的睡眠占用");
  assert.equal(late.length, 1, "缺 23:30-24:00 的睡眠占用");
});

console.log("\n【4】用户意愿块不可被占用");
check("周三 19:00-21:00 打篮球不在空闲段内", () => {
  // 用第 2 周周三：该周是双周，没有大学物理，只有篮球，隔离干扰
  const d = dateOfWeek(T0, 2, 3);
  const slots = freeSlotsOn(db, all, d);
  const hit = slots.some((s) => toMin(s.start) < 1260 && toMin(s.end) > 1140);
  assert.equal(
    hit,
    false,
    `空闲段与篮球重叠: ${JSON.stringify(slots.map((s) => `${s.start}-${s.end}`))}`,
  );
});
check("周六兼职 09:00-17:00 整段不在空闲段内", () => {
  const d = dateOfWeek(T0, 2, 6);
  const slots = freeSlotsOn(db, all, d);
  const hit = slots.some((s) => toMin(s.start) < 1020 && toMin(s.end) > 540);
  assert.equal(hit, false, "空闲段与兼职重叠");
});

console.log("\n【5】时段偏好被识别（avoid → penalty）");
check("工作日 21:00 后的空闲段带惩罚", () => {
  const d = dateOfWeek(T0, 2, 3);
  const slots = freeSlotsOn(db, all, d);
  const late = slots.filter((s) => toMin(s.start) >= 1260);
  assert.ok(late.length > 0, "样例数据里没有 21:00 后的空档，无法验证");
  assert.ok(
    late.every((s) => s.penalty > 0),
    "21:00 后应全部带 avoid 惩罚",
  );
  assert.ok(late.some((s) => (s.reason ?? "").includes("效率低")));
});

console.log("\n【6】冲突检测");
check("种子数据本身无冲突", () => {
  const c = detectConflicts(all);
  assert.equal(c.length, 0, JSON.stringify(c.slice(0, 3)));
});

console.log("\n【7】学习计划排期");
const plan = planStudy(db, {
  from: T0,
  to: addDays(T0, 13), // 两周
  perDayMinutes: 180,
  minChunk: 30,
  maxChunk: 90,
});
console.log(
  `     生成 ${plan.length} 个学习块，共 ${plan.reduce((s, p) => s + p.minutes, 0)} 分钟`,
);

check("绝不与任何已占用时间重叠（含睡觉/篮球/兼职）", () => {
  const busyByDate = new Map<string, Array<[number, number]>>();
  for (const p of plan) {
    if (!busyByDate.has(p.date)) busyByDate.set(p.date, busyIntervalsOf(all, p.date));
    const busy = busyByDate.get(p.date)!;
    const ps = toMin(p.start);
    const pe = toMin(p.end);
    for (const [bs, be] of busy) {
      assert.ok(pe <= bs || ps >= be, `${p.date} ${p.start}-${p.end} 与占用 ${bs}-${be} 重叠`);
    }
  }
});

check("工作日不安排在 21:00 之后（avoid 生效）", () => {
  for (const p of plan) {
    if (weekdayOf(p.date) <= 5) {
      assert.ok(toMin(p.start) < 1260, `${p.date} 排到了 ${p.start}`);
    }
  }
});

check("周末不安排任何学习（周六日全 avoid）", () => {
  for (const p of plan) {
    assert.ok(weekdayOf(p.date) <= 5, `${p.date} 是周末却被排了学习`);
  }
});

check("单个块不超过 maxChunk(90)", () => {
  for (const p of plan) assert.ok(p.minutes <= 90, `${p.date} 有 ${p.minutes} 分钟的块`);
});

check("每天总量不超过 perDayMinutes(180)", () => {
  const byDay = new Map<string, number>();
  for (const p of plan) byDay.set(p.date, (byDay.get(p.date) ?? 0) + p.minutes);
  for (const [d, m] of byDay) assert.ok(m <= 180, `${d} 排了 ${m} 分钟`);
});

check("每周总量不超过周上限 900 分钟", () => {
  const byWeek = new Map<number, number>();
  for (const p of plan) {
    const wk = resolveWeek(p.date, T0);
    byWeek.set(wk, (byWeek.get(wk) ?? 0) + p.minutes);
  }
  for (const [wk, m] of byWeek) {
    assert.ok(m <= 900, `第 ${wk} 周排了 ${m} 分钟，超过 900`);
  }
});

console.log(`\n${"─".repeat(56)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
