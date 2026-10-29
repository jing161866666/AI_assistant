import "dotenv/config";
import assert from "node:assert/strict";
import {
  CITATION_LIMIT,
  INPUT_KIND_LABEL,
  INPUT_KINDS,
  reviewSchema,
  toCitations,
} from "../src/rag/answer.js";
import {
  bankPromptBlock,
  classifyBankScore,
  detectKind,
  kindLabel,
  lookupBank,
  parseBankQuestion,
} from "../src/rag/bank.js";
import type { Hit } from "../src/rag/search.js";

/**
 * 题库检索层的可断言部分。
 *
 * 这里只测纯函数与降级路径（不联网、不依赖教材库），
 * 真实命中率用 `npx tsx scripts/test-bank.ts --live` 单独跑。
 */

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass++;
      console.log(`  ✓ ${name}`);
    })
    .catch((e: Error) => {
      fail++;
      console.log(`  ✗ ${name}`);
      console.log(`      ${e.message.split("\n")[0]}`);
    });
}

console.log("【1】题号 / 题干 / 答案切分");

const CHOICE =
  "1．0148：几个力同时作用在一个具有光滑固定转轴的刚体上，如果这几个力的矢量和为零，则此刚体 (A) 必然不会转动     (B) 转速必然不变 (C) 转速必然改变     (D) 转速可能不变，也可能改变                      ［      ］";
const CALC =
  "1．0241：解：(1)  ∵   mg－T＝ma-----------------1分 TR＝J------------------2分 a＝R-----------------1分 ∴   = mgR / (mR2＋J)＝81.7 rad/s2-----------------1分 方向垂直纸面向外";
const FILL =
  "23．0062：两块并排的木块Ａ和Ｂ，质量分别为m1和m2 ，静止地放置在光滑的水平面上，一子弹水平地穿过两木块，则子弹穿出后，木块A的速度大小为____________，木块B的速度大小为____________。";

await check("选择题：题号、题型、无答案、题干保留选项", () => {
  const q = parseBankQuestion(CHOICE, 543);
  assert.equal(q.qno, "0148");
  assert.equal(q.kind, "choice");
  assert.equal(q.answer, null);
  assert.equal(q.chunkId, 543);
  assert.ok(q.stem.includes("(A) 必然不会转动"), "题干应保留选项");
  assert.ok(!q.stem.startsWith("1．"), "题号应从题干剥离");
});

await check("计算题：题库只存解答时 stem 为空、answer 非空", () => {
  const q = parseBankQuestion(CALC);
  assert.equal(q.qno, "0241");
  assert.equal(q.kind, "calc");
  assert.equal(q.stem, "");
  assert.ok(q.answer && q.answer.length > 20, "应切出解答");
  assert.ok(q.answer.includes("81.7"), "解答内容应完整");
});

await check("填空题：靠空格线识别题型", () => {
  const q = parseBankQuestion(FILL);
  assert.equal(q.qno, "0062");
  assert.equal(q.kind, "fill");
  assert.ok(q.stem.includes("____________"));
});

await check("题干里出现『答：』不算答案（太短，判为误切）", () => {
  const q = parseBankQuestion("5．0777：本题答：见课本 第 3 章 图 12 的说明部分，请自行查阅。");
  assert.equal(q.answer, null);
});

await check("无题号文本不崩，题型按特征判定", () => {
  const q = parseBankQuestion("一质量为 m 的物体沿斜面下滑。", 1, "力学");
  assert.equal(q.qno, null);
  assert.equal(q.kind, "unknown");
  assert.equal(q.chapter, "力学");
});

await check("detectKind 优先级：填空线 > 选项 > 解答", () => {
  assert.equal(detectKind("(A) 甲 (B) 乙 且速度为________"), "fill");
  assert.equal(detectKind("（A）甲 （B）乙"), "choice");
  assert.equal(detectKind("解：由牛顿第二定律得 F=ma"), "calc");
});

await check("题型中文名齐全", () => {
  for (const k of ["choice", "fill", "calc", "unknown"] as const) {
    assert.ok(kindLabel(k).length > 0);
  }
});

console.log("\n【2】命中阈值（实测：原题 0.968~0.971，同章异题 ≤0.779）");

await check("0.97 → same", () => assert.equal(classifyBankScore(0.97), "same"));
await check("0.90 边界 → same", () => assert.equal(classifyBankScore(0.9), "same"));
await check("0.85 → close（相似但不确认同题）", () =>
  assert.equal(classifyBankScore(0.85), "close"),
);
await check("0.779 同章异题 → none", () => assert.equal(classifyBankScore(0.779), "none"));
await check("0.4 无关题 → none", () => assert.equal(classifyBankScore(0.4), "none"));

console.log("\n【3】提示词片段：三种状态必须让模型分得清");

const hitWithAnswer = {
  verdict: "same" as const,
  hit: true,
  score: 0.968,
  question: {
    chunkId: 1,
    qno: "0148",
    kind: "choice" as const,
    chapter: "刚体",
    stem: "题干",
    answer: "答案是 D",
  },
  total: 956,
  reason: "",
};
const hitNoAnswer = {
  ...hitWithAnswer,
  question: { ...hitWithAnswer.question, answer: null },
};
const missed = {
  verdict: "none" as const,
  hit: false,
  score: 0.6,
  question: null,
  total: 956,
  reason: "",
};

