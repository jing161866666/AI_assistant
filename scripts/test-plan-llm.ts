import "dotenv/config";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  buildPlanContext,
  type ProposedBlock,
  proposePlanWithLlm,
  setPlanProposer,
  validateProposal,
} from "../src/schedule/plan-llm.js";
import { addDays } from "../src/schedule/service.js";

/**
 * 「模型排期 + 代码校验」测试。
 *
 * 关键断言：模型给的块只要撞课 / 超上限 / 重叠，就必须被拒并带上原因，
 * 绝不能"悄悄修正"或"照单全收"——排期错了学生按错的时间表走。
 */

const DB_FILE = resolve(`data/test-planllm-${process.pid}.db`);
for (const s of ["", "-wal", "-shm"]) rmSync(DB_FILE + s, { force: true });
const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA foreign_keys = ON");
db.exec(readFileSync(resolve("db/schema/learner.sql"), "utf8"));

const T0 = "2026-09-21"; // 周一
db.prepare("INSERT INTO term (name, start_date, total_weeks, is_active) VALUES (?,?,?,1)").run(
  "2026-2027-1",
  T0,
  20,
);
db.prepare(
  `INSERT INTO schedule (title, type, category, course_code, weekday, start_time, end_time,
     recurring, week_start, week_end, week_parity, flexibility)
   VALUES ('数据结构','course','academic','DS',1,'08:00','09:30',1,1,20,'all',0)`,
).run();

const opts = {
  from: T0,
  to: addDays(T0, 6),
  perDayMinutes: 120,
  minChunk: 25,
  maxChunk: 60,
  weekCap: null,
};

const blk = (b: Partial<ProposedBlock>): ProposedBlock => ({
  date: T0,
  start: "19:00",
  end: "20:00",
  course_code: "DS",
  kind: "review",
  task: "温习第 3 章",
  source_kind: "none",
  source_ref: "",
  reason: "当天有课",
  ...b,
});

