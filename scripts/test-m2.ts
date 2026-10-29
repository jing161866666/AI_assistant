import "dotenv/config";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * M2 自测。
 *
 * 以前直接跑在 data/learner.db 上，开头 `DELETE FROM habit` 会清空用户的真实习惯。
 * 现在先用 VACUUM INTO 把真实库快照到临时库，所有读写都在快照上做，结束后删掉。
 */
const TMP_DB = resolve(`data/test-m2-${process.pid}.db`);
for (const s of ["", "-wal", "-shm"]) rmSync(TMP_DB + s, { force: true });
const REAL_DB = resolve("data/learner.db");
if (existsSync(REAL_DB)) {
  const src = new DatabaseSync(REAL_DB, { readOnly: true });
  try {
    src.exec(`VACUUM INTO '${TMP_DB.replace(/\\/g, "/")}'`);
  } finally {
    src.close();
  }
}
process.env.DB_PATH = TMP_DB;

const { getLearnerDb } = await import("../src/db/index.js");
const { advanceTo, learnedChapterSet, maxLearnedChapter, setChapterProgress } = await import(
  "../src/memory/chapter-progress.js"
);
const { isLearned, loadProfile, profilePrompt } = await import("../src/memory/profile.js");
const { listChapterOutline } = await import("../src/rag/chapter-outline.js");
const { classifyBeyond, guardProgress } = await import("../src/rag/progress-guard.js");

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
  /** 已学集合：第 9–11、15 章（第 12–14 章未学，故意不连续——14 章是库里的断层） */
  const learned = new Set([9, 10, 11, 15]);

  console.log("\n【4-1】过滤规则（纯函数，不依赖模型，可稳定回归）");
  await check("已学章节不算越界（第 15 章即使被模型点名也剔除）", () => {
    const r = classifyBeyond(
      [{ topic: "德布罗意关系", chapter_no: 15, why: "第15章" }],
      false,
      learned,
      outline,
    );
    assert.equal(r.beyond.length, 0);
    assert.equal(r.uncertain.length, 0);
    assert.equal(r.allWithin, true);
  });

  await check("未学章节算越界（第 13 章）", () => {
    const r = classifyBeyond(
      [{ topic: "热力学第一定律", chapter_no: 13, why: "未学" }],
      false,
      learned,
      outline,
    );
    assert.equal(r.beyond.length, 1);
    assert.equal(r.allWithin, false);
  });

  await check("定位不到章节 → uncertain，不许静默丢掉越界信号", () => {
    const r = classifyBeyond(
      [{ topic: "热力学第一定律", chapter_no: null, why: "方法未在已学章内" }],
      false,
      learned,
      outline,
    );
    assert.equal(r.beyond.length, 0);
    assert.equal(r.uncertain.length, 1, "存疑项被丢掉了");
    assert.equal(r.allWithin, false, "模型说不是全部在范围内，不能对外宣称没有越界");
  });

  await check("章节表外的编号也归入 uncertain（不当作有效章节）", () => {
    const r = classifyBeyond(
      [{ topic: "某个方法", chapter_no: 99, why: "表里没有" }],
      false,
      learned,
      outline,
    );
    assert.equal(r.beyond.length, 0);
    assert.equal(r.uncertain.length, 1);
    assert.equal(r.uncertain[0]!.chapter_no, null);
  });

  await check("模型整体判定 all_within=true 时，不因存疑项过度报警", () => {
    const r = classifyBeyond(
      [{ topic: "微积分", chapter_no: null, why: "初等运算" }],
      true,
      learned,
      outline,
    );
    assert.equal(r.uncertain.length, 0);
    assert.equal(r.allWithin, true);
  });

  console.log("\n【4-2】真实模型调用（判定的稳定性由上面的纯函数兜底）");
  await check("薄膜干涉题不应判越界", async () => {
    const g = await guardProgress("求增透膜的最小厚度", withinAnswer, learned, outline);
    assert.equal(g.beyond.length, 0, `误判越界: ${JSON.stringify(g.beyond)}`);
    assert.equal(g.uncertain.length, 0, `误报可能越界: ${JSON.stringify(g.uncertain)}`);
    assert.equal(g.guard, "ok");
  });

  /** 第 12/13 章（热学 / 热力学）没学：不管模型能不能定位到章节，都必须有信号 */
  const thermoAnswer =
    "热力学第一定律 $Q = \\Delta U + W$，等温过程 $\\Delta U = 0$，故 $Q = W = nRT\\ln(V_2/V_1)$。";
  await check("用热力学（第 12/13 章，未学）必须提示越界", async () => {
    const g = await guardProgress("理想气体等温膨胀做功多少", thermoAnswer, learned, outline);
    const flagged = g.beyond.length + g.uncertain.length;
    assert.ok(flagged > 0, "模型说没问题，越界信号被吞掉了");
    assert.equal(g.guard, "ok");
    console.log(
      `      确定越界: ${g.beyond.map((b) => `${b.topic}(第${b.chapter_no}章)`).join("、") || "无"}；` +
        `可能越界: ${g.uncertain.map((b) => b.topic).join("、") || "无"}`,
    );
  });

  await check("德布罗意（第 15 章，已学）不得算确定越界", async () => {
    const g = await guardProgress(
      "求电子的德布罗意波长",
      "由 $\\lambda = h/p$，得波长与动量成反比。",
      learned,
      outline,
    );
    assert.equal(g.beyond.length, 0, `已学章节被误判: ${JSON.stringify(g.beyond)}`);
    assert.equal(g.guard, "ok");
  });

  await check("未设进度（null）时直接放行不调用模型", async () => {
    const g = await guardProgress("任意题", "任意答案", null, outline);
    assert.equal(g.beyond.length, 0);
    assert.equal(g.uncertain.length, 0);
    assert.equal(g.allWithin, true);
    assert.equal(g.guard, "no-progress");
  });

  db.prepare("DELETE FROM habit").run();
  console.log(`\n${"─".repeat(56)}\n通过 ${pass} 项，失败 ${fail} 项`);
  db.close();
  for (const s of ["", "-wal", "-shm"]) rmSync(TMP_DB + s, { force: true });
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
