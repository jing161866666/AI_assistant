import "dotenv/config";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 课程资料 / 建库 / 课表导入 的纯逻辑与落库自测。
 *
 * 不调模型：章切分、课程行校验、课程名→代码的白名单在代码里，模型只提供内容。
 * 每次运行用独立 learner 库，建库文件也在结束后清理。
 */

process.env.DB_PATH = `./data/test-course-${process.pid}.db`;
// 教材库也指到临时目录：否则测试建的 course-tst*.db 会被正在运行的服务
// 自动登记成科目，真实库里就多出「测试课程」（已经踩过一次）。
process.env.TEXTBOOK_DIR = `./data/test-textbook-${process.pid}`;

const { getLearnerDb, paths } = await import("../src/db/index.js");
const { listLibraries } = await import("../src/memory/course-match.js");
const { createEmptyTextbookDb } = await import("../src/course/course-db.js");
const { applyTimetable } = await import("../src/course/apply.js");
const { normalizeTimetableRows } = await import("../src/course/timetable.js");
const { cnNumber, chunkText, splitChapters } = await import("../src/course/chapter-split.js");
const { textbookMeta } = await import("../src/memory/subjects.js");

if (!paths.learnerDb.includes("test-course-") || !paths.textbook.includes("test-textbook-")) {
  throw new Error(`测试必须用独立库，当前 learner=${paths.learnerDb} textbook=${paths.textbook}`);
}

