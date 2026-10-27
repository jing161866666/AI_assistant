-- ============================================================
-- textbook.db —— 教材库（只读，按课程预构建，全校共用）
-- 学生只下载，不在本地解析 PDF / 不本地算 embedding
-- 关键：知识点 ID 由本库统一制定，否则教师端聚合无法对齐
-- ============================================================

PRAGMA foreign_keys = ON;

-- ── 课程：一个课程一个 .db 文件 ─────────────────────────────
CREATE TABLE IF NOT EXISTS course (
  code        TEXT PRIMARY KEY,          -- 如 'DS2025'
  name        TEXT NOT NULL,             -- 数据结构
  school      TEXT,
  term        TEXT,                      -- 2025-2026-1
  credits     REAL,
  description TEXT
);

-- ── 教材 ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS textbook (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  course_code TEXT NOT NULL REFERENCES course(code) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  authors     TEXT,
  publisher   TEXT,
  edition     TEXT,
  isbn        TEXT,
  total_pages INTEGER,
  source_file TEXT
);
CREATE INDEX IF NOT EXISTS idx_textbook_course ON textbook(course_code);

-- ── 章节树：用 parent_id 自引用，支持任意深度 ────────────────
CREATE TABLE IF NOT EXISTS chapter (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  textbook_id INTEGER NOT NULL REFERENCES textbook(id) ON DELETE CASCADE,
  parent_id   INTEGER REFERENCES chapter(id) ON DELETE CASCADE,
  level       INTEGER NOT NULL DEFAULT 1,
  seq         INTEGER NOT NULL,
  title       TEXT NOT NULL,
  page_start  INTEGER,
  page_end    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_chapter_tb   ON chapter(textbook_id);
CREATE INDEX IF NOT EXISTS idx_chapter_tree ON chapter(parent_id);

-- ── 切片：RAG 的检索单元 ────────────────────────────────────
CREATE TABLE IF NOT EXISTS chunk (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  textbook_id INTEGER NOT NULL REFERENCES textbook(id) ON DELETE CASCADE,
  chapter_id INTEGER REFERENCES chapter(id) ON DELETE SET NULL,
  seq        INTEGER NOT NULL,
  page_from  INTEGER,
  page_to    INTEGER,
  text       TEXT NOT NULL,
  n_chars    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunk_tb      ON chunk(textbook_id);
CREATE INDEX IF NOT EXISTS idx_chunk_chapter ON chunk(chapter_id);

-- ── 全文检索（中文用 unicode61，无需分词器；混合检索的另一半）──
-- 注意：ingest 时必须同时写入 chunk 和 chunk_fts（rowid 对齐 chunk.id）
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
  text,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- ── 向量：float32 小端 BLOB，dim 与 meta.embed_dim 一致 ──────
CREATE TABLE IF NOT EXISTS chunk_vec (
  chunk_id INTEGER PRIMARY KEY REFERENCES chunk(id) ON DELETE CASCADE,
  dim      INTEGER NOT NULL,
  vec      BLOB NOT NULL
);

-- ── 知识点：教师端聚合的唯一对齐锚点 ────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_point (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  course_code TEXT NOT NULL REFERENCES course(code) ON DELETE CASCADE,
  code        TEXT NOT NULL,             -- 稳定标识，如 'DS.KMP.NEXT'
  name        TEXT NOT NULL,             -- KMP 失配函数
  aliases     TEXT,                      -- JSON 数组：["next数组","失效函数"]
  chapter_id  INTEGER REFERENCES chapter(id) ON DELETE SET NULL,
  difficulty  INTEGER DEFAULT 3,         -- 1-5
  UNIQUE(course_code, code)
);
CREATE INDEX IF NOT EXISTS idx_kp_chapter ON knowledge_point(chapter_id);

-- ── 知识点 ↔ 切片（多对多，weight 表示该切片对本知识点的代表性）──
CREATE TABLE IF NOT EXISTS kp_chunk (
  kp_id    INTEGER NOT NULL REFERENCES knowledge_point(id) ON DELETE CASCADE,
  chunk_id INTEGER NOT NULL REFERENCES chunk(id) ON DELETE CASCADE,
  weight   REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (kp_id, chunk_id)
);

-- ── 版本元信息：学生端据此判断是否需要重新下载 ──────────────
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
