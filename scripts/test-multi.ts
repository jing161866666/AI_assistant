import "dotenv/config";
import assert from "node:assert/strict";
import type { Hit } from "../src/rag/search.js";

// 与真实数据隔离：这个库只用来验证"多科目"这一层地基
process.env.DB_PATH = "./data/test-multi.db";

const { getLearnerDb } = await import("../src/db/index.js");
const { setChapterProgress } = await import("../src/memory/chapter-progress.js");
const { listMistakes, mistakeStats, saveMistake } = await import("../src/memory/mistakes.js");
const { loadProfiles, profilePromptMulti, profilePrompt } = await import(
  "../src/memory/profile.js"
);
const { mergeCourseHits, textbookInfo } = await import("../src/rag/search.js");

const db = getLearnerDb();
const PHY = "PHY2";
const MATH = "MATH";

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

const cols = (table: string): string[] =>
  (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((r) => r.name);

console.log("\n【1】roadmap 的科目维度（老库靠只加列迁移补上）");
check("roadmap 有 course_codes 列", () => {
  assert.ok(cols("roadmap").includes("course_codes"), `现有列: ${cols("roadmap").join(",")}`);
});
check("roadmap_item 有 course_code 列", () => {
  assert.ok(cols("roadmap_item").includes("course_code"));
});

console.log("\n【2】错题按科目隔离");
// 清空本测试库的错题，保证断言可重复
db.prepare("DELETE FROM mistake").run();
const phyId = saveMistake(db, {
  title: "多科目-物理错题",
  course_code: PHY,
  error_type: "concept",
});
const mathId = saveMistake(db, {
  title: "多科目-高数错题",
  course_code: MATH,
  error_type: "careless",
});

check("不传科目时看到全部（脚本/调试口径）", () => {
  assert.equal(listMistakes(db).length, 2);
});

check("传科目时只看到该科目", () => {
  const phy = listMistakes(db, { courseCode: PHY });
  assert.equal(phy.length, 1);
  assert.equal(phy[0]!.id, phyId);
  const math = listMistakes(db, { courseCode: MATH });
  assert.equal(math.length, 1);
  assert.equal(math[0]!.id, mathId);
});

check("统计与列表同口径（否则数字对不上）", () => {
  assert.equal(mistakeStats(db).total, 2);
  assert.equal(mistakeStats(db, PHY).total, 1);
  assert.equal(mistakeStats(db, MATH).total, 1);
  assert.equal(mistakeStats(db, "NOPE").total, 0);
});

console.log("\n【3】多科目画像");
db.prepare("DELETE FROM chapter_progress").run();
db.prepare("DELETE FROM habit").run();
for (const [code, upto] of [
  [PHY, 3],
  [MATH, 1],
] as const) {
  for (let n = 1; n <= upto; n++) {
    setChapterProgress(db, {
      courseCode: code,
      chapterNo: n,
      status: "done",
      source: "test",
      evidence: "多科目地基自测",
    });
  }
}
db.prepare(
  `INSERT INTO habit (dimension, key, value, course_code, confidence, evidence_count)
   VALUES (?,?,?,?,?,?)`,
).run("attention", "专注时长", "40 分钟", PHY, 0.8, 3);
db.prepare(
  `INSERT INTO habit (dimension, key, value, course_code, confidence, evidence_count)
   VALUES (?,?,?,?,?,?)`,
).run("attention", "专注时长", "20 分钟", MATH, 0.8, 3);

check("loadProfiles 按科目各返回一份，且去重", () => {
  const ps = loadProfiles(db, [PHY, MATH, "phy2", ""]);
  assert.equal(ps.length, 2);
  assert.deepEqual(
    ps.map((p) => p.courseCode),
    [PHY, MATH],
  );
});

check("两个科目的进度互不串味", () => {
  const [p1, p2] = loadProfiles(db, [PHY, MATH]);
  assert.deepEqual([...p1!.learned].sort(), [1, 2, 3]);
  assert.deepEqual([...p2!.learned].sort(), [1]);
  assert.equal(p1!.maxChapterNo, 3);
  assert.equal(p2!.maxChapterNo, 1);
});

check("习惯按科目隔离（物理 40 分钟 / 高数 20 分钟）", () => {
  const [p1, p2] = loadProfiles(db, [PHY, MATH]);
  const val = (p: typeof p1): string => p!.habits.find((h) => h.dimension === "attention")!.value;
  assert.equal(val(p1), "40 分钟");
  assert.equal(val(p2), "20 分钟");
});

check("多科目画像包含每科标题与跨科目约束", () => {
  const text = profilePromptMulti(loadProfiles(db, [PHY, MATH]));
  assert.match(text, /多科目/);
  assert.match(text, new RegExp(PHY));
  assert.match(text, new RegExp(MATH));
  assert.match(text, /已学到第 3 章/);
  assert.match(text, /已学到第 1 章/);
  assert.match(text, /不得把一个科目的进度套到另一个科目上/);
});

check("只有一个科目时退回单科目画像（不套多科目模板）", () => {
  const text = profilePromptMulti(loadProfiles(db, [PHY]));
  assert.equal(text, profilePrompt(loadProfiles(db, [PHY])[0]!));
  assert.doesNotMatch(text, /多科目/);
});

check("空列表不炸", () => {
  assert.match(profilePromptMulti([]), /未选择任何科目/);
});

console.log("\n【4】跨库结果合并（纯函数，不调模型）");
const hit = (file: string, chunkId: number, textbook: string): Hit => ({
  chunkId,
  text: `片段${chunkId}`,
  chapter: "第1章",
  textbook,
  page: 1,
  score: 0,
  via: ["全文"],
  file,
});

check("不同库的同号 chunk 不会被误合并", () => {
  const merged = mergeCourseHits(
    [[hit("course-phy2.db", 7, "大学物理")], [hit("course-math.db", 7, "高等数学")]],
    5,
  );
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((h) => h.file).sort(), ["course-math.db", "course-phy2.db"]);
});

