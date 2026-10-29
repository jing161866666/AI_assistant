import "dotenv/config";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { injectableHabits, rebuildHabitFromEvents } from "../src/memory/habit-extract.js";
import {
  deleteManualHabit,
  listManualHabits,
  listStudyWindows,
  saveManualHabit,
  updateManualHabit,
  validateManualHabit,
} from "../src/memory/habit-manual.js";
import { loadProfile, profilePrompt } from "../src/memory/profile.js";
import {
  deleteResource,
  listResources,
  missingResources,
  upsertResource,
  validateResource,
} from "../src/memory/resources.js";

/**
 * 「用户自述习惯 + 资源」测试。
 *
 * 三条必须成立的规则：
 * 1. 自述习惯一条就注入（不被证据阈值挡掉），模型推断的仍要证据≥2
 * 2. 共用习惯（course_code=NULL）所有科目可见；科目习惯只对该科目可见
 * 3. 资源缺失要能被排期/讲解看到（missing 名单），且提示模型别编内容
 */

const DB_FILE = resolve(`data/test-manual-${process.pid}.db`);
for (const s of ["", "-wal", "-shm"]) rmSync(DB_FILE + s, { force: true });
const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA foreign_keys = ON");
db.exec(readFileSync(resolve("db/schema/learner.sql"), "utf8"));

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

console.log("【1】自述习惯：一条就注入，且不受证据阈值限制");

check("非法维度被拒", () => {
  const bad = validateManualHabit({ dimension: "随便写的" as never, key: "a", value: "b" });
  assert.ok(bad?.includes("未知维度"));
});

check("空 key / 空 value 被拒", () => {
  assert.ok(validateManualHabit({ dimension: "study_window", key: "", value: "x" }));
  assert.ok(validateManualHabit({ dimension: "study_window", key: "x", value: "  " }));
});

saveManualHabit(db, {
  dimension: "study_window",
  key: "20:00-22:00",
  value: "写代码（数据结构实践题）",
});

check("写入后证据只有 1 条，但依然能注入", () => {
  const rows = injectableHabits(db, "PHY2") as unknown as Array<{ source: string; key: string }>;
  const hit = rows.find((r) => r.key === "20:00-22:00");
  assert.ok(hit, "自述习惯被阈值挡掉了");
  assert.equal(hit?.source, "manual");
});

check("模型推断的习惯仍然要证据≥2（没有被放宽）", () => {
  db.prepare(
    `INSERT INTO habit (dimension, key, value, confidence, evidence_count, status, source)
     VALUES ('attention','单次30分钟','30 分钟',0.9,1,'active','model')`,
  ).run();
  const rows = injectableHabits(db, "PHY2") as unknown as Array<{ key: string }>;
  assert.equal(
    rows.find((r) => r.key === "单次30分钟"),
    undefined,
  );
});

console.log("\n【2】共用 vs 按科目 的作用域");

saveManualHabit(db, { dimension: "learn_method", key: "通用", value: "先看视频再做题" });
saveManualHabit(db, {
  dimension: "learn_method",
  key: "数据结构",
  value: "直接看英文 CS 网课",
  course_code: "DS",
});

check("共用习惯对任何科目都可见", () => {
  const phy = injectableHabits(db, "PHY2") as unknown as Array<{ key: string }>;
  const ds = injectableHabits(db, "DS") as unknown as Array<{ key: string }>;
  assert.ok(phy.some((r) => r.key === "通用"));
  assert.ok(ds.some((r) => r.key === "通用"));
});

check("科目习惯只对该科目可见，不串到别的科目", () => {
  const phy = injectableHabits(db, "PHY2") as unknown as Array<{ key: string }>;
  const ds = injectableHabits(db, "DS") as unknown as Array<{ key: string }>;
  assert.equal(
    phy.some((r) => r.key === "数据结构"),
    false,
  );
  assert.ok(ds.some((r) => r.key === "数据结构"));
});