await check("命中且有答案：给出题库解答，且禁止矛盾结论", () => {
  const s = bankPromptBlock(hitWithAnswer);
  assert.ok(s.includes("命中且有答案"));
  assert.ok(s.includes("题库解答"));
  assert.ok(s.includes("答案是 D"));
});

await check("命中但无答案：明说没有答案", () => {
  const s = bankPromptBlock(hitNoAnswer);
  assert.ok(s.includes("命中但题库无答案"));
  assert.ok(s.includes("没有提供标准答案"));
});

await check("未命中：明说未命中，交给模型自解", () => {
  const s = bankPromptBlock(missed);
  assert.ok(s.includes("未命中"));
  assert.ok(s.includes("没有找到"));
});

await check("相似但未确认：要求模型先核对是否同题", () => {
  const s = bankPromptBlock({ ...hitWithAnswer, verdict: "close", hit: false, score: 0.85 });
  assert.ok(s.includes("相似但未确认同题"));
  assert.ok(s.includes("自行核对"));
});

await check("三种状态都提示『公式位置为空』，避免模型当成选项缺失来推断", () => {
  for (const s of [
    bankPromptBlock(hitWithAnswer),
    bankPromptBlock(hitNoAnswer),
    bankPromptBlock(missed),
  ]) {
    assert.ok(s.length > 10);
  }
  assert.ok(bankPromptBlock(hitWithAnswer).includes("空处不代表内容缺失"));
});

console.log("\n【4】引用只保留前 3 条");

const fakeHits: Hit[] = Array.from({ length: 6 }, (_, i) => ({
  chunkId: i + 1,
  text: `片段 ${i + 1}`,
  chapter: `第${i + 1}章`,
  textbook: "王雷课件",
  page: i + 1,
  score: 1,
  via: ["全文"],
}));

await check(`CITATION_LIMIT = ${CITATION_LIMIT}`, () => assert.equal(CITATION_LIMIT, 3));

await check("6 条命中 → 只返回 3 条引用，编号 1/2/3", () => {
  const c = toCitations(fakeHits);
  assert.equal(c.length, 3);
  assert.deepEqual(
    c.map((x) => x.index),
    [1, 2, 3],
  );
  assert.equal(c[2]?.chapter, "第3章");
});

await check("不足 3 条时不补空", () => {
  assert.equal(toCitations(fakeHits.slice(0, 2)).length, 2);
  assert.equal(toCitations([]).length, 0);
});

console.log("\n【5】学生输入分流：答案 / 过程 / 提问由模型判断，代码只校验结构");

await check("reviewSchema 收下 input_kind", () => {
  const r = reviewSchema.parse({
    verdict: "unsolved",
    input_kind: "process",
    error_type: "none",
    cause: "你给的是过程",
    correction: "接着你的思路…",
    hints: [],
    related_kps: [],
  });
  assert.equal(r.input_kind, "process");
  assert.equal(r.verdict, "unsolved");
});

await check("模型给了枚举外的值 → 逐字段降级，不整份丢弃", () => {
  const r = reviewSchema.parse({
    verdict: "unsolved",
    input_kind: "大概是过程吧",
    error_type: "none",
    cause: "x",
    correction: "y",
    hints: [],
    related_kps: [],
  });
  assert.equal(r.input_kind, "unknown");
  assert.equal(r.verdict, "unsolved"); // 其他字段不受影响
  assert.equal(r.correction, "y");
});

await check("空对象也能降级成可展示的结果", () => {
  const r = reviewSchema.parse({});
  assert.equal(r.verdict, "wrong");
  assert.equal(r.error_type, "unknown");
  assert.equal(r.input_kind, "unknown");
});

await check("每个 input_kind 都有中文标签", () => {
  for (const k of INPUT_KINDS) assert.ok((INPUT_KIND_LABEL[k] ?? "").length > 0, k);
});

console.log("\n【6】降级路径：检索失败必须返回 none，不许抛错拦住解题");

await check("题目太短 → none + 原因", async () => {
  const r = await lookupBank("course-phy2.db", "???");
  assert.equal(r.verdict, "none");
  assert.equal(r.hit, false);
  assert.ok(r.reason.includes("太短"));
});

await check("教材库不存在 → none，且不联网", async () => {
  const r = await lookupBank("no-such-course.db", "一道足够长的物理题目原文用来触发检索流程");
  assert.equal(r.verdict, "none");
  assert.ok(r.reason.length > 0);
});

if (process.argv.includes("--live")) {
  console.log("\n【7】真实语料命中率（需 .env 与教材库）");
  const realQ =
    "几个力同时作用在一个具有光滑固定转轴的刚体上，如果这几个力的矢量和为零，则此刚体 (A) 必然不会转动 (B) 转速必然不变 (C) 转速必然改变 (D) 转速可能不变，也可能改变";
  await check("题库原题（去掉题号）应判为 same", async () => {
    const r = await lookupBank("course-phy2.db", realQ);
    console.log(`      score=${r.score} verdict=${r.verdict} qno=${r.question?.qno}`);
    assert.equal(r.verdict, "same");
    assert.ok(r.score >= 0.9);
  });
  await check("跨科无关问题应判为 none", async () => {
    const r = await lookupBank("course-phy2.db", "数据库里 B+ 树的分裂过程是怎样的？");
    console.log(`      score=${r.score} verdict=${r.verdict}`);
    assert.equal(r.verdict, "none");
  });
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
