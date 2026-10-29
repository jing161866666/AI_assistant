import "dotenv/config";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getTurn, listTurns, saveTurn } from "../src/memory/conversation.js";
import {
  buildActivityDigest,
  drain,
  enqueueHabitExtraction,
  habitQueueState,
  setHabitExtractor,
} from "../src/memory/habit-pipeline.js";

/**
 * 持久化层测试：对话落库 + 习惯流水线排队/去重。
 *
 * 用独立临时库，不碰 data/learner.db（那边的真实数据有测试之外的价值）。
 * 不联网：习惯抽取的模型调用被替换成桩函数。
 */

// 每次跑用独立文件：避免上一次失败留下的数据把断言搞坏（也别和别的套件抢同一个库）
const DB_FILE = resolve(`data/test-persist-${process.pid}.db`);
for (const suffix of ["", "-wal", "-shm"]) rmSync(DB_FILE + suffix, { force: true });

const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA foreign_keys = ON");
db.exec(readFileSync(resolve("db/schema/learner.sql"), "utf8"));

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

console.log("【1】解题/批改写入 conversation + message + event");

const solveTurn = saveTurn(db, {
  course: "PHY2",
  kind: "solve",
  question: "光滑斜面倾角 30°，高 h，求底端速度",
  answer: "由机械能守恒 v = √(2gh)。\n【扩充解析】考点：机械能守恒",
  source: "bank-no-answer",
  qno: "0148",
  bank: { qno: "0148", kind: "选择题", score: 0.967, chapter: "刚体", has_answer: false },
  model: "qwen3.8-max",
  ms: 41000,
  citations: 3,
  detail: "full",
});

await check("返回三个 id", () => {
  assert.ok(solveTurn.conversationId > 0);
  assert.ok(solveTurn.userMessageId > 0);
  assert.ok(solveTurn.assistantMessageId > 0);
  assert.ok(solveTurn.assistantMessageId > solveTurn.userMessageId);
});

await check("user 消息里带题目原文", () => {
  const row = db
    .prepare("SELECT role, content FROM message WHERE id = ?")
    .get(solveTurn.userMessageId) as { role: string; content: string };
  assert.equal(row.role, "user");
  assert.ok(row.content.includes("光滑斜面"));
});

await check("assistant 消息存的是完整答案", () => {
  const row = db
    .prepare("SELECT role, content FROM message WHERE id = ?")
    .get(solveTurn.assistantMessageId) as { role: string; content: string };
  assert.equal(row.role, "assistant");
  assert.ok(row.content.includes("扩充解析"));
});

await check("event 里存了结构化 meta（题库/模型/耗时）", () => {
  const row = db
    .prepare("SELECT type, ref_type, payload FROM event WHERE ref_id = ?")
    .get(solveTurn.assistantMessageId) as { type: string; ref_type: string; payload: string };
  assert.equal(row.type, "solve");
  assert.equal(row.ref_type, "message");
  const meta = JSON.parse(row.payload);
  assert.equal(meta.source, "bank-no-answer");
  assert.equal(meta.qno, "0148");
  assert.equal(meta.model, "qwen3.8-max");
  assert.equal(meta.bank.score, 0.967);
});

const gradeTurn = saveTurn(db, {
  course: "PHY2",
  kind: "grade",
  question: "同上",
  studentInput: "我先算 a = g sin30",
  answer: "接着你的思路：……",
  grade: {
    verdict: "unsolved",
    input_kind: "process",
    error_type: "none",
    cause: "你给的是解题过程，已作为提示参考",
    hints: ["先写受力分析"],
    related_kps: ["牛顿第二定律"],
  },
});

await check("同科目同一天复用同一个 conversation", () => {
  assert.equal(gradeTurn.conversationId, solveTurn.conversationId);
});

await check("批改的判定快照能读回来（刷新恢复要用）", () => {
  const got = getTurn(db, gradeTurn.assistantMessageId);
  assert.ok(got);
  assert.equal(got.meta.kind, "grade");
  assert.equal(got.meta.grade?.input_kind, "process");
  assert.equal(got.meta.grade?.verdict, "unsolved");
  assert.ok(got.meta.grade?.hints.includes("先写受力分析"));
  assert.equal(got.answer, "接着你的思路：……");
});

await check("getTurn 对不存在的 id 返回 null", () => {
  assert.equal(getTurn(db, 999999), null);
});

