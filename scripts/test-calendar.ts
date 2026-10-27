import "dotenv/config";
import assert from "node:assert/strict";
import { getLearnerDb } from "../src/db/index.js";
import {
  addDays,
  dateOfWeek,
  expandOccurrences,
  getActiveTerm,
  isStudyAllowed,
  planStudy,
  resolveWeek,
  weekdayOf,
} from "../src/schedule/service.js";

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

const from = "2026-09-20"; // 必须从调休日之前开始，否则 9/20 不在展开区间内
const to = addDays(T0, term.total_weeks * 7 - 1);
const all = expandOccurrences(db, from, to);
const titlesOn = (d: string): string[] =>
  all.filter((o) => o.date === d && o.category === "academic").map((o) => o.title);

console.log(`\n学期 ${term.name}  第1周周一=${T0}  共${term.total_weeks}周`);
console.log(
  `第6周 = ${dateOfWeek(T0, 6, 1)} ~ ${dateOfWeek(T0, 6, 7)}（应与课表截图 10.26–11.01 一致）\n`,
);

console.log("【1】校历基础换算");
check("2026-09-21 是周一，为第 1 周第 1 天", () => {
  assert.equal(weekdayOf(T0), 1);
  assert.equal(resolveWeek(T0, T0), 1);
});
check("10.26 属于第 6 周，与截图表头一致", () => {
  assert.equal(resolveWeek("2026-10-26", T0), 6);
});
check("2027-01-24 是第 18 周周日，与校历学期末一致", () => {
  assert.equal(weekdayOf("2027-01-24"), 7);
  assert.equal(resolveWeek("2027-01-24", T0), 18);
});

console.log("\n【2】调休：9/20（周日）补 10/6（第3周周二）的课");
check("9/20 是周日，且在学期开始之前（第 0 周）", () => {
  assert.equal(weekdayOf("2026-09-20"), 7);
  assert.equal(resolveWeek("2026-09-20", T0), 0);
});
check("9/20 仍能展开出周二的全部 5 门课", () => {
  const got = titlesOn("2026-09-20");
  assert.equal(got.length, 5, `实际 ${got.length}: ${got.join("/")}`);
  assert.deepEqual(
    got.sort(),
    ["Python编程", "人工智能导论", "概率统计与随机过程", "社会主义发展史", "计算机组成原理"].sort(),
  );
});
check("9/20 的课标记为 fromMakeup", () => {
  assert.ok(all.filter((o) => o.date === "2026-09-20").every((o) => o.fromMakeup === true));
});
check("10/6（原周二）当天无课", () => {
  assert.equal(titlesOn("2026-10-06").length, 0);
});

console.log("\n【3】调休：10/10（周六）补 10/7（第3周周三）的课");
check("10/10 是周六", () => {
  assert.equal(weekdayOf("2026-10-10"), 6);
});
check("10/10 只有周三那门计算机组成原理", () => {
  const got = titlesOn("2026-10-10");
  assert.deepEqual(got, ["计算机组成原理"]);
});
check("10/7（原周三）当天无课", () => {
  assert.equal(titlesOn("2026-10-07").length, 0);
});

console.log("\n【4】节假日停课");
check("国庆 10/1–10/7 全部无课", () => {
  for (let d = "2026-10-01"; d <= "2026-10-07"; d = addDays(d, 1)) {
    assert.equal(titlesOn(d).length, 0, `${d} 仍有课: ${titlesOn(d).join("/")}`);
  }
});
check("中秋 9/25–9/27 全部无课（不调休）", () => {
  for (let d = "2026-09-25"; d <= "2026-09-27"; d = addDays(d, 1)) {
    assert.equal(titlesOn(d).length, 0, `${d} 仍有课`);
  }
});
check("校运会 11/5–11/7 全部无课（停课不补）", () => {
  for (let d = "2026-11-05"; d <= "2026-11-07"; d = addDays(d, 1)) {
    assert.equal(titlesOn(d).length, 0, `${d} 仍有课`);
  }
});
check("11/4（校运会前一天）课照常", () => {
  assert.ok(titlesOn("2026-11-04").length > 0);
});
check("第 17–18 周停课复习，无课", () => {
  assert.equal(titlesOn(dateOfWeek(T0, 17, 1)).length, 0);
  assert.equal(titlesOn(dateOfWeek(T0, 18, 4)).length, 0);
});