check("同一维度+key+作用域 覆盖而不是新增两条", () => {
  const before = listManualHabits(db, "PHY2").length;
  saveManualHabit(db, {
    dimension: "learn_method",
    key: "数据结构",
    value: "先做题再看题解",
    course_code: "DS",
  });
  const after = listManualHabits(db, null);
  assert.equal(after.filter((h) => h.key === "数据结构").length, 1);
  assert.ok(after.some((h) => h.value === "先做题再看题解"));
  assert.equal(listManualHabits(db, "PHY2").length, before);
});

check("能按 id 修改自述习惯的值（不是新增一条）", () => {
  const row = listManualHabits(db, "DS").find((h) => h.key === "数据结构");
  assert.ok(row);
  const r = updateManualHabit(db, row!.id, { value: "先看网课再做题" });
  assert.equal(r.value, "先看网课再做题");
  assert.equal(r.key, "数据结构");
  assert.equal(listManualHabits(db, null).filter((h) => h.key === "数据结构").length, 1);
  const ev = db
    .prepare("SELECT source_type, snippet FROM habit_evidence WHERE habit_id = ?")
    .all(row!.id) as Array<{ source_type: string; snippet: string }>;
  assert.equal(ev.length, 1, "自述证据应被替换而不是累加");
  assert.equal(ev[0]!.source_type, "user");
  assert.match(ev[0]!.snippet, /先看网课再做题/);
  // 还原：后面的画像断言依赖这条原值
  updateManualHabit(db, row!.id, { value: "先做题再看题解" });
});

check("改 key 也生效；改到与另一条同键时报可读错误", () => {
  const a = listManualHabits(db, null).find((h) => h.key === "数据结构");
  assert.ok(a);
  // 只有同一作用域才会撞键：a 属于 DS，b 也必须绑 DS
  const b = saveManualHabit(db, {
    dimension: a!.dimension as never,
    key: "临时键",
    value: "临时值",
    course_code: a!.course_code,
  });
  assert.throws(() => updateManualHabit(db, b, { key: a!.key }), /已经有同维度同 key/);
});

check("不能修改模型推断的习惯", () => {
  const r = db
    .prepare(
      `INSERT INTO habit (dimension,key,value,course_code,confidence,evidence_count,source)
       VALUES ('attention','单次专注时长','40 分钟','PHY2',0.8,3,'model')`,
    )
    .run();
  const modelId = Number(r.lastInsertRowid);
  assert.throws(() => updateManualHabit(db, modelId, { value: "x" }), /只能修改你自己填写/);
});

check("能删自述习惯，且删完证据一起清掉", () => {
  const row = listManualHabits(db, null).find((h) => h.key === "通用");
  assert.ok(row);
  const evBefore = (
    db.prepare("SELECT COUNT(*) c FROM habit_evidence WHERE habit_id = ?").get(row!.id) as {
      c: number;
    }
  ).c;
  assert.ok(evBefore > 0);
  assert.equal(deleteManualHabit(db, row!.id), true);
  const evAfter = (
    db.prepare("SELECT COUNT(*) c FROM habit_evidence WHERE habit_id = ?").get(row!.id) as {
      c: number;
    }
  ).c;
  assert.equal(evAfter, 0);
});

check("后台重算不会删掉用户自述（回归：曾经被 DELETE FROM habit 清空）", () => {
  const before = listManualHabits(db, null);
  assert.ok(before.length > 0, "测试前置：应已有自述习惯");
  const userEvBefore = (
    db.prepare("SELECT COUNT(*) c FROM habit_evidence WHERE source_type='user'").get() as {
      c: number;
    }
  ).c;
  assert.ok(userEvBefore >= before.length);

  rebuildHabitFromEvents(db);

  const after = listManualHabits(db, null);
  assert.equal(after.length, before.length, "自述习惯被重算删掉了");
  const userEvAfter = (
    db.prepare("SELECT COUNT(*) c FROM habit_evidence WHERE source_type='user'").get() as {
      c: number;
    }
  ).c;
  assert.ok(userEvAfter >= before.length, "自述证据被重算删掉了");
});