await check("listTurns 按时间倒序、只返回本课程", () => {
  saveTurn(db, { course: "DS", kind: "solve", question: "LRU 缓存怎么实现", answer: "……" });
  const list = listTurns(db, "PHY2", 10);
  assert.equal(list.length, 2);
  assert.equal(list[0]?.assistantMessageId, gradeTurn.assistantMessageId);
  assert.ok(list.every((t) => t.meta.course === "PHY2"));
});

await check("不同科目分到不同 conversation", () => {
  const ds = listTurns(db, "DS", 10);
  assert.equal(ds.length, 1);
  assert.notEqual(ds[0]?.conversationId, solveTurn.conversationId);
});

console.log("\n【2】习惯抽取流水线：不阻塞、去重、串行");

let calls = 0;
setHabitExtractor(async () => {
  calls++;
  return { habits: [], enoughEvidence: true, model: "stub", ms: 1, written: 0 };
});

await check("材料太短不投递（<30 字不下结论）", () => {
  const r = enqueueHabitExtraction(db, {
    text: "太短了",
    kind: "chat",
    course: "PHY2",
    sourceType: "test",
    sourceId: 1,
  });
  assert.equal(r.queued, false);
  assert.ok(r.reason?.includes("太短"));
});

await check("正常材料立即返回（不等模型），随后队列被消费", async () => {
  const text = "【题目】光滑斜面倾角 30°，高 h\n\n【学生的写法】我先算 a = g sin30，再用 v²=2as";
  const r = enqueueHabitExtraction(db, {
    text,
    kind: "answer",
    course: "PHY2",
    sourceType: "review",
    sourceId: 2,
  });
  assert.equal(r.queued, true);
  await drain(db);
  assert.equal(calls, 1);
  const q1 = habitQueueState();
  assert.equal(q1.pending, 0);
  assert.equal(q1.running, false);
});

await check("同一份材料重复投递会被去重", () => {
  const text = "【题目】光滑斜面倾角 30°，高 h\n\n【学生的写法】我先算 a = g sin30，再用 v²=2as";
  const r = enqueueHabitExtraction(db, {
    text,
    kind: "answer",
    course: "PHY2",
    sourceType: "review",
    sourceId: 3,
  });
  assert.equal(r.queued, false);
  assert.ok(r.reason?.includes("已抽过"));
});

await check("抽取抛错不会把流水线打死", async () => {
  setHabitExtractor(async () => {
    throw new Error("模拟限流");
  });
  enqueueHabitExtraction(db, {
    text: "另一段足够长的材料，用来验证抽取失败之后队列还能继续工作。",
    kind: "chat",
    course: "PHY2",
    sourceType: "test",
    sourceId: 4,
  });
  await drain(db);
  const q2 = habitQueueState();
  assert.equal(q2.pending, 0);
  assert.equal(q2.running, false);
});

console.log("\n【3】行为摘要（日程 / 错题 / 进度 → 习惯原料）");

await check("没有行为时摘要为空，不投递", () => {
  const empty = new DatabaseSync(":memory:");
  empty.exec(readFileSync(resolve("db/schema/learner.sql"), "utf8"));
  const d = buildActivityDigest(empty, "PHY2");
  assert.equal(d.empty, true);
  empty.close();
});

await check("有做题/错题/日程时摘要包含对应事实", () => {
  db.prepare("INSERT INTO event (type, payload) VALUES ('solve','{}')").run();
  db.prepare("INSERT INTO event (type, payload) VALUES ('review','{}')").run();
  db.prepare(
    "INSERT INTO mistake (course_code, title, error_type, resolved) VALUES ('PHY2','某题','unit',0)",
  ).run();
  db.prepare(
    "INSERT INTO schedule (title, category, course_code, weekday) VALUES ('大学物理','academic','PHY2',3)",
  ).run();
  db.prepare(
    "INSERT INTO chapter_progress (course_code, chapter_no, status) VALUES ('PHY2',11,'done')",
  ).run();

  const d = buildActivityDigest(db, "PHY2");
  assert.equal(d.empty, false);
  assert.ok(d.text.includes("做题活动"));
  assert.ok(d.text.includes("unit 1"));
  assert.ok(d.text.includes("正课"));
  assert.ok(d.text.includes("第 11 章"));
});

db.close();
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix, { force: true });
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
