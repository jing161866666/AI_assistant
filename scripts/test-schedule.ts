import "dotenv/config";
import assert from "node:assert/strict";

// 与真实数据隔离
process.env.DB_PATH = "./data/test-schedule.db";

const { getLearnerDb } = await import("../src/db/index.js");
const {
  addDays,
  busyIntervalsOf,
  conflictsFor,
  dateOfWeek,
  detectConflicts,
  expandOccurrences,
  freeSlotsOn,
  getActiveTerm,
  getSchedule,
  listSchedule,
  planStudy,
  readStudyLimits,
  resolveWeek,
  toMin,
  weekdayOf,
} = await import("../src/schedule/service.js");
const {
  createSchedule,
  deleteOccupiable,
  deleteSchedule,
  listOccupiable,
  savePlanBlocks,
  saveStudyLimits,
  updateSchedule,
} = await import("../src/schedule/write.js");

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

console.log("\n【7-2】学习习惯：单次学习 / 单次休息上限");
check("默认上限是 60 / 5 分钟", () => {
  const l = readStudyLimits(db);
  assert.equal(l.maxBlockMinutes, 60);
  assert.equal(l.maxBreakMinutes, 5);
});

check("上限可以改，且落库后能读回", () => {
  const saved = saveStudyLimits(db, { maxBlockMinutes: 45, maxBreakMinutes: 10 });
  assert.deepEqual(saved, { maxBlockMinutes: 45, maxBreakMinutes: 10 });
  assert.deepEqual(readStudyLimits(db), { maxBlockMinutes: 45, maxBreakMinutes: 10 });
});

check("非法上限被拒绝（学习 5 分钟 / 休息 999 分钟）", () => {
  assert.throws(() => saveStudyLimits(db, { maxBlockMinutes: 5 }), /10–240/);
  assert.throws(() => saveStudyLimits(db, { maxBreakMinutes: 999 }), /0–60/);
});

check("排期按上限切块：单块 ≤ 45 分钟，且同段空闲内块间隔 ≤ 10 分钟", () => {
  const p = planStudy(db, { from: T0, to: addDays(T0, 6), perDayMinutes: 240, minChunk: 20 });
  assert.ok(p.length > 0, "没排出块");
  for (const b of p) assert.ok(b.minutes <= 45, `${b.date} ${b.start} 有 ${b.minutes} 分钟`);
  const byDate = new Map<string, typeof p>();
  for (const b of p) byDate.set(b.date, [...(byDate.get(b.date) ?? []), b]);
  for (const [d, list] of byDate) {
    const sorted = [...list].sort((x, y) => toMin(x.start) - toMin(y.start));
    for (let i = 1; i < sorted.length; i++) {
      const gap = toMin(sorted[i]!.start) - toMin(sorted[i - 1]!.end);
      assert.ok(gap >= 0, `${d} 有块重叠`);
      // 同一段空闲里连排的块，间隔必须 ≤ 休息上限；若间隔更大，说明中间被课/别的安排隔开（课间，不算休息）
      if (gap > 10) {
        const busy = busyIntervalsOf(all, d);
        const overlapsBusy = busy.some(
          ([bs, be]) => be > toMin(sorted[i - 1]!.end) && bs < toMin(sorted[i]!.start),
        );
        assert.ok(
          overlapsBusy,
          `${d} ${sorted[i - 1]!.end}→${sorted[i]!.start} 隔了 ${gap} 分钟且不是课间`,
        );
      }
    }
  }
});

check("恢复默认 60 / 5，避免污染后续用例", () => {
  const saved = saveStudyLimits(db, { maxBlockMinutes: 60, maxBreakMinutes: 5 });
  assert.deepEqual(saved, { maxBlockMinutes: 60, maxBreakMinutes: 5 });
});

console.log("\n【8】用户自己增删改日程（不动已有种子数据）");
/** 种子快照：测试前后必须逐行一致，证明增删改只影响自测行 */
const snapshot = (): string[] =>
  listSchedule(db).map(
    (r) =>
      `${r.id}|${r.title}|${r.start_time}|${r.end_time}|${r.weekday}|${r.date}|${r.week_start}|${r.week_end}|${r.week_parity}`,
  );
const seedRows = snapshot();
const created: number[] = [];

// 自测行：一次性日程，放在周三早上（避开睡眠 23:30–07:00 与正课）
const SELF_DATE = dateOfWeek(T0, 1, 5);
let oneOffId = 0;

check("能新建一次性日程并落到具体日期", () => {
  oneOffId = createSchedule(db, {
    title: "日程自测-一次性",
    category: "life",
    recurring: 0,
    date: SELF_DATE,
    start_time: "07:10",
    end_time: "07:40",
    flexibility: 1,
  });
  created.push(oneOffId);
  assert.ok(oneOffId > 0);
  const hit = expandOccurrences(db, SELF_DATE, SELF_DATE).filter((o) => o.scheduleId === oneOffId);
  assert.equal(hit.length, 1, "新建的一次性日程没有出现在展开结果里");
  assert.equal(hit[0]!.start, "07:10");
});