const db = getLearnerDb();
const TEST_CODE = `TST${process.pid}`;
const testDbFile = resolve(paths.textbook, `course-${TEST_CODE.toLowerCase()}.db`);

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
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
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
function cleanup(): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${testDbFile}${suffix}`, { force: true });
}

console.log("\n【1】中文章号解析");

check("一 → 1、十一 → 11、二十 → 20", () => {
  assert.equal(cnNumber("一"), 1);
  assert.equal(cnNumber("十一"), 11);
  assert.equal(cnNumber("二十"), 20);
  assert.equal(cnNumber("12"), 12);
});
check("非法字符返回 null", () => {
  assert.equal(cnNumber("第一"), null);
});

console.log("\n【2】切章：标题丢失时用 §小节号 恢复章号");

const long = (s: string): string => `${s} ${"内容".repeat(80)}`;
const textWithSections = [
  "目录",
  "第一章 随机事件及其概率 \t1",
  "§1.1 随机事件 \t1",
  "第二章 随机变量 \t33",
  "§2.1 随机变量 \t33",
  "正文",
  long("§1.1 随机事件"),
  "§1.2 概率的定义",
  long("这是第一章正文，很长很长。"),
  "§2.1 随机变量",
  long("这是第二章正文，也很长。"),
  "§2.2 分布函数",
  long("继续第二章。"),
].join("\n");

check("§N.M → 第 N 章，章名取目录", () => {
  const chapters = splitChapters(textWithSections);
  assert.equal(chapters.length, 2, `切出 ${chapters.length} 章`);
  assert.deepEqual(
    chapters.map((c) => c.no),
    [1, 2],
  );
  assert.equal(chapters[0]!.title, "随机事件及其概率");
  assert.match(chapters[0]!.text, /第一章正文/);
  assert.match(chapters[1]!.text, /第二章正文/);
});
check("目录行不会被当成正文小节", () => {
  const chapters = splitChapters(textWithSections);
  // 目录里的 §1.1 带页码，被排除；正文内容不应包含目录行
  assert.doesNotMatch(chapters[0]!.text, /随机事件 \t1/);
});

check("没有 § 时退回按章标题切", () => {
  const text = ["第一章 甲", long("甲的内容"), "第二章 乙", long("乙的内容")].join("\n");
  const chapters = splitChapters(text);
  assert.equal(chapters.length, 2);
  assert.deepEqual(
    chapters.map((c) => c.title),
    ["甲", "乙"],
  );
});
check("两种标记都没有 → 返回空（整本不分章）", () => {
  assert.deepEqual(splitChapters("就是一段没有章名的文字"), []);
});

console.log("\n【3】切片与课程行校验");

check("chunkText 不超过上限，且不丢内容", () => {
  const src = Array.from({ length: 40 }, (_, i) => `第${i}段 ${"字".repeat(60)}`).join("\n");
  const chunks = chunkText(src, 500);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 1000, `片段过长：${c.length}`);
  assert.equal(chunks.join("").replace(/\s/g, "").length, src.replace(/\s/g, "").length);
});

check("合法行保留，非法行被丢弃且给出原因", () => {
  const { rows, dropped } = normalizeTimetableRows([
    { title: "大学物理(B)II", weekday: 1, start: "09:50", end: "11:25", location: " 教四-202 " },
    { title: "", weekday: 1, start: "08:00", end: "09:40", location: null },
    { title: "越界课", weekday: 9, start: "08:00", end: "09:40", location: null },
    { title: "倒置课", weekday: 2, start: "10:00", end: "09:00", location: null },
    { title: "重复课", weekday: 3, start: "08:00", end: "09:40", location: null },
    { title: "重复课", weekday: 3, start: "08:00", end: "09:40", location: null },
  ]);
  assert.equal(rows.length, 2, `保留 ${rows.length} 行`);
  assert.equal(rows[0]!.location, "教四-202", "地点应去空格");
  assert.equal(dropped.length, 4);
  assert.ok(dropped.some((d) => d.reason.includes("周几越界")));
  assert.ok(dropped.some((d) => d.reason.includes("时间不合法")));
  assert.ok(dropped.some((d) => d.reason === "重复行"));
});

console.log("\n【4】课程代码候选：来自本地教材库（course-match）");
check("隔离目录里初始没有教材库", () => {
  assert.deepEqual(listLibraries(), [], "测试教材目录应该是空的");
});

console.log("\n【5】建空库 + 课表导入（不调模型，matches 由代码给）");

check("空库可建、可读出 course，且没有正文", () => {
  cleanup();
  const r = createEmptyTextbookDb(TEST_CODE, "测试课程");
  assert.equal(r.created, true);
  assert.ok(existsSync(testDbFile));
  const meta = textbookMeta(`course-${TEST_CODE.toLowerCase()}.db`);
  assert.ok(meta, "空库应能读出 course");
  assert.equal(meta!.chapters, 0);
  assert.equal(meta!.chunks, 0);
  // 建好之后就该出现在 course-match 的候选库里
  const names = listLibraries().map((l) => l.name);
  assert.ok(names.includes("测试课程"), `候选: ${names.join(",")}`);
});
check("重复建同一个空库不会覆盖", () => {
  const r = createEmptyTextbookDb(TEST_CODE, "测试课程");
  assert.equal(r.created, false);
});

await checkAsync("导入课表：写日程 + 登记科目 + 复用已建库", async () => {
  const result = await applyTimetable(db, {
    rows: [
      {
        title: "概率统计与随机过程",
        weekday: 2,
        start: "08:00",
        end: "09:40",
        location: "教六-101",
      },
      {
        title: "概率统计与随机过程",
        weekday: 5,
        start: "14:00",
        end: "15:40",
        location: "教六-101",
      },
      { title: "没匹配的课", weekday: 3, start: "08:00", end: "09:40", location: null },
    ],
    matches: [
      {
        title: "概率统计与随机过程",
        code: TEST_CODE,
        name: "测试课程",
      },
    ],
  });
  assert.equal(result.scheduleAdded, 3);
  assert.equal(result.subjects.length, 1);
  assert.equal(result.subjects[0]!.dbCreated, false, "库已存在，不应重建");
  assert.deepEqual(result.unmatched, ["没匹配的课"]);

  const sub = db
    .prepare("SELECT course_code, course_name, textbook_file FROM subject WHERE course_code = ?")
    .get(TEST_CODE) as { course_code: string; course_name: string; textbook_file: string };
  assert.equal(sub.course_name, "测试课程");
  assert.equal(sub.textbook_file, `course-${TEST_CODE.toLowerCase()}.db`);

  const rows = db
    .prepare("SELECT course_code FROM schedule WHERE title = ?")
    .all("概率统计与随机过程") as Array<{ course_code: string }>;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.course_code === TEST_CODE));
  // 没匹配的课：日程照样写入，只是没有科目锚点
  const unmatchedRow = db
    .prepare("SELECT course_code FROM schedule WHERE title = ?")
    .get("没匹配的课") as { course_code: string | null };
  assert.equal(unmatchedRow.course_code, null);

  const matched = db.prepare("SELECT 1 AS x FROM subject WHERE course_code = ?").get(TEST_CODE) as
    | { x: number }
    | undefined;
  assert.ok(matched, "科目应已登记");
});

console.log("\n【6】清理");

cleanup();
db.close();
rmSync(paths.learnerDb, { force: true });
rmSync(`${paths.learnerDb}-wal`, { force: true });
rmSync(`${paths.learnerDb}-shm`, { force: true });
rmSync(paths.textbook, { recursive: true, force: true });

console.log(`\n${"─".repeat(56)}\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
