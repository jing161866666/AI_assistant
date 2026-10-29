import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "./migrate.js";

export const ROOT = process.cwd();

export const paths = {
  data: resolve(ROOT, "data"),
  // 测试用 TEXTBOOK_DIR 指到临时目录：否则测试建的 course-*.db 会被正在运行的服务
  // 自动登记成科目（真实污染），这条踩过坑。
  textbook: resolve(ROOT, process.env.TEXTBOOK_DIR ?? "data/textbook"),
  uploads: resolve(ROOT, "data/uploads"),
  exports: resolve(ROOT, "data/exports"),
  learnerDb: resolve(ROOT, process.env.DB_PATH ?? "./data/learner.db"),
  schemaDir: resolve(ROOT, "db/schema"),
};

function applySchema(db: DatabaseSync, file: string): void {
  const p = resolve(paths.schemaDir, file);
  if (!existsSync(p)) throw new Error(`schema 文件不存在: ${p}`);
  db.exec(readFileSync(p, "utf8"));
}

function tune(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
}

let learnerDb: DatabaseSync | null = null;

/** 打开（并在首次打开时初始化）学生本地记忆库 */
export function getLearnerDb(): DatabaseSync {
  if (learnerDb) return learnerDb;
  mkdirSync(dirname(paths.learnerDb), { recursive: true });
  const db = new DatabaseSync(paths.learnerDb);
  tune(db);
  applySchema(db, "learner.sql");
  // 老库补列：schema.sql 的 CREATE TABLE IF NOT EXISTS 不会给已存在的表加列
  const report = migrate(db);
  if (report.applied.length > 0) {
    console.log(`[db] 已迁移 ${report.applied.length} 个字段: ${report.applied.join(", ")}`);
  }
  learnerDb = db;
  return db;
}

/** 关闭连接（测试 / 退出时用） */
export function closeLearnerDb(): void {
  learnerDb?.close();
  learnerDb = null;
}

/**
 * 打开某门课程的教材库（只读语义：业务代码不应写入）
 * 文件不存在时抛错，避免静默创建空库导致检索永远返回空
 */
export function openTextbookDb(file: string): DatabaseSync {
  const p = resolve(paths.textbook, file);
  if (!existsSync(p)) {
    throw new Error(
      `教材库不存在: ${p}\n请先下载课程教材库，或用 scripts/build-textbook.ts 构建。`,
    );
  }
  const db = new DatabaseSync(p, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

/** 列出全部已存在的教材库文件 */
export function listTextbookDbs(): string[] {
  if (!existsSync(paths.textbook)) return [];
  return readdirSync(paths.textbook).filter((f) => f.endsWith(".db"));
}

export interface TableStat {
  name: string;
  rows: number;
}

/** 供自检脚本使用：列出所有用户表及行数 */
export function inspectTables(db: DatabaseSync): TableStat[] {
  const names = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  return names.map(({ name }) => {
    let rows = 0;
    try {
      const r = db.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get() as {
        c: number;
      };
      rows = Number(r.c);
    } catch {
      rows = -1; // 虚拟表可能不支持 COUNT
    }
    return { name, rows };
  });
}