check("同一库同号只保留一条，且分数累加（RRF）", () => {
  const a = hit("course-phy2.db", 7, "大学物理");
  const merged = mergeCourseHits([[a], [{ ...a, via: ["向量"] }]], 5);
  assert.equal(merged.length, 1);
  // 两个列表里都排第 1：1/61 + 1/61（score 保留 5 位小数）
  assert.ok(Math.abs(merged[0]!.score - 2 / 61) < 1e-4, `score=${merged[0]!.score}`);
  assert.ok(merged[0]!.via.includes("跨库"), `via=${merged[0]!.via.join(",")}`);
});

check("k 生效：只返回前 k 条", () => {
  const list = [1, 2, 3, 4, 5].map((n) => hit("course-phy2.db", n, "大学物理"));
  assert.equal(mergeCourseHits([list], 3).length, 3);
});

check("空输入返回空数组", () => {
  assert.deepEqual(mergeCourseHits([], 5), []);
  assert.deepEqual(mergeCourseHits([[], []], 5), []);
});

console.log("\n【5】教材库连接缓存（多库交替打开不炸）");
check("同一科目连续查询正常", () => {
  const info = textbookInfo("course-phy2.db");
  assert.equal(info.ok, true);
  assert.ok(info.chunks > 0, "教材库为空");
  assert.equal(textbookInfo("course-phy2.db").chunks, info.chunks);
});
check("缺失的教材库返回 ok=false 而不是抛错", () => {
  const info = textbookInfo("course-not-exist.db");
  assert.equal(info.ok, false);
});

console.log("\n【6】错题截图：原图落盘 + 取回，界面优先用图");
const { existsSync, unlinkSync } = await import("node:fs");
const { paths } = await import("../src/db/index.js");
const { saveImageArtifact } = await import("../src/vision/extract.js");
const { getMistakeImage } = await import("../src/memory/mistakes.js");

// 1x1 PNG：真实可解码，但不是任何人的真实图片
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
let artifactId = 0;
let shotMistakeId = 0;

check("截图存成 artifact：sha256 + 文件真的落在 uploads 里", () => {
  artifactId = saveImageArtifact(db, PNG, "mistake");
  assert.ok(artifactId > 0);
  const row = db
    .prepare("SELECT kind, path, sha256, bytes FROM artifact WHERE id = ?")
    .get(artifactId) as { kind: string; path: string; sha256: string; bytes: number };
  assert.equal(row.kind, "image");
  assert.equal(row.sha256.length, 64);
  assert.ok(row.path.startsWith(paths.uploads), `路径跑出了 uploads: ${row.path}`);
  assert.ok(existsSync(row.path), "artifact 记了路径但文件不存在");
});

check("同一张图重复保存不重复落盘（按 sha256 复用）", () => {
  assert.equal(saveImageArtifact(db, PNG, "mistake"), artifactId);
});

check("错题挂上 artifact_id，source 记为 photo", () => {
  shotMistakeId = saveMistake(db, {
    title: "截图错题",
    course_code: PHY,
    artifact_id: artifactId,
    source: "photo",
    correct_answer: "由 $v=\\frac{2}{3}$ 得",
  });
  const row = listMistakes(db, { courseCode: PHY }).find((m) => m.id === shotMistakeId);
  assert.ok(row, "刚存的错题查不到");
  assert.equal(row.artifact_id, artifactId);
  assert.equal(row.source, "photo");
});

check("按错题 id 能查到原图路径（就是展示用的那一张）", () => {
  const img = getMistakeImage(db, shotMistakeId);
  assert.ok(img, "有 artifact_id 却查不到图");
  assert.ok(img.path.endsWith(".png"));
});

check("没有截图的错题返回 null（界面就退回显示文字）", () => {
  const id = saveMistake(db, { title: "纯文字错题", course_code: PHY });
  assert.equal(getMistakeImage(db, id), null);
  db.prepare("DELETE FROM mistake WHERE id = ?").run(id);
});

check("非图片 data URL 被拒绝", () => {
  assert.throws(() => saveImageArtifact(db, "data:text/plain;base64,aGk=", "mistake"), /图片格式/);
});

check("删除错题时原图仍保留（原始文件永不删，artifact 记录在案）", () => {
  db.prepare("DELETE FROM mistake WHERE id = ?").run(shotMistakeId);
  const row = db.prepare("SELECT path FROM artifact WHERE id = ?").get(artifactId) as
    | { path: string }
    | undefined;
  assert.ok(row, "artifact 记录被连带删了");
  assert.ok(existsSync(row.path), "原图文件被删了");
});

// 测试收尾：清掉本套件写的 artifact 记录与文件，避免 data/uploads 越积越多
const testArtifact = db.prepare("SELECT id, path FROM artifact WHERE id = ?").get(artifactId) as
  | { id: number; path: string }
  | undefined;
if (testArtifact) {
  try {
    unlinkSync(testArtifact.path);
  } catch {
    /* 文件可能已被复用/删除 */
  }
  db.prepare("DELETE FROM artifact WHERE id = ?").run(testArtifact.id);
}

db.close();
console.log(`\n${"─".repeat(56)}\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