check("能新建每周重复日程（含单双周）", () => {
  const id = createSchedule(db, {
    title: "日程自测-每周",
    category: "rest",
    recurring: 1,
    weekday: 5,
    start_time: "18:00",
    end_time: "19:00",
    week_start: 1,
    week_end: 4,
    week_parity: "odd",
    flexibility: 2,
  });
  created.push(id);
  const row = getSchedule(db, id)!;
  assert.equal(row.recurring, 1);
  assert.equal(row.week_parity, "odd");
  assert.equal(row.week_end, 4);
  // 只有第 1、3 周出现
  assert.equal(
    expandOccurrences(db, T0, addDays(T0, 27)).filter((o) => o.scheduleId === id).length,
    2,
    "odd 单双周未生效",
  );
});

check("拒绝非法时间格式", () => {
  assert.throws(
    () =>
      createSchedule(db, {
        title: "坏时间",
        category: "life",
        recurring: 0,
        date: SELF_DATE,
        start_time: "9:00",
        end_time: "10:00",
      }),
    /HH:MM/,
  );
});

check("拒绝开始=结束", () => {
  assert.throws(
    () =>
      createSchedule(db, {
        title: "零时长",
        category: "life",
        recurring: 0,
        date: SELF_DATE,
        start_time: "08:00",
        end_time: "08:00",
      }),
    /不能相同/,
  );
});

check("拒绝每周重复但不给星期几", () => {
  assert.throws(
    () =>
      createSchedule(db, {
        title: "没星期",
        category: "life",
        recurring: 1,
        start_time: "08:00",
        end_time: "09:00",
      }),
    /星期几/,
  );
});

check("拒绝一次性日程不给日期", () => {
  assert.throws(
    () =>
      createSchedule(db, {
        title: "没日期",
        category: "life",
        recurring: 0,
        start_time: "08:00",
        end_time: "09:00",
      }),
    /日期/,
  );
});

check(`拒绝超出学期总周数（${term.total_weeks} 周）`, () => {
  assert.throws(
    () =>
      createSchedule(db, {
        title: "超周",
        category: "life",
        recurring: 1,
        weekday: 2,
        start_time: "08:00",
        end_time: "09:00",
        week_start: 1,
        week_end: term.total_weeks + 1,
      }),
    /总周数/,
  );
});

check("修改时间后立即生效，并被标记 locked", () => {
  const row = updateSchedule(db, oneOffId, { start_time: "07:20", end_time: "07:50" });
  assert.equal(row.start_time, "07:20");
  assert.equal(row.end_time, "07:50");
  assert.equal(row.locked, 1, "用户手改过的行必须锁定，模型不得覆盖");
  const hit = expandOccurrences(db, SELF_DATE, SELF_DATE).filter((o) => o.scheduleId === oneOffId);
  assert.equal(hit.length, 1);
  assert.equal(hit[0]!.start, "07:20");
});

check("修改成非法值被拒绝，且原值不被破坏", () => {
  assert.throws(() => updateSchedule(db, oneOffId, { start_time: "7:20" }), /HH:MM/);
  assert.equal(getSchedule(db, oneOffId)!.start_time, "07:20");
});

check("在与已有课重叠时给出冲突提示（只提示，不阻止保存）", () => {
  // 第 1 周周三 14:00-15:40 是大学物理
  const id = createSchedule(db, {
    title: "日程自测-重叠",
    category: "life",
    recurring: 1,
    weekday: 3,
    start_time: "14:00",
    end_time: "16:00",
    week_start: 1,
    week_end: 1,
    flexibility: 1,
  });
  created.push(id);
  const notes = conflictsFor(db, id);
  assert.ok(notes.length > 0, "与大学物理重叠却没提示");
  assert.ok(notes[0]!.detail.includes("重叠"));
});

check("删除一次性日程后从展开结果里消失", () => {
  assert.equal(deleteSchedule(db, oneOffId), true);
  const left = expandOccurrences(db, SELF_DATE, SELF_DATE).filter((o) => o.scheduleId === oneOffId);
  assert.equal(left.length, 0);
});

check("删除不存在的 id 返回 false", () => {
  assert.equal(deleteSchedule(db, 999_999), false);
});

// 清理自测行（成功路径已删掉的会返回 false，无害）
for (const id of created) deleteSchedule(db, id);

check("清理后没有留下任何自测行", () => {
  const leftovers = listSchedule(db).filter((r) => r.title.startsWith("日程自测"));
  assert.equal(leftovers.length, 0, JSON.stringify(leftovers.map((r) => r.title)));
});

check("已有日程（种子数据）逐行未被改动", () => {
  assert.deepEqual(snapshot(), seedRows);
});

console.log("\n【9】把排期建议保存进日程");
const planToSave = planStudy(db, {
  from: T0,
  to: addDays(T0, 4),
  perDayMinutes: 120,
  minChunk: 30,
});
let savedIds: number[] = [];