let pass = 0;
let fail = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${(e as Error).message.split("\n")[0]}`);
  }
}

console.log("【1】硬约束：模型说了不算，代码说了算");

await check("合法块通过", () => {
  const r = validateProposal(db, [blk({})], opts);
  assert.equal(r.accepted.length, 1);
  assert.equal(r.rejected.length, 0);
  assert.equal(r.accepted[0]?.minutes, 60);
});

await check("撞上课（周一 08:00-09:30）被拒", () => {
  const r = validateProposal(db, [blk({ start: "08:30", end: "09:00" })], opts);
  assert.equal(r.accepted.length, 0);
  assert.ok(r.rejected[0]?.why.includes("重叠"), r.rejected[0]?.why);
});

await check("单块超上限被拒（模型常写 90 分钟）", () => {
  const r = validateProposal(db, [blk({ start: "19:00", end: "20:30" })], opts);
  assert.equal(r.accepted.length, 0);
  assert.ok(r.rejected[0]?.why.includes("超过单次上限"));
});

await check("太短的块被拒", () => {
  const r = validateProposal(db, [blk({ start: "19:00", end: "19:10" })], opts);
  assert.equal(r.accepted.length, 0);
  assert.ok(r.rejected[0]?.why.includes("短于最小块"));
});

await check("超每日上限被拒（连给 3 个 60 分钟，只收 2 个）", () => {
  const r = validateProposal(
    db,
    [
      blk({ start: "19:00", end: "20:00" }),
      blk({ start: "20:05", end: "21:05" }),
      blk({ start: "21:10", end: "22:10" }),
    ],
    opts,
  );
  assert.equal(r.accepted.length, 2, `实际收下 ${r.accepted.length}`);
  assert.ok(r.rejected[0]?.why.includes("每日上限"));
});

await check("同一天块互相重叠被拒", () => {
  const r = validateProposal(
    db,
    [blk({ start: "19:00", end: "20:00" }), blk({ start: "19:30", end: "20:20" })],
    opts,
  );
  assert.equal(r.accepted.length, 1);
  assert.ok(r.rejected[0]?.why.includes("同一天"));
});

await check("日期越界被拒", () => {
  const r = validateProposal(db, [blk({ date: addDays(T0, 30) })], opts);
  assert.equal(r.accepted.length, 0);
  assert.ok(r.rejected[0]?.why.includes("不在排期区间"));
});

await check("时间格式不对被拒（模型偶尔给 7:00）", () => {
  const r = validateProposal(db, [blk({ start: "7:00", end: "8:00" })], opts);
  assert.equal(r.accepted.length, 0);
  assert.ok(r.rejected[0]?.why.includes("格式"));
});

console.log("\n【2】模型失败 / 给坏块时的行为");

await check("模型给 2 好 1 坏：好的收下，坏的带原因返回", async () => {
  setPlanProposer(async () => [
    blk({ start: "19:00", end: "20:00" }),
    blk({ start: "20:10", end: "21:10" }),
    blk({ start: "08:30", end: "09:00" }), // 撞课
  ]);
  const r = await proposePlanWithLlm(db, {
    ...opts,
    from: T0,
    to: addDays(T0, 6),
    profileText: "【学生画像】测试",
  });
  assert.equal(r.ok, true);
  assert.equal(r.blocks.length, 2);
  assert.equal(r.dropped.length, 1);
  assert.ok(r.dropped[0]?.why.includes("重叠"));
});

await check("模型抛错：ok=false，交给调用方回退规则版（不抛给用户）", async () => {
  setPlanProposer(async () => {
    throw new Error("模拟限流");
  });
  const r = await proposePlanWithLlm(db, { ...opts, profileText: "x" });
  assert.equal(r.ok, false);
  assert.equal(r.blocks.length, 0);
});

await check("模型返回空方案：ok=false", async () => {
  setPlanProposer(async () => []);
  const r = await proposePlanWithLlm(db, { ...opts, profileText: "x" });
  assert.equal(r.ok, false);
});

console.log("\n【3】给模型的上下文里必须带上画像与空档");

await check("上下文包含画像原文与每天空档", async () => {
  let seen = "";
  setPlanProposer(async (ctx) => {
    seen = ctx;
    return [];
  });
  await proposePlanWithLlm(db, { ...opts, profileText: "【学生画像】偏好时段 20:00-22:00 写代码" });
  assert.ok(seen.includes("学生画像"));
  assert.ok(seen.includes("空闲时段"));
  assert.ok(seen.includes(T0));
  assert.ok(seen.includes("有课"), "应标出当天有课");
});

console.log("\n【4】「不想学」的时段：发给模型 + 代码硬排除");

db.prepare(
  `INSERT INTO time_preference (weekday_from, weekday_to, start_time, end_time, mode, applies_to, strength, reason)
   VALUES (1, 7, '12:00', '13:30', 'avoid', 'study', 3, '午休')`,
).run();

await check("模型把块排进午休：被拒，且原因说清是「不想学」", () => {
  const r = validateProposal(db, [blk({ start: "12:30", end: "13:00" })], opts);
  assert.equal(r.accepted.length, 0, "午休时段不该被接受");
  assert.match(String(r.rejected[0]?.why), /不想学/);
});

await check("午休前后的块照常通过（不是把所有中午都封掉）", () => {
  const r = validateProposal(db, [blk({ start: "11:00", end: "12:00" })], opts);
  assert.equal(r.accepted.length, 1);
  assert.equal(r.rejected.length, 0);
});

await check("跨过午休的长块也被拒", () => {
  const r = validateProposal(db, [blk({ start: "11:40", end: "12:40" })], opts);
  assert.equal(r.accepted.length, 0, "跨午休的块不该通过");
});

await check("提示词里明确列出「不能学习的时段」", () => {
  const ctx = buildPlanContext(db, {
    from: T0,
    to: addDays(T0, 6),
    perDayMinutes: 120,
    profileText: "",
    minChunk: 25,
    maxChunk: 60,
  });
  assert.match(ctx.text, /不能学习的时段/);
  assert.match(ctx.text, /12:00-13:30/);
  assert.ok(!/空档 [^\n]*12:30/.test(ctx.text), "午休不應出现在空档里");
});

db.close();
for (const s of ["", "-wal", "-shm"]) rmSync(DB_FILE + s, { force: true });

setTimeout(() => {
  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  if (fail > 0) process.exit(1);
}, 200);
