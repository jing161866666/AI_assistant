import type { DatabaseSync } from "node:sqlite";

/**
 * 轻量迁移：schema.sql 只对"新库"生效（CREATE TABLE IF NOT EXISTS 不会加列）。
 * 已有库必须靠 ALTER TABLE 补列，否则老用户升级后直接报 no such column。
 *
 * 规则：只加列，不改列，不删列。每次新增字段都在 MIGRATIONS 里追加一条。
 */
interface ColumnSpec {
  table: string;
  column: string;
  ddl: string;
}

const MIGRATIONS: ColumnSpec[] = [
  // 日程表：周次 / 单双周 / 三档可动性 / 意愿 / 锁定
  { table: "schedule", column: "course_code", ddl: "TEXT" },
  { table: "schedule", column: "teacher", ddl: "TEXT" },
  { table: "schedule", column: "week_start", ddl: "INTEGER NOT NULL DEFAULT 1" },
  { table: "schedule", column: "week_end", ddl: "INTEGER NOT NULL DEFAULT 16" },
  { table: "schedule", column: "week_parity", ddl: "TEXT NOT NULL DEFAULT 'all'" },
  { table: "schedule", column: "category", ddl: "TEXT NOT NULL DEFAULT 'academic'" },
  { table: "schedule", column: "flexibility", ddl: "INTEGER NOT NULL DEFAULT 0" },
  { table: "schedule", column: "intent", ddl: "TEXT" },
  { table: "schedule", column: "energy", ddl: "TEXT" },
  { table: "schedule", column: "locked", ddl: "INTEGER NOT NULL DEFAULT 0" },
  // 学习路径条目：指回具体日程块
  { table: "roadmap_item", column: "schedule_id", ddl: "INTEGER" },
  // 学习路径的科目维度：一条路径可以联合多个科目，所以两端都要记
  //   roadmap.course_codes  = JSON 数组，路径覆盖了哪几科
  //   roadmap_item.course_code = 这一条属于哪一科（排期/门控/检索都按它走）
  { table: "roadmap", column: "course_codes", ddl: "TEXT" },
  { table: "roadmap_item", column: "course_code", ddl: "TEXT" },
  // 学习习惯：从「一维一值」升级为「可作用于某科目/某场景」
  { table: "habit", column: "course_code", ddl: "TEXT" },
  { table: "habit", column: "context", ddl: "TEXT" },
  { table: "habit", column: "status", ddl: "TEXT NOT NULL DEFAULT 'active'" },
  { table: "habit", column: "source", ddl: "TEXT NOT NULL DEFAULT 'model'" },
  // 科目注册表：增加科目时用到的软字段（老库补列，新库由 schema.sql 建好）
  { table: "subject", column: "learner_file", ddl: "TEXT" },
  { table: "subject", column: "note", ddl: "TEXT" },
  { table: "subject", column: "updated_at", ddl: "TEXT" },
  // 用户逐个勾选"允许 AI 辅助"的科目；默认 0 = 未授权，必须显式勾
  { table: "subject", column: "ai_enabled", ddl: "INTEGER NOT NULL DEFAULT 0" },
  // 错题按科目归类展示需要稳定的科目列；老库可能没有（schema 只对新库生效）
  { table: "mistake", column: "course_code", ddl: "TEXT" },
];

/**
 * 补列之后才能建的索引。
 * 写不进 schema.sql：老库表结构缺列时，schema 整体 exec 会在 ALTER 之前建索引而失败。
 * 放在这里，新库与老库走同一条路径，不会漏。
 */
