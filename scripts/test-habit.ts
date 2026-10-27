import "dotenv/config";
import assert from "node:assert/strict";
import { getLearnerDb } from "../src/db/index.js";
import {
  extractHabits,
  injectableHabits,
  rebuildHabitFromEvents,
  rejectHabit,
} from "../src/memory/habit-extract.js";
import { loadProfile, profilePrompt } from "../src/memory/profile.js";

const db = getLearnerDb();
const C = "PHY2";

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

const CODE_SAMPLE = `
int calc_avg(int arr[], int n) {
    int sum = 0;
    for (int i = 0; i < n; i++) sum += arr[i];
    return sum / n;
}
double v = 3.0e8;
// 我一般把累加器叫 sum，下标叫 i，临时变量叫 tmp
`;

const ANSWER_SAMPLE = `
解：由 2nd + λ/2 = kλ 得 d = λ/(4n)。
代入 λ = 500 nm，n = 1.5，得 d = 8.33e-8 m。
注：我老是忘记把 nm 换算成 m，这次又差点直接代 500。
`;

async function main(): Promise<void> {
  db.prepare("DELETE FROM habit").run();
  db.prepare("DELETE FROM habit_evidence").run();
  db.prepare("DELETE FROM event WHERE type LIKE 'habit_%'").run();

  console.log("\n【1】重算幂等（无事件时）");
  await check("空事件流重算得到 0 条", () => {
    const r = rebuildHabitFromEvents(db);
    assert.equal(r.habits, 0);
    assert.equal(r.evidence, 0);
  });

  console.log("\n【2】真实模型抽取");
  const codeRes = await extractHabits(db, {
    text: CODE_SAMPLE,
    kind: "code",
    course: C,
    sourceType: "artifact",
    sourceId: 101,
  });
  console.log(
    `      代码 → 抽出 ${codeRes.habits.length} 条，写入事件 ${codeRes.written} 条，${codeRes.ms}ms`,
  );
  for (const h of codeRes.habits) console.log(`        ${h.dimension}: ${h.key} → ${h.value}`);

  const ansRes = await extractHabits(db, {
    text: ANSWER_SAMPLE,
    kind: "answer",
    course: C,
    sourceType: "artifact",
    sourceId: 102,
  });
  console.log(
    `      作答 → 抽出 ${ansRes.habits.length} 条，写入事件 ${ansRes.written} 条，${ansRes.ms}ms`,
  );
  for (const h of ansRes.habits) console.log(`        ${h.dimension}: ${h.key} → ${h.value}`);

  await check("至少抽出一条习惯", () => {
    assert.ok(codeRes.habits.length + ansRes.habits.length > 0, "两条材料都没抽出习惯");
  });
  await check("抽出的维度都在白名单内", () => {
    const ok = new Set([
      "learn_method",
      "code_naming",
      "notation",
      "study_time",
      "error_pattern",
      "planning",
      "help_seeking",
      "attention",
    ]);
    for (const h of [...codeRes.habits, ...ansRes.habits]) {
      assert.ok(ok.has(h.dimension), `非法维度 ${h.dimension}`);
    }
  });
  await check("每条都有 snippet 证据", () => {
    for (const h of [...codeRes.habits, ...ansRes.habits]) {
      assert.ok(h.snippet.length > 0, `${h.key} 缺 snippet`);
    }
  });

  console.log("\n【3】重算幂等（有事件时）");
  const a = rebuildHabitFromEvents(db);
  const b = rebuildHabitFromEvents(db);
  console.log(`      第一次 ${a.habits} 条 / ${a.evidence} 证据；第二次 ${b.habits} 条 / ${b.evidence} 证据`);
  await check("两次重算结果完全一致", () => {
    assert.deepEqual(a, b);
  });
  await check("重算后 habit 行数与报告一致", () => {
    const n = (db.prepare("SELECT COUNT(*) c FROM habit").get() as { c: number }).c;
    assert.equal(n, b.habits);
  });
  await check("每条习惯的 evidence_count 与证据行数吻合", () => {
    const rows = db
      .prepare(
        `SELECT h.id, h.evidence_count,
                (SELECT COUNT(*) FROM habit_evidence e WHERE e.habit_id = h.id) AS actual
         FROM habit h`,
      )
      .all() as Array<{ id: number; evidence_count: number; actual: number }>;
    for (const r of rows) {
      assert.equal(r.evidence_count, r.actual, `habit ${r.id} 计数不一致`);
    }
  });

  console.log("\n【4】证据阈值（≥2 且 ≥0.6 才注入）");
  const all = db
    .prepare("SELECT id, key, evidence_count, confidence FROM habit")
    .all() as Array<{ id: number; key: string; evidence_count: number; confidence: number }>;
  console.log(
    `      全部习惯: ${all.map((h) => `${h.key}(${h.evidence_count}条,${h.confidence})`).join("; ") || "无"}`,
  );
  await check("只有 1 条证据的习惯不进入注入集", () => {
    const single = all.filter((h) => h.evidence_count === 1);
    const injected = new Set(injectableHabits(db, C).map((h) => h.id));
    for (const h of single) assert.ok(!injected.has(h.id), `${h.key} 证据不足却注入了`);
  });
  await check("注入集里每条都满足阈值", () => {
    for (const h of injectableHabits(db, C)) {
      assert.ok(h.evidence_count >= 2, `${h.key} 证据 ${h.evidence_count}`);
      assert.ok(h.confidence >= 0.6, `${h.key} 置信度 ${h.confidence}`);
    }
  });

  console.log("\n【5】同一 artifact 多切片只算一条证据");
  const before = db.prepare("SELECT COUNT(*) c FROM habit WHERE key = ?").get("含义:累加器") as {
    c: number;
  };
  if (before.c > 0) {
    const h = db.prepare("SELECT id, evidence_count FROM habit WHERE key = ?").get("含义:累加器") as {
      id: number;
      evidence_count: number;
    };
    // 同一 sourceId=101 再抽一次，不应增加证据数
    await extractHabits(db, {
      text: CODE_SAMPLE,
      kind: "code",
      course: C,
      sourceType: "artifact",
      sourceId: 101,
    });
    const after = db
      .prepare("SELECT evidence_count FROM habit WHERE key = ?")
      .get("含义:累加器") as { evidence_count: number };
    await check("重复抽取同一 artifact 不增加证据数", () => {
      assert.equal(after.evidence_count, h.evidence_count, "证据被重复计数");
    });
  } else {
    console.log("      （模型未抽出「累加器」，跳过该项）");
  }

  console.log("\n【6】用户否决后永不注入");
  const target = db.prepare("SELECT id, key FROM habit LIMIT 1").get() as
    | { id: number; key: string }
    | undefined;
  if (target) {
    rejectHabit(db, target.id);
    await check("否决后不在注入集里", () => {
      const ids = new Set(injectableHabits(db, C).map((h) => h.id));
      const still = db.prepare("SELECT id FROM habit WHERE key = ?").get(target.key) as
        | { id: number }
        | undefined;
      if (still) assert.ok(!ids.has(still.id), "被否决的习惯仍被注入");
    });
    await check("否决后证据仍保留（可追溯）", () => {
      const n = (
        db.prepare("SELECT evidence_count c FROM habit WHERE key = ?").get(target.key) as {
          c: number;
        }
      ).c;
      assert.ok(n >= 1, "证据被删光了");
    });
    await check("否决状态写入 status=rejected", () => {
      const s = db.prepare("SELECT status FROM habit WHERE key = ?").get(target.key) as {
        status: string;
      };
      assert.equal(s.status, "rejected");
    });
  }

  console.log("\n【7】画像只用达标习惯");
  const prompt = profilePrompt(loadProfile(db, C));
  console.log("\n──── 注入的画像 ────");
  console.log(prompt);
  console.log("────────────────────\n");
  await check("画像里不出现证据不足的习惯", () => {
    const injectedIds = new Set(injectableHabits(db, C).map((h) => h.id));
    const withheld = all.filter((h) => !injectedIds.has(h.id) && h.evidence_count < 2);
    for (const h of withheld) {
      assert.ok(!prompt.includes(h.key), `证据不足的 ${h.key} 出现在画像里`);
    }
  });

  db.prepare("DELETE FROM habit").run();
  db.prepare("DELETE FROM habit_evidence").run();
  db.prepare("DELETE FROM event WHERE type LIKE 'habit_%'").run();

  console.log(`\n${"─".repeat(56)}\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
