import "dotenv/config";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  bestShortNameScore,
  confirmAlias,
  type LibraryRef,
  loadAliases,
  matchCourses,
  normalizeCourseName,
  saveMatchResult,
  selectSubject,
  setCourseMatcher,
  shortNameScore,
} from "../src/memory/course-match.js";

/**
 * 科目匹配测试。
 *
 * 核心断言用的是用户给的真实例子：
 *   大物下 → 大学物理下（简称，字符可验）
 *   工数   → 工科数学分析（简称，字符可验）
 *   CPP    → 编程语言基础（无字符重叠，必须人确认）
 *
 * 不联网：模型兜底被替换成桩函数。
 */

const DB_FILE = resolve(`data/test-match-${process.pid}.db`);
for (const s of ["", "-wal", "-shm"]) rmSync(DB_FILE + s, { force: true });
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

const lib = (code: string, name: string): LibraryRef => ({
  code,
  name,
  file: `course-${code.toLowerCase()}.db`,
  chapters: 15,
  chapterNos: 15,
  chunks: 1000,
});

console.log("【1】归一化：全角/罗马数字/分隔符");

await check("大学物理（B）Ⅱ 与 大学物理(B)II 归一化后相同", () => {
  assert.equal(normalizeCourseName("大学物理（B）Ⅱ"), normalizeCourseName("大学物理(B)II"));
});

await check("归一化结果把结尾罗马数字转成阿拉伯数字", () => {
  assert.equal(normalizeCourseName("大学物理(B)II"), "大学物理(b)2");
});

await check("空格/中点/顿号不影响相等", () => {
  assert.equal(normalizeCourseName("大学物理 · 下册"), normalizeCourseName("大学物理下册"));
});

console.log("\n【2】简称可验性（你给的三个例子）");

await check("大物下 → 大学物理下：可验（逐字按顺序出现）", () => {
  assert.ok(shortNameScore("大学物理下", "大物下") > 0);
});

await check("工数 → 工科数学分析：可验", () => {
  assert.ok(shortNameScore("工科数学分析", "工数") > 0);
});

await check("CPP → 编程语言基础：不可验（一个字符都不在）", () => {
  assert.equal(shortNameScore("编程语言基础", "CPP"), 0);
});

await check("反向也算：库叫「大物下」、课表叫「大学物理下」同样可验", () => {
  assert.ok(bestShortNameScore("大物下", "大学物理下") > 0);
});

await check("上下册不能混：大物上 对 大学物理下 不可验", () => {
  assert.equal(shortNameScore("大学物理下", "大物上"), 0);
});

await check("太短的缩写不做匹配（防止乱命中）", () => {
  assert.equal(shortNameScore("大学物理下", "大"), 0);
});

console.log("\n【3】匹配主流程");

const libs = [lib("PHY2", "大学物理下"), lib("MATH", "工科数学分析"), lib("CPP", "C++程序设计")];

await check("简称命中：大物下 → PHY2，不需要确认", async () => {
  const r = await matchCourses(db, { courses: ["大物下"], libraries: libs, useModel: false });
  const m = r.courses[0];
  assert.equal(m?.code, "PHY2");
  assert.equal(m?.tier, "short");
  assert.equal(m?.needsConfirm, false);
});

await check("简称命中：工数 → MATH", async () => {
  const r = await matchCourses(db, { courses: ["工数"], libraries: libs, useModel: false });
  assert.equal(r.courses[0]?.code, "MATH");
});

await check("无字符重叠时 useModel=false 就是 none，不瞎猜", async () => {
  const r = await matchCourses(db, {
    courses: ["编程语言基础"],
    libraries: libs,
    useModel: false,
  });
  assert.equal(r.courses[0]?.tier, "none");
  assert.equal(r.courses[0]?.code, null);
});