const POST_MIGRATION_INDEXES: Array<{ name: string; table: string; ddl: string }> = [
  {
    name: "uq_habit",
    table: "habit",
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS uq_habit
          ON habit(dimension, key, COALESCE(course_code, ''), COALESCE(context, ''))`,
  },
  {
    // 学习路径按科目查：跨科目路径要能按 course_code 过滤每条 item
    name: "idx_ri_course",
    table: "roadmap_item",
    ddl: "CREATE INDEX IF NOT EXISTS idx_ri_course ON roadmap_item(course_code)",
  },
];

function hasTable(db: DatabaseSync, table: string): boolean {
  const r = db
    .prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name = ?")
    .get(table);
  return Boolean(r);
}

function columns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((r) => r.name));
}

/**
 * 表重建迁移：SQLite 无法删除 CREATE TABLE 里内嵌的 UNIQUE。
 * 旧 habit 有 UNIQUE(dimension, key)，会挡住「同一习惯作用于不同科目」，
 * 例如两个科目都偏好「中文详细网课」。必须整表重建才能去掉。
 *
 * 只在检测到旧约束时执行一次，并保留全部行。
 */
const HABIT_REBUILD_SQL = `
CREATE TABLE habit__new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  dimension      TEXT NOT NULL,
  key            TEXT NOT NULL,
  value          TEXT NOT NULL,
  course_code    TEXT,
  context        TEXT,
  confidence     REAL NOT NULL DEFAULT 0.5,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'active',
  source         TEXT NOT NULL DEFAULT 'model',
  first_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
)`;

function needsHabitRebuild(db: DatabaseSync): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='habit'")
    .get() as { sql: string } | undefined;
  if (!row?.sql) return false;
  return /UNIQUE\s*\(\s*dimension\s*,\s*key\s*\)/i.test(row.sql);
}

function rebuildHabit(db: DatabaseSync): void {
  const has = columns(db, "habit");
  const pick = (c: string, fallback: string): string => (has.has(c) ? c : fallback);
  db.exec("BEGIN");
  try {
    db.exec(HABIT_REBUILD_SQL);
    db.exec(
      `INSERT INTO habit__new
        (id, dimension, key, value, course_code, context, confidence,
         evidence_count, first_seen_at, updated_at)
       SELECT id, dimension, key, value,
              ${pick("course_code", "NULL")}, ${pick("context", "NULL")},
              ${pick("confidence", "0.5")}, ${pick("evidence_count", "0")},
              ${pick("first_seen_at", "datetime('now')")},
              ${pick("updated_at", "datetime('now')")}
       FROM habit`,
    );
    db.exec("DROP TABLE habit");
    db.exec("ALTER TABLE habit__new RENAME TO habit");
    db.exec("CREATE INDEX IF NOT EXISTS idx_habit_dim ON habit(dimension)");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export interface MigrationReport {
  applied: string[];
}

export function migrate(db: DatabaseSync): MigrationReport {
  const applied: string[] = [];

  // 表重建必须在补列之前：重建后的表已包含全部新列
  if (hasTable(db, "habit") && needsHabitRebuild(db)) {
    try {
      rebuildHabit(db);
      applied.push("habit(重建：解除 UNIQUE(dimension,key))");
    } catch (e) {
      applied.push(`!habit 重建失败: ${(e as Error).message}`);
    }
  }

  // 按表分组，避免每列都查一次 PRAGMA
  const byTable = new Map<string, ColumnSpec[]>();
  for (const m of MIGRATIONS) {
    const list = byTable.get(m.table) ?? [];
    list.push(m);
    byTable.set(m.table, list);
  }

  for (const [table, specs] of byTable) {
    if (!hasTable(db, table)) continue; // 新库由 schema.sql 建好，无需 ALTER
    const exist = columns(db, table);
    for (const s of specs) {
      if (exist.has(s.column)) continue;
      db.exec(`ALTER TABLE "${table}" ADD COLUMN "${s.column}" ${s.ddl}`);
      applied.push(`${table}.${s.column}`);
    }
  }

  // 列补全后再建索引。唯一索引可能因老数据重复而失败，
  // 此时不能让整个启动流程挂掉：记一条报告，交给人工清理。
  for (const idx of POST_MIGRATION_INDEXES) {
    if (!hasTable(db, idx.table)) continue;
    try {
      db.exec(idx.ddl);
    } catch (e) {
      applied.push(`!${idx.name} 建索引失败（可能存在重复行）: ${(e as Error).message}`);
    }
  }

  return { applied };
}
