import "dotenv/config";
import { getLearnerDb } from "../src/db/index.js";
import { expandOccurrences, getActiveTerm, toMin } from "../src/schedule/service.js";

const db = getLearnerDb();
const term = getActiveTerm(db);
const all = expandOccurrences(db, "2026-09-19", "2026-11-08");

const WD = ["一", "二", "三", "四", "五", "六", "日"];

function show(d: string, label: string): void {
  const occ = all.filter((o) => o.date === d && o.category === "academic");
  const mark = occ.some((o) => o.fromMakeup) ? " ★调休补课" : "";
  const tag = occ.length === 0 ? "【无课】" : "";
  console.log(
    `\n${d} 周${WD[new Date(`${d}T00:00:00Z`).getUTCDay() === 0 ? 6 : new Date(`${d}T00:00:00Z`).getUTCDay() - 1]}  ${label}${tag}${mark}`,
  );
  for (const o of occ.sort((a, b) => toMin(a.start) - toMin(b.start))) {
    console.log(`    ${o.start}-${o.end}  ${o.title}`);
  }
}

console.log("═".repeat(64));
console.log(`校历生效演示  学期 ${term.name}  第1周周一 ${term.start_date}`);
console.log("═".repeat(64));

console.log("\n── 国庆调休 ──────────────────────────────────────");
show("2026-09-20", "周日（补第3周周二的课）");
show("2026-10-06", "周二（国庆假期，原定上课）");
show("2026-10-10", "周六（补第3周周三的课）");
show("2026-10-07", "周三（国庆假期，原定上课）");

console.log("\n── 校运会停课不补 ────────────────────────────────");
show("2026-11-04", "周三（校运会前一日，正常上课）");
show("2026-11-05", "周四（校运会）");
show("2026-11-06", "周五（校运会）");

console.log("\n── 正常一周（第 6 周，对应课表截图）──────────────");
for (let i = 0; i < 7; i++) {
  const d = new Date(Date.UTC(2026, 9, 26 + i));
  const s = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  show(s, "");
}