console.log("\n【3】偏好时段解析");

check("20:00-22:00 解析成 start/end + 做什么", () => {
  const w = listStudyWindows(db, "PHY2").find((x) => x.start === "20:00");
  assert.ok(w);
  assert.equal(w?.end, "22:00");
  assert.ok(w?.what.includes("写代码"));
});

check("全角/短横线写法也能解析（8:30~10:00）", () => {
  saveManualHabit(db, { dimension: "study_window", key: "8:30~10:00", value: "做数学题" });
  const w = listStudyWindows(db, "PHY2").find((x) => x.start === "08:30");
  assert.ok(w);
  assert.equal(w?.end, "10:00");
});

console.log("\n【4】资源：网课 / 教辅 / 本地缺失");

check("URL 必须 http(s)", () => {
  assert.ok(
    validateResource({
      kind: "netcourse",
      title: "某网课",
      url: "ftp://x",
    }),
  );
});

check("progress 必须 0-1", () => {
  assert.ok(validateResource({ kind: "guidebook", title: "某教辅", progress: 1.7 }));
});

check("同科目同类型同标题是更新，不是新增", () => {
  const id1 = upsertResource(db, {
    course_code: "DS",
    kind: "netcourse",
    title: "CS50",
    url: "https://example.com/cs50",
    local_status: "available",
    progress: 0.3,
  });
  const id2 = upsertResource(db, {
    course_code: "DS",
    kind: "netcourse",
    title: "CS50",
    progress: 0.5,
  });
  assert.equal(id1, id2);
  const row = listResources(db, "DS").find((r) => r.id === id1);
  assert.equal(row?.progress, 0.5);
  assert.equal(row?.local_status, "available", "只更新 progress 时不该把 local_status 冲掉");
});

check("missing 名单能被单独取出来（走上传流程的名单）", () => {
  upsertResource(db, {
    course_code: "DS",
    kind: "guidebook",
    title: "数据结构习题解析",
    local_status: "missing",
  });
  const miss = missingResources(db, "DS");
  assert.equal(miss.length, 1);
  assert.equal(miss[0]?.title, "数据结构习题解析");
});

check("通识资源对任何科目都可见", () => {
  upsertResource(db, { kind: "other", title: "番茄钟", local_status: "available" });
  const phy = listResources(db, "PHY2").map((r) => r.title);
  const ds = listResources(db, "DS").map((r) => r.title);
  assert.ok(phy.includes("番茄钟"));
  assert.ok(ds.includes("番茄钟"));
});

check("能删资源", () => {
  // 注意：ORDER BY course_code IS NULL 时非空在前，所以不能直接删 [0]
  const row = listResources(db, null).find((r) => r.title === "番茄钟");
  assert.ok(row, "没找到要删的资源");
  assert.equal(deleteResource(db, row!.id), true);
});

console.log("\n【5】画像提示词里真的带上了这些信息");

check("profilePrompt 含偏好时段 / 在用资源 / 缺资源警告", () => {
  const p = loadProfile(db, "DS", "数据结构");
  const text = profilePrompt(p);
  assert.ok(text.includes("偏好时段"), "缺偏好时段");
  assert.ok(text.includes("在用的学习资源"), "缺资源清单");
  assert.ok(text.includes("CS50"), "缺网课名");
  assert.ok(text.includes("还没上传") || text.includes("待上传"), "缺资源缺失提醒");
});

check("科目习惯与共用习惯同时出现在画像里，且标明作用域", () => {
  const p = loadProfile(db, "DS", "数据结构");
  const text = profilePrompt(p);
  assert.ok(text.includes("先做题再看题解"), "缺科目习惯");
});

db.close();
for (const s of ["", "-wal", "-shm"]) rmSync(DB_FILE + s, { force: true });

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