check("保存建议：每块都落库，且能在展开结果里找到", () => {
  const r = savePlanBlocks(
    db,
    planToSave.map((b) => ({ date: b.date, start: b.start, end: b.end })),
  );
  savedIds = r.written;
  assert.equal(r.skipped.length, 0, `有块被跳过: ${JSON.stringify(r.skipped.slice(0, 2))}`);
  assert.equal(r.written.length, planToSave.length);
  const occ = expandOccurrences(db, T0, addDays(T0, 4)).filter((o) =>
    r.written.includes(o.scheduleId),
  );
  assert.equal(occ.length, planToSave.length);
});

check("保存出来的行是「学习计划」类别、可被占用且被锁定", () => {
  const row = getSchedule(db, savedIds[0]!);
  assert.ok(row, "找不到刚写入的行");
  assert.equal(row.category, "plan");
  assert.equal(row.type, "plan");
  assert.equal(row.flexibility, 2);
  assert.equal(row.locked, 1, "用户点过保存，就应该锁定，模型不得覆盖");
});

check("与已有安排冲突的块被跳过并给出原因", () => {
  // 第 1 周周三 14:00-15:40 是大学物理
  const r = savePlanBlocks(db, [{ date: dateOfWeek(T0, 1, 3), start: "14:00", end: "15:00" }]);
  assert.equal(r.written.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0]!.reason, /重叠/);
});

check("同一批里互相重叠的块只写第一块", () => {
  const d = dateOfWeek(T0, 2, 5);
  const r = savePlanBlocks(db, [
    { date: d, start: "06:00", end: "06:30" },
    { date: d, start: "06:15", end: "06:45" },
  ]);
  savedIds.push(...r.written);
  assert.equal(r.written.length, 1);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0]!.reason, /重叠/);
});

check("格式非法的块被拒绝（不写库）", () => {
  const bad = savePlanBlocks(db, [{ date: "2026-13-40", start: "08:00", end: "09:00" }]);
  assert.equal(bad.written.length, 0);
  assert.equal(bad.skipped[0]!.reason, "日期格式不对");
  const badTime = savePlanBlocks(db, [{ date: dateOfWeek(T0, 2, 5), start: "8:00", end: "09:00" }]);
  assert.equal(badTime.written.length, 0);
  assert.match(badTime.skipped[0]!.reason, /时间格式/);
  const reversed = savePlanBlocks(db, [
    { date: dateOfWeek(T0, 2, 5), start: "10:00", end: "09:00" },
  ]);
  assert.equal(reversed.written.length, 0);
  assert.match(reversed.skipped[0]!.reason, /晚于/);
});

// 清理第 9 节写入的行，恢复原状
for (const id of savedIds) deleteSchedule(db, id);

check("清理后日程恢复原样（种子逐行不变）", () => {
  assert.deepEqual(snapshot(), seedRows);
});

console.log("\n【10】批量清空「可被学习计划占用」的日程（flexibility=2）");

const beforeBulk = listOccupiable(db);
const bulkDay = dateOfWeek(T0, 3, 2);
const mk = (title: string, flexibility: 0 | 1 | 2): number =>
  createSchedule(db, {
    title,
    category: flexibility === 2 ? "plan" : "life",
    type: "other",
    date: bulkDay,
    start_time: "06:00",
    end_time: "06:30",
    recurring: 0,
    week_start: 1,
    week_end: 1,
    flexibility,
  });
const idOcc = mk("批量自测-可占用", 2);
const idFixed = mk("批量自测-不可动", 0);
const idLoose = mk("批量自测-可微调", 1);

check("预览只列出可被占用的那批（不碰正课与可微调）", () => {
  const rows = listOccupiable(db);
  assert.equal(rows.length, beforeBulk.length + 1);
  assert.ok(
    rows.some((r) => r.id === idOcc),
    "可占用的块没被列出来",
  );
  assert.equal(
    rows.some((r) => r.id === idFixed),
    false,
    "正课不该出现在可清理清单里",
  );
  assert.equal(
    rows.some((r) => r.id === idLoose),
    false,
    "可微调的行不该出现在可清理清单里",
  );
});

check("批量删除只删 flexibility=2，其余行照旧，且返回删掉的行", () => {
  const removed = deleteOccupiable(db);
  assert.equal(removed.length, beforeBulk.length + 1);
  assert.ok(
    removed.some((r) => r.id === idOcc && r.title === "批量自测-可占用"),
    "返回值里应有被删的行（界面要回报删了什么）",
  );
  assert.equal(listOccupiable(db).length, 0);
  assert.ok(getSchedule(db, idFixed), "不可动的日程被误删了");
  assert.ok(getSchedule(db, idLoose), "可微调的日程被误删了");
  assert.equal(getSchedule(db, idOcc), null, "可占用的日程没被删");
});

check("没有可清理的行时是空操作（幂等，不报错）", () => {
  assert.equal(deleteOccupiable(db).length, 0);
  assert.equal(listOccupiable(db).length, 0);
});

// 收尾：删掉本节造的两条非可占用行
deleteSchedule(db, idFixed);
deleteSchedule(db, idLoose);

console.log(`\n${"─".repeat(56)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
