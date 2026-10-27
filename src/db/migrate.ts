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

export interface MigrationReport {
  applied: string[];
}

export function migrate(db: DatabaseSync): MigrationReport {
  const applied: string[] = [];
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
  return { applied };
}
