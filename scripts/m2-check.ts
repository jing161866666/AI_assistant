import "dotenv/config";
import { getLearnerDb } from "../src/db/index.js";

/** 验证 habit 表重建迁移：旧 UNIQUE(dimension,key) 去掉后可跨科目存同一习惯 */
const db = getLearnerDb();

const sql = (
  db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='habit'").get() as {
    sql: string;
  }
).sql;
const stillOld = /UNIQUE\s*\(\s*dimension\s*,\s*key\s*\)/i.test(sql);
console.log(`旧 UNIQUE(dimension,key) 已去除: ${!stillOld}`);

const idx = db
  .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='habit'")
  .all() as Array<{ name: string }>;
console.log(`索引: ${idx.map((i) => i.name).join(", ")}`);

const cols = (db.prepare("PRAGMA table_info(habit)").all() as Array<{ name: string }>).map(
  (r) => r.name,
);
console.log(`列: ${cols.join(", ")}`);

const ins = db.prepare(
  "INSERT INTO habit (dimension, key, value, course_code, context) VALUES (?,?,?,?,?)",
);
ins.run("learn_method", "阶段:第11章", "中文详细网课", "PHY2", null);
ins.run("learn_method", "阶段:第11章", "CS英文网课", "DS", null);
console.log("跨科目同键写入: OK");

const rows = db
  .prepare("SELECT course_code, value FROM habit WHERE key = ?")
  .all("阶段:第11章") as Array<{ course_code: string; value: string }>;
for (const r of rows) console.log(`  ${r.course_code} → ${r.value}`);

db.prepare("DELETE FROM habit").run();
console.log("已清理验证数据");
