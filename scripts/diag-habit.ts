import "dotenv/config";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { rebuildHabitFromEvents } from "../src/memory/habit-extract.js";
import {
  buildActivityDigest,
  habitQueueState,
  refreshHabitsFromActivity,
} from "../src/memory/habit-pipeline.js";

/**
 * 一次性诊断：习惯管线为什么没有产出。
 * 在 learner.db 的副本上跑，不碰真实库（VACUUM INTO 是 WAL 安全的一致性快照）。
 */
const COPY = `data/diag/learner-${Date.now()}.db`;
mkdirSync("data/diag", { recursive: true });

const src = new DatabaseSync("data/learner.db");
src.exec(`VACUUM INTO '${COPY}'`);
src.close();

const db = new DatabaseSync(COPY);

const digest = buildActivityDigest(db, "PHY2", 30);
console.log("=== 行为摘要 ===");
console.log(digest.text);
console.log(`empty = ${digest.empty}`);

const before = db
  .prepare("SELECT COUNT(*) AS c FROM event WHERE type = 'habit_inferred'")
  .get() as {
  c: number;
};
console.log(`\n=== 投递前 === habit_inferred 事件 ${before.c} 条`);

const r = refreshHabitsFromActivity(db, "PHY2", 30);
console.log("refreshHabitsFromActivity ->", JSON.stringify(r));
console.log("queue:", JSON.stringify(habitQueueState()));

// drain() 在 running=true 时是空操作，必须轮询到空闲，否则读到半截结果
const t0 = Date.now();
while (habitQueueState().running && Date.now() - t0 < 180_000) {
  await new Promise((res) => setTimeout(res, 300));
}
const waited = Math.round((Date.now() - t0) / 100) / 10;
console.log(`waited ${waited}s, queue:`, JSON.stringify(habitQueueState()));

const inferred = db
  .prepare("SELECT id, ref_type, ref_id, payload FROM event WHERE type = 'habit_inferred'")
  .all() as Array<{ id: number; ref_type: string; ref_id: number | null; payload: string }>;
console.log(`\nhabit_inferred events: ${inferred.length}`);
for (const e of inferred) console.log("  ", e.payload.slice(0, 240));

console.log("\n=== after ===");
console.log("rebuild:", JSON.stringify(rebuildHabitFromEvents(db)));
const rows = db
  .prepare(
    "SELECT dimension, key, value, evidence_count, confidence, status FROM habit ORDER BY dimension",
  )
  .all();
console.log(`habit rows: ${rows.length}`);
for (const x of rows) console.log("  ", JSON.stringify(x));
db.close();
