-- ============================================================
-- learner.db —— 学生本地记忆库（私密，永不上传原文）
-- 设计原则：
--   1) event 只追加，是唯一的事实来源；其余表都是可重算的结论
--   2) consent 独立成表，撤回授权后可立即从教师聚合中排除
--   3) 所有"习惯/进度"都是结构化字段，不存自然语言摘要
-- ============================================================

PRAGMA foreign_keys = ON;

-- ── 身份：成年学生本人授权，无监护人环节 ────────────────────
CREATE TABLE IF NOT EXISTS profile (
  id            INTEGER PRIMARY KEY CHECK (id = 1),   -- 单用户单行
  nickname      TEXT NOT NULL,
  student_no_tail TEXT,          -- 学号后 4 位，教师端默认只显示这个
  school        TEXT,
  major         TEXT,
  grade         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── 授权：必须记录"提供给任课教师用于教学改进"这一项 ────────
CREATE TABLE IF NOT EXISTS consent (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  granted_at  TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at  TEXT,
  scope       TEXT NOT NULL,     -- JSON: {"teacher_share":true,"purpose":"teaching_improve","score_use":false}
  policy_ver  TEXT NOT NULL,     -- 授权文本版本，文本改了要重新征得同意
  note        TEXT
);

-- ── 选课：指向 textbook.db 文件，记录其版本 ─────────────────
CREATE TABLE IF NOT EXISTS subject (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  course_code   TEXT NOT NULL UNIQUE,
  course_name   TEXT NOT NULL,
  textbook_file TEXT,             -- 如 course-ds-2025.db
  textbook_ver  TEXT,             -- 对应 textbook.meta['version']
  selected_at   TEXT NOT NULL DEFAULT (datetime('now')),
  active        INTEGER NOT NULL DEFAULT 1
);

-- ── 学习习惯：维度化存储，一行一个维度值 ────────────────────
-- 维度建议：code_style / error_pattern / planning / attention_span
--          / study_time / help_seeking / revision / debug_skill
CREATE TABLE IF NOT EXISTS habit (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 维度：
  --   learn_method  学习方式偏好（中文速成网课/中文详细网课/CS英文网课/自学/看参考书/做题）
  --   code_naming   代码命名偏好（含义 → 用词）
  --   notation      符号偏好（场景 → 符号）
  --   error_pattern 反复出现的错误类型
  --   planning      计划与执行习惯
  --   help_seeking  求助方式偏好
  --   attention     注意力/单次时长
  dimension      TEXT NOT NULL,
  key            TEXT NOT NULL,        -- 语义键：'阶段:第11章' / '含义:累加器' / '场景:导数'
  value          TEXT NOT NULL,        -- 具体偏好：'中文详细网课' / 'sum' / 'y'''
  course_code    TEXT,                 -- 作用域：NULL = 通识，非空 = 只对该科目成立
  context        TEXT,                 -- 补充场景（章节名、题型、时段）
  confidence     REAL NOT NULL DEFAULT 0.5,   -- 0-1，证据越多越接近 1
  evidence_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_habit_dim ON habit(dimension);
-- 同一维度同一语义键在同一科目/场景下只允许一条。
-- 唯一索引不能写在这里：老库的 habit 表还没有 course_code / context 列，
-- schema 整体 exec 会先于 ALTER 建索引而报 no such column。
-- 由 src/db/migrate.ts 在补列之后创建（新库与老库同一条路径）。

-- ── 习惯证据：可回溯，方便学生质问"你凭什么这么说我" ────────
CREATE TABLE IF NOT EXISTS habit_evidence (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  habit_id    INTEGER NOT NULL REFERENCES habit(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,          -- message / artifact / mistake / event
  source_id   INTEGER,
  snippet     TEXT,                   -- 脱敏后的短摘录
  weight      REAL NOT NULL DEFAULT 1.0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ev_habit ON habit_evidence(habit_id);

-- ── 教材进度：按知识点粒度，教师端聚合的最小单位 ─────────────
CREATE TABLE IF NOT EXISTS progress (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  course_code   TEXT NOT NULL,
  kp_code       TEXT NOT NULL,
  kp_name       TEXT,
  chapter_title TEXT,
  status        TEXT NOT NULL DEFAULT 'untouched',
                  -- untouched / learning / passed / needs_review
  mastery       REAL NOT NULL DEFAULT 0,      -- 0-1
  attempts      INTEGER NOT NULL DEFAULT 0,
  correct       INTEGER NOT NULL DEFAULT 0,
  last_touched_at TEXT,
  UNIQUE(course_code, kp_code)
);
CREATE INDEX IF NOT EXISTS idx_progress_course ON progress(course_code);

-- ── 日程：不是课表，是"我的时间" ─────────────────────────────
-- 关键设计：
--   1) category 区分 学业 / 生活 / 工作 / 休息 —— 睡觉和打球同样是日程，
--      不能因为"不是课"就不记录，否则模型会把睡觉时间安排成学习任务。
--   2) flexibility 三档，比布尔 fixed 更准确：
--        0 = 不可动（正课、考试、睡觉、上班）
--        1 = 可微调（自习块、运动，可整体前后挪 30 分钟）
--        2 = 可被占用（空白意愿块，模型可填入学习计划）
--   3) intent 保留用户原话（"想练琴放松一下"），模型引用时要说人话，
--      而不是把用户的心愿压缩成一个 tag。
--   4) locked = 用户手动改过 → 模型重导入/重规划一律不得覆盖。
--   5) source 优先级 manual > uploaded > generated。
CREATE TABLE IF NOT EXISTS schedule (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'course',
                -- course / exam / homework / self_study / plan
                -- sport / meal / sleep / commute / work / club / rest / other
  category    TEXT NOT NULL DEFAULT 'academic',
                -- academic / life / work / rest / plan
  source      TEXT NOT NULL DEFAULT 'manual',  -- manual / uploaded / generated
  course_code TEXT,
  teacher     TEXT,
  weekday     INTEGER,            -- 1-7，重复日程用
  date        TEXT,               -- YYYY-MM-DD，一次性用
  start_time  TEXT,               -- HH:MM
  end_time    TEXT,               -- HH:MM
  location    TEXT,
  recurring   INTEGER NOT NULL DEFAULT 0,
  week_start  INTEGER NOT NULL DEFAULT 1,
  week_end    INTEGER NOT NULL DEFAULT 16,
  week_parity TEXT NOT NULL DEFAULT 'all',     -- all / odd / even
  flexibility INTEGER NOT NULL DEFAULT 0,      -- 0 / 1 / 2 见上
  intent      TEXT,               -- 用户意愿原话
  energy      TEXT,               -- high / medium / low，用户主观精力
  locked      INTEGER NOT NULL DEFAULT 0,      -- 用户手改过
  priority    INTEGER NOT NULL DEFAULT 0,      -- 数字越大越不可动
  raw_text    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_schedule_weekday ON schedule(weekday);
CREATE INDEX IF NOT EXISTS idx_schedule_cat     ON schedule(category);

-- ── 时段偏好：对某段时间的"态度"，不是占用 ──────────────────
-- 例："周一到周五 21:00-24:00 不想学" / "周六全天优先生活" / "早上适合背书"
CREATE TABLE IF NOT EXISTS time_preference (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  weekday_from INTEGER NOT NULL DEFAULT 1,   -- 1-7
  weekday_to   INTEGER NOT NULL DEFAULT 7,
  start_time  TEXT,               -- 可为空 = 全天
  end_time    TEXT,
  mode        TEXT NOT NULL,      -- avoid / prefer
  applies_to  TEXT NOT NULL DEFAULT 'study',  -- study / life / any
  strength    INTEGER NOT NULL DEFAULT 1,     -- 1 建议 / 2 强烈 / 3 绝不
  reason      TEXT,               -- 用户原话
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── 总量约束：一周/一天最多最少多少 ─────────────────────────
CREATE TABLE IF NOT EXISTS capacity_rule (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  period      TEXT NOT NULL,      -- day / week
  metric      TEXT NOT NULL,      -- study_minutes / sleep_minutes / exercise_minutes
  min_value   INTEGER,
  max_value   INTEGER,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── 学期：把"第 N 周"换算成具体日期，学习计划排期的前提 ──────
CREATE TABLE IF NOT EXISTS term (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,          -- 2026-2027-1
  start_date  TEXT NOT NULL,          -- 第 1 周周一 YYYY-MM-DD
  total_weeks INTEGER NOT NULL DEFAULT 16,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── 调课 / 停课：教务系统最常见的例外，不能只靠 weekday ──────
CREATE TABLE IF NOT EXISTS schedule_exception (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER REFERENCES schedule(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,          -- 受影响的原始日期
  kind        TEXT NOT NULL,          -- cancel / reschedule / extra
  new_date    TEXT,                   -- 调课后的日期
  new_start   TEXT,
  new_end     TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── 学期事件（成段）：假期 / 校运会 / 考试周 ────────────────
CREATE TABLE IF NOT EXISTS term_event (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  term_id       INTEGER REFERENCES term(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,     -- holiday / sports / exam_period / vacation
  start_date    TEXT NOT NULL,
  end_date      TEXT NOT NULL,
  name          TEXT,
  study_allowed INTEGER NOT NULL DEFAULT 1,  -- 寒假=0，考试周=1
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tevt_range ON term_event(start_date, end_date);

-- ── 教学日例外：调休的核心 ──────────────────────────────────
-- kind = holiday   当天无课
-- kind = suspended 当天无课且不补（校运会、停课复习）
-- kind = makeup    当天按「第 week 周星期 weekday」的课表上课
--   例：东南大学 9/20（周日）补 10/6（第3周周二）的课
--       → date=2026-09-20, kind=makeup, week=3, weekday=2
CREATE TABLE IF NOT EXISTS teaching_day (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL,
  week       INTEGER,
  weekday    INTEGER,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tday_kind ON teaching_day(kind);

-- ── 节次时间表：教务系统作息，导入课表时按节次换算 ──────────
CREATE TABLE IF NOT EXISTS class_slot (
  period     INTEGER PRIMARY KEY,
  start_time TEXT NOT NULL,
  end_time   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exc_date ON schedule_exception(date);


-- ── 目标：短期 / 长期 ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS goal (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope       TEXT NOT NULL DEFAULT 'short',   -- short / long
  course_code TEXT,
  title       TEXT NOT NULL,
  target      TEXT,
  deadline    TEXT,
  status      TEXT NOT NULL DEFAULT 'active',  -- active / done / dropped
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── 学习路径：由目标 + 现有基础 + 日程共同生成 ───────────────
CREATE TABLE IF NOT EXISTS roadmap (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id     INTEGER REFERENCES goal(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  model       TEXT,
  summary     TEXT,
  total_items INTEGER NOT NULL DEFAULT 0,
  est_hours   REAL
);

CREATE TABLE IF NOT EXISTS roadmap_item (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  roadmap_id    INTEGER NOT NULL REFERENCES roadmap(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  title         TEXT NOT NULL,
  kp_codes      TEXT,             -- JSON 数组
  est_minutes   INTEGER,
  scheduled_date TEXT,            -- 分配到日程的具体日期
  schedule_id   INTEGER REFERENCES schedule(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'todo',  -- todo / doing / done / skipped
  note          TEXT
);
CREATE INDEX IF NOT EXISTS idx_ri_roadmap ON roadmap_item(roadmap_id);
CREATE INDEX IF NOT EXISTS idx_ri_date    ON roadmap_item(scheduled_date);


-- ── 章节进度：连续过程学习的核心 ────────────────────────────
-- 与 progress 表的区别：progress 记"知识点掌握度"（离散、由做题推断），
-- chapter_progress 记"学到第几章"（连续、由用户确认或对话推断）。
-- 门控检索只认这张表：未学章节的教材正文不进上下文，模型见不到就用不出来。
CREATE TABLE IF NOT EXISTS chapter_progress (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  course_code   TEXT NOT NULL,
  chapter_no    INTEGER NOT NULL,     -- 对应 textbook.db 的 chapter.chapter_no
  chapter_title TEXT,
  status        TEXT NOT NULL DEFAULT 'learning',
                  -- not_started / learning / done
  confidence    REAL NOT NULL DEFAULT 0.6,
  source        TEXT NOT NULL DEFAULT 'manual',  -- manual / chat / mistake / plan
  evidence      TEXT,                 -- 依据：哪句话/哪道题推出来的
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(course_code, chapter_no)
);
CREATE INDEX IF NOT EXISTS idx_chprog_course ON chapter_progress(course_code);
-- ── 错题本：error_type 是教师端归因分析的核心字段 ───────────
CREATE TABLE IF NOT EXISTS mistake (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  course_code    TEXT,
  title          TEXT,
  kp_codes       TEXT,            -- JSON 数组
  source         TEXT NOT NULL DEFAULT 'text',  -- photo / text / code / file
  artifact_id    INTEGER REFERENCES artifact(id) ON DELETE SET NULL,
  raw_text       TEXT,
  code_lang      TEXT,            -- 若为代码题
  my_answer      TEXT,
  correct_answer TEXT,
  error_type     TEXT,            -- concept / misread / boundary / syntax
                                  -- / debug / logic / careless / unknown
  error_detail   TEXT,
  tags           TEXT,            -- JSON 数组
  difficulty     INTEGER,
  resolved       INTEGER NOT NULL DEFAULT 0,
  saved_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mistake_course ON mistake(course_code);
CREATE INDEX IF NOT EXISTS idx_mistake_type   ON mistake(error_type);

-- ── 错题重做：验证"改过了"还是"只是看过了" ──────────────────
CREATE TABLE IF NOT EXISTS mistake_attempt (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  mistake_id  INTEGER NOT NULL REFERENCES mistake(id) ON DELETE CASCADE,
  attempted_at TEXT NOT NULL DEFAULT (datetime('now')),
  correct     INTEGER NOT NULL,
  my_answer   TEXT,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempt_mistake ON mistake_attempt(mistake_id);

-- ── 习题集：举一反三的产物 ──────────────────────────────────
CREATE TABLE IF NOT EXISTS exercise_set (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT NOT NULL,
  course_code     TEXT,
  kp_codes        TEXT,           -- JSON 数组
  difficulty      INTEGER,
  origin_mistake_id INTEGER REFERENCES mistake(id) ON DELETE SET NULL,
  items           TEXT NOT NULL,  -- JSON: [{q, answer, hint, kp}]
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── 上传文件：原始文件永不删，便于回溯 ──────────────────────
CREATE TABLE IF NOT EXISTS artifact (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,       -- pdf / docx / image / code / text / xlsx
  filename   TEXT NOT NULL,
  path       TEXT NOT NULL,
  sha256     TEXT NOT NULL,
  bytes      INTEGER,
  parsed     INTEGER NOT NULL DEFAULT 0,
  parse_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── 对话 ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversation (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT,
  course_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS message (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,   -- user / assistant / system
  content         TEXT NOT NULL,
  model           TEXT,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON message(conversation_id);

-- ── 行为事件流：只追加，不改不删，是唯一事实来源 ─────────────
CREATE TABLE IF NOT EXISTS event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL DEFAULT (datetime('now')),
  type       TEXT NOT NULL,
  ref_type   TEXT,
  ref_id     INTEGER,
  payload    TEXT           -- JSON
);
CREATE INDEX IF NOT EXISTS idx_event_ts   ON event(ts);
CREATE INDEX IF NOT EXISTS idx_event_type ON event(type);

-- ── 同步审计：发给教师端的每一个包都要可追溯、可撤回 ────────
CREATE TABLE IF NOT EXISTS sync_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  exported_at   TEXT NOT NULL DEFAULT (datetime('now')),
  period_start  TEXT NOT NULL,
  period_end    TEXT NOT NULL,
  record_count  INTEGER NOT NULL,
  payload_sha256 TEXT NOT NULL,
  destination   TEXT,
  revoked_at    TEXT
);
