import "dotenv/config";
import { getLearnerDb } from "../src/db/index.js";
import { dateOfWeek, getActiveTerm } from "../src/schedule/service.js";
import { describeUserContext, runTool } from "../src/schedule/tools.js";

const db = getLearnerDb();
const term = getActiveTerm(db);

console.log("═".repeat(70));
console.log("模型读到的用户上下文（每次回答前注入）");
console.log("═".repeat(70));
console.log(describeUserContext(db));

// 第 3 周：有调课，最能看出展开逻辑对不对
const from = dateOfWeek(term.start_date, 3, 1);
const to = dateOfWeek(term.start_date, 3, 7);

console.log("\n" + "═".repeat(70));
console.log(`第 3 周日程（${from} ~ ${to}）—— 注意周三物理调到周四`);
console.log("═".repeat(70));

const view = runTool(db, "schedule_view", { from, to }) as {
  days: Array<{
    date: string;
    weekday: string;
    week: number;
    blocks: Array<{
      title: string;
      start: string;
      end: string;
      category: string;
      intent: string | null;
    }>;
    free: Array<{ start: string; end: string; minutes: number; warning: string | null }>;
  }>;
};

for (const d of view.days) {
  const occupied = d.blocks.length
    ? d.blocks.map((b) => `${b.start}-${b.end} ${b.title}`).join(" | ")
    : "（无硬安排）";
  console.log(`\n周${d.weekday} ${d.date}`);
  console.log(`  占用: ${occupied}`);
  const free = d.free.map((f) => `${f.start}-${f.end}${f.warning ? " ⚠" : ""}`).join("  ");
  console.log(`  空闲: ${free || "（无）"}`);
}

console.log("\n" + "═".repeat(70));
console.log("模型请求排学习计划：第 4 周，每天 150 分钟");
console.log("═".repeat(70));
const plan = runTool(db, "schedule_plan_study", {
  from: dateOfWeek(term.start_date, 4, 1),
  to: dateOfWeek(term.start_date, 4, 7),
  minutes_per_day: 150,
}) as {
  blocks: Array<{ date: string; start: string; end: string; minutes: number }>;
  total_minutes: number;
};

for (const b of plan.blocks) {
  const wd = "一二三四五六日"[
    new Date(b.date + "T00:00:00Z").getUTCDay() === 0
      ? 6
      : new Date(b.date + "T00:00:00Z").getUTCDay() - 1
  ];
  console.log(`  周${wd} ${b.date}  ${b.start}-${b.end}  ${b.minutes} 分钟`);
}
console.log(`  ── 合计 ${plan.total_minutes} 分钟（周上限 900，未超）`);