await check("命名完全一致 → exact，置信度 1", async () => {
  const r = await matchCourses(db, { courses: ["大学物理下"], libraries: libs, useModel: false });
  assert.equal(r.courses[0]?.tier, "exact");
  assert.equal(r.courses[0]?.confidence, 1);
});

let asked: string[] = [];
setCourseMatcher(async (courses) => {
  asked = courses;
  return courses.map((c) => ({
    course: c,
    code: "CPP",
    confidence: 0.82,
    reason: "课程名与库名的完整写法一致",
  }));
});

await check("模型兜底：CPP 类匹配标成 model 且必须人确认", async () => {
  const r = await matchCourses(db, { courses: ["编程语言基础"], libraries: libs });
  const m = r.courses[0];
  assert.deepEqual(asked, ["编程语言基础"]);
  assert.equal(m?.code, "CPP");
  assert.equal(m?.tier, "model");
  assert.equal(m?.needsConfirm, true, "模型猜的必须等用户点头");
});

await check("模型猜的结果落库时是 pending，不是 confirmed", () => {
  const row = loadAliases(db).find((a) => a.alias === "编程语言基础" && a.course_code === "CPP");
  assert.equal(row?.status, "pending");
  assert.equal(row?.source, "model");
});

await check("用户确认后：变 confirmed，且下次匹配走别名档、不用再问", async () => {
  confirmAlias(db, "编程语言基础", "CPP", true);
  const row = loadAliases(db).find((a) => a.alias === "编程语言基础" && a.course_code === "CPP");
  assert.equal(row?.status, "confirmed");
  assert.equal(row?.source, "user");

  asked = [];
  const r = await matchCourses(db, { courses: ["编程语言基础"], libraries: libs });
  assert.equal(r.courses[0]?.tier, "alias");
  assert.equal(r.courses[0]?.needsConfirm, false);
  assert.deepEqual(asked, [], "已确认的别名不该再打模型");
});

await check("用户否决后：不自动采用，回到模型/未匹配", async () => {
  confirmAlias(db, "编程语言基础", "CPP", false);
  setCourseMatcher(async () => []);
  const r = await matchCourses(db, { courses: ["编程语言基础"], libraries: libs });
  assert.equal(r.courses[0]?.tier, "none");
});

console.log("\n【4】勾选「允许 AI 辅助」");

await check("默认不允许", () => {
  const row = db.prepare("SELECT COUNT(*) AS c FROM subject").get() as { c: number };
  assert.equal(row.c, 0);
});

await check("勾选后写 subject.ai_enabled=1", () => {
  selectSubject(db, {
    code: "PHY2",
    name: "大学物理下",
    enabled: true,
    textbookFile: "course-phy2.db",
  });
  const row = db
    .prepare("SELECT ai_enabled, textbook_file FROM subject WHERE course_code='PHY2'")
    .get() as {
    ai_enabled: number;
    textbook_file: string;
  };
  assert.equal(row.ai_enabled, 1);
  assert.equal(row.textbook_file, "course-phy2.db");
});

await check("取消勾选后 ai_enabled=0（但教材库信息保留）", () => {
  selectSubject(db, { code: "PHY2", name: "大学物理下", enabled: false });
  const row = db
    .prepare("SELECT ai_enabled, textbook_file FROM subject WHERE course_code='PHY2'")
    .get() as {
    ai_enabled: number;
    textbook_file: string | null;
  };
  assert.equal(row.ai_enabled, 0);
  assert.equal(row.textbook_file, "course-phy2.db");
});

await check("exact 命中会自动写进别名表（confirmed）", async () => {
  saveMatchResult(db, {
    name: "生态学",
    code: "ECO",
    library: null,
    tier: "exact",
    confidence: 1,
    reason: "测试",
    needsConfirm: false,
  });
  const row = loadAliases(db).find((a) => a.alias === "生态学");
  assert.equal(row?.status, "confirmed");
});

db.close();
for (const s of ["", "-wal", "-shm"]) rmSync(DB_FILE + s, { force: true });

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
