import "dotenv/config";
import assert from "node:assert/strict";
import { getLearnerDb } from "../src/db/index.js";
import {
  advanceTo,
  learnedChapterSet,
  maxLearnedChapter,
  setChapterProgress,
} from "../src/memory/chapter-progress.js";
import { isLearned, loadProfile, profilePrompt } from "../src/memory/profile.js";
import { listChapterOutline } from "../src/rag/chapter-outline.js";
import { guardProgress } from "../src/rag/progress-guard.js";

const db = getLearnerDb();
const COURSE = "PHY2";

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

async function main(): Promise<void> {
  // 清空并重建测试进度
  db.prepare("DELETE FROM chapter_progress WHERE course_code = ?").run(COURSE);
  db.prepare("DELETE FROM habit").run();

  console.log("\n【1】章节进度读写");
  await check("初始未设进度时 maxLearnedChapter 为 null", () => {
    assert.equal(maxLearnedChapter(db, COURSE), null);
  });
  await check("推进到第 11 章后上限为 11", () => {
    advanceTo(db, COURSE, 11);
    assert.equal(maxLearnedChapter(db, COURSE), 11);
  });
  await check("第 1..11 章全部标记已学", () => {
    const s = learnedChapterSet(db, COURSE);
    assert.equal(s.size, 11);
    for (let n = 1; n <= 11; n++) assert.ok(s.has(n), `缺第 ${n} 章`);
  });
  await check("单章设为 learning 不影响上限", () => {
    setChapterProgress(db, {
      courseCode: COURSE,
      chapterNo: 12,
      status: "learning",
      source: "chat",
      evidence: "对话中提到正在看第12章",
    });
    assert.equal(maxLearnedChapter(db, COURSE), 12);
  });
  await check("把第 12 章改回 not_started 后上限仍是 11", () => {
    setChapterProgress(db, { courseCode: COURSE, chapterNo: 12, status: "not_started" });
    assert.equal(maxLearnedChapter(db, COURSE), 11);
  });

  console.log("\n【2】门控判定");
  const prof = loadProfile(db, COURSE);
  await check("第 11 章在已学范围内", () => {
    assert.equal(isLearned(prof, 11), true);
  });
  await check("第 15 章（量子）判定为未学", () => {
    assert.equal(isLearned(prof, 15), false);
  });
  await check("题库类（chapter_no=null）不参与门控", () => {
    assert.equal(isLearned(prof, null), true);
  });

  console.log("\n【3】画像文本");
  db.prepare(
    `INSERT INTO habit (dimension, key, value, course_code, context, confidence, evidence_count)
     VALUES (?,?,?,?,?,?,?)`,
  ).run("learn_method", "阶段:波动光学", "中文详细网课", COURSE, null, 0.8, 3);
  db.prepare(
    `INSERT INTO habit (dimension, key, value, course_code, context, confidence, evidence_count)
     VALUES (?,?,?,?,?,?,?)`,
  ).run("code_naming", "含义:累加器", "sum", null, null, 0.7, 2);
  db.prepare(
    `INSERT INTO habit (dimension, key, value, course_code, context, confidence, evidence_count)
     VALUES (?,?,?,?,?,?,?)`,
  ).run("notation", "场景:导数", "y'", COURSE, null, 0.6, 2);

  const text = profilePrompt(loadProfile(db, COURSE));
  console.log("\n──── 注入模型的画像原文 ────");
  console.log(text);
  console.log("────────────────────────────\n");

  await check("画像包含已学上限", () => {
    assert.match(text, /已学到第 11 章/);
  });
  await check("画像包含未学提醒与替代思路要求", () => {
    assert.match(text, /你还没学/);
  });
  await check("画像包含科目级学习方式偏好", () => {
    assert.match(text, /中文详细网课/);
  });
  await check("画像包含通识级代码命名偏好", () => {
    assert.match(text, /累加器 → sum/);
  });

  console.log("【4】越界检查（真实模型调用 + 真实章节表）");
  const outline = listChapterOutline("course-phy2.db");
  console.log(`      章节表：${outline.map((o) => `第${o.chapterNo}章`).join("、")}`);
  await check("章节表非空且含第 11/15 章", () => {
    const nos = outline.map((o) => o.chapterNo);
    assert.ok(nos.includes(11), "缺第 11 章");
    assert.ok(nos.includes(15), "缺第 15 章");
  });
  const withinAnswer =
    "由光程差 $\\Delta = 2nd + \\lambda/2$，相长条件 $2nd+\\lambda/2 = k\\lambda$，最小膜厚 $d=\\lambda/(4n)$。";
  await check("薄膜干涉题不应判越界", async () => {
    const g = await guardProgress("求增透膜的最小厚度", withinAnswer, 11, outline);
    assert.equal(g.beyond.length, 0, `误判越界: ${JSON.stringify(g.beyond)}`);
  });

  const beyondAnswer =
    "由德布罗意关系 $\\lambda = h/p$，并结合不确定性原理 $\\Delta x \\Delta p \\ge \\hbar/2$，得电子被限制在 $\\Delta x$ 时动量不确定度显著。";
  await check("用德布罗意/不确定性原理应判越界", async () => {
    const g = await guardProgress(
      "估算电子被限制在 0.1nm 时的动量不确定度",
      beyondAnswer,
      11,
      outline,
    );
    assert.ok(g.beyond.length > 0, "应检出越界但没检出");
    console.log(
      `      检出: ${g.beyond.map((b) => `${b.topic}(第${b.chapter_no ?? "?"}章)`).join("、")}`,
    );
  });

  await check("未设进度（null）时直接放行不调用模型", async () => {
    const g = await guardProgress("任意题", "任意答案", null, outline);
    assert.equal(g.beyond.length, 0);
    assert.equal(g.allWithin, true);
  });

  db.prepare("DELETE FROM habit").run();
  console.log(`\n${"─".repeat(56)}\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