console.log("\n【5】截图那一周（第 6 周）的课表必须与图片一致");
check("周一 10/26: 物理II / 数据结构 / 马原", () => {
  const got = titlesOn("2026-10-26");
  assert.ok(got.includes("大学物理(B)II"));
  assert.equal(got.filter((t) => t === "数据结构").length, 1);
  assert.ok(got.includes("马克思主义基本原理"));
});
check("周二 10/27: 5 门课", () => {
  assert.equal(titlesOn("2026-10-27").length, 5);
});
check("周三 10/28: 只有计算机组成原理", () => {
  assert.deepEqual(titlesOn("2026-10-28"), ["计算机组成原理"]);
});
check("周四 10/29: 4 门课", () => {
  assert.equal(titlesOn("2026-10-29").length, 4);
});
check("周五 10/30: 物理实验 + 概率统计", () => {
  assert.equal(titlesOn("2026-10-30").length, 2);
});
check("周六日 10/31、11/1: 无课", () => {
  assert.equal(titlesOn("2026-10-31").length, 0);
  assert.equal(titlesOn("2026-11-01").length, 0);
});
check("课程时间按节次换算正确（概率统计 1-2 节 = 08:00-09:35）", () => {
  const o = all.find((x) => x.date === "2026-10-27" && x.title === "概率统计与随机过程");
  assert.ok(o, "未找到该课");
  assert.equal(o.start, "08:00");
  assert.equal(o.end, "09:35");
});

console.log("\n【6】学期总次数（校历抑制后）");
check("计算机组成原理：自然周三 18-国庆1-考试2 = 15 次", () => {
  const n = all.filter(
    (o) => o.title === "计算机组成原理" && weekdayOf(o.date) === 3 && !o.fromMakeup,
  ).length;
  assert.equal(n, 15, `实际 ${n}`);
});
check("计算机组成原理：自然周二 18-国庆1-考试2 = 15 次", () => {
  const n = all.filter(
    (o) => o.title === "计算机组成原理" && weekdayOf(o.date) === 2 && !o.fromMakeup,
  ).length;
  assert.equal(n, 15, `实际 ${n}`);
});
check("另有 2 次落在调休日（周六补周三、周日补周二）", () => {
  const n = all.filter((o) => o.title === "计算机组成原理" && o.fromMakeup).length;
  assert.equal(n, 2, `实际 ${n}`);
  const sat = all.find((o) => o.title === "计算机组成原理" && o.date === "2026-10-10");
  const sun = all.find((o) => o.title === "计算机组成原理" && o.date === "2026-09-20");
  assert.ok(sat, "10/10 周六缺课");
  assert.ok(sun, "9/20 周日缺课");
});
check("该课全学期共 32 次（周内两次课，教师端聚合需按课程码合并）", () => {
  const n = all.filter((o) => o.title === "计算机组成原理").length;
  assert.equal(n, 32, `实际 ${n}`);
});
check("大学物理(B)II 周四 = 18 - 国庆1 - 校运会1 - 考试周2 = 14", () => {
  const n = all.filter((o) => o.title === "大学物理(B)II" && weekdayOf(o.date) === 4).length;
  assert.equal(n, 14, `实际 ${n}`);
});

console.log("\n【7】寒假不排学习");
check("2027-01-26 不允许排学习", () => {
  assert.equal(isStudyAllowed(db, "2027-01-26"), false);
});
check("寒假期间 planStudy 返回空", () => {
  const p = planStudy(db, { from: "2027-01-26", to: "2027-02-10", perDayMinutes: 120 });
  assert.equal(p.length, 0, `却排了 ${p.length} 块`);
});
check("学期内 planStudy 能排出东西", () => {
  const p = planStudy(db, { from: "2026-11-09", to: "2026-11-15", perDayMinutes: 120 });
  assert.ok(p.length > 0, "一个块都没排出来");
});

console.log(`\n${"─".repeat(58)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
