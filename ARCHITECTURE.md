# 架构与协作边界

> 本文档的目的是让**第二个人**能在不自问"这该改哪"的情况下动手。
> 修改模块边界前，请先在 `docs/decisions/` 提一条决策记录。

## 一、一句话架构

**本地 SQLite 作为延长上下文**：教材库只读按课程分发，学生记忆库私密本地，教师端只收脱敏摘要。

```
┌──────────────┐   只读下载    ┌──────────────┐
│ textbook.db  │ ────────────▶ │              │
│ 按课程预构建  │               │  learner.db  │◀── 学生本地，私密
└──────────────┘               │  （18+ 表）   │
                               └──────┬───────┘
                                      │ 脱敏摘要（每周）
                                      ▼
                               ┌──────────────┐
                               │ 极轻汇聚端    │──▶ 教师看板 / 报告
                               └──────────────┘
```

## 二、目录职责（谁改哪里）

| 路径 | 职责 | 改动影响面 |
|---|---|---|
| `db/schema/*.sql` | 表结构**唯一真相** | 全项目 |
| `src/db/migrate.ts` | 已存在库的补列迁移 | 老用户升级 |
| `src/db/index.ts` | 连接管理、schema 应用 | 全项目 |
| `src/schedule/service.ts` | 时间计算纯函数 + 排期算法 + 只读查询/校验 | 日程/计划/教师统计 |
| `src/schedule/write.ts` | 日程增删改（用户表单与模型工具共用） | 日程数据 |
| `src/schedule/tools.ts` | 给大模型的工具定义 | 模型行为 |
| `src/academic/*.ts` | 校历先验知识 | 课表/计划 |
| `src/llm/*` | 四角色模型封装 | 所有 AI 功能 |
| `scripts/*` | 一次性任务、导入、测试、演示 | 无运行时影响 |
| `web/` | 前端（待建） | 仅界面 |

**规则**：`src/schedule/service.ts` 里的函数必须是纯的或只读 DB。任何写库操作放 `src/schedule/write.ts` 或 `src/schedule/tools.ts`。

## 三、三条必须遵守的约定

### 1. 数据库列名 = TypeScript 字段名（一律 snake_case）

**不要**在数据对象里做 camelCase 转换。真实事故：测试里写了 `term.totalWeeks`，而实际字段是 `total_weeks`，导致 `undefined` 参与日期运算，整份测试静默全挂。

- DB 列：`total_weeks`
- TS 接口：`total_weeks`
- 只在 UI 渲染层做一次性转换

### 2. 表结构改动必须同时改两处

`db/schema/learner.sql` 的 `CREATE TABLE` **只对新库生效**。
已有库靠 `src/db/migrate.ts` 的 `MIGRATIONS` 补列。

两人的 PR 同时加列 → `MIGRATIONS` 数组必然冲突。约定：
- 每条迁移紧挨着表定义注释写清楚用途
- 合并时按表名分组，不要按时间顺序散落

### 3. 调休/节假日只能来自 `teaching_day` 表

禁止在业务代码里 `if (date === "2026-10-01")` 这种硬编码。
所有放假、停课、调休都由 `scripts/import-calendar.ts` 从 `src/academic/` 的先验知识导入。

## 四、数据隔离：教材按科目分库，记忆共库按 `course_code`

| 层 | 隔离方式 | 现状 |
|---|---|---|
| 科目注册 | **逻辑隔离**：一个 `learner.db` 的 `subject` 表，一行一门课，指到它的教材库 | `src/memory/subjects.ts`；`/api/courses` 增删改，教材库文件会自动登记成科目 |
| 教材 / 题库 | **物理隔离**：`data/textbook/course-<code>.db`，`openTextbookDb(file)` 只读 | 答题只打开该科目的库，`retrieve/ask/solve/lookupBank` 都接单个 `file` |
| 学习记忆 | **逻辑隔离**：一个 `data/learner.db`，靠 `course_code` 列区分 | 见下；`subject.learner_file` 为第二步"记忆物理分库"预留 |

**增加科目只做两件事**：`POST /api/courses` 登记科目（代码/名称/备注），
再用 `npm run build:course -- --course <简称> --code <CODE>` 构建该科知识库。**不许**用模型代写教材/题库/大纲（AGENTS 第二节）。
登记了但还没建库的科目可以记录进度/错题/习惯，只是不能问教材与改错。

**课程资料目录（用户提供先验知识的唯一入口）**：

```
课程/<课程简称>/          文件夹名就是简称，如 概率论、大学物理下、工数
  教材/                   教科书/讲义：docx、pdf、md、txt
  参考书/                 习题解答、参考教材（同上；.doc/.ppt 旧格式需转换）
  课件/                   pptx、pdf
  题库/                   docx（按题切）
```

- `src/course/corpus.ts` 扫描目录（不猜格式，旧格式列进 `unsupported` 报警）。
- `scripts/build-course.ts` 建库：章号优先从正文 **`§N.M` 小节号**恢复（教材标题常丢失），
  章名取目录行；无小节号才退回「第N章」；都没有则整本不分章（不参与门控）。
- `scripts/fetch-materials.ts` 读 `课程/<简称>/下载.json` 批量下载（不抓网页、不处理登录）。
- **首次设置**：`POST /api/timetable/parse` 把课表图片/文字转课程行，
  `POST /api/timetable/match` 让模型判断「课表课程名 ↔ 课程代码」，
  `POST /api/timetable/apply` 写日程 + 登记科目 + 建空库（`src/course/apply.ts`）。
  模型只做对应判断，代码校验代码格式与重复，写库全部在 service。

分科目的表：`chapter_progress`、`progress`、`mistake`、`habit`（`NULL`=通识）、`goal`（`NULL`=跨科目）、`conversation`、`exercise_set`、`roadmap_item`（M2 起）。

全局的表（设计如此，不要硬加科目）：`term`、`term_event`、`teaching_day`、`time_preference`、`capacity_rule`、`class_slot`、`schedule`（课表是"我的时间"）、`profile`、`event`（payload 里带 course）。

**跨科目能力（地基 + 范围判断已就位，路径生成待做）**：

- `mergeCourseHits(lists, k)` / `retrieveMany(sources, query)`：多库联合检索。门控按科目各用各的 `LearnedFilter`，合并用 RRF，去重键是 `file#chunkId`（`chunkId` 只在单库内唯一）。
- `loadProfiles(db, codes)` / `profilePromptMulti(profiles)`：多科目画像，每科单独一段，末尾给出"不得把一个科目的进度套到另一个科目"的约束。
- `planCourseScope(db, {intent, course, courseCodes})`：**要不要调用多科目知识库的唯一判断点**。
  `ask/review/extract` 强制单科目（多传的科目告警忽略）；`plan/roadmap/exercise` 允许多科目，
  但只打开知识库已就绪的库，每科各自门控。`scopeSources(scope)` 直接就是 `retrieveMany` 的入参。
  入口：`POST /api/roadmap/scope`（只判断，不生成路径）。
- **AI 辅助科目 + 科目分流**：候选科目来自**课程表**，用户逐门勾选（`subject.ai_enabled`，
  默认 0 = 未授权）。`buildRoutingContext()` 把"当前科目 + 已勾选科目"注入提示词，
  `ask/review` 让模型给 `subject_guess`，再由 `matchSubjectGuess()` 做白名单校验；
  判成别的科目时 `mismatch=true`，改错默认存到该科，问教材页给一键切换提示。
  模型只能从勾选集合里选，**不能自己扩大范围**，也不能直接写 `course_code`。
  入口：`GET/PUT /api/subjects/ai`。
- `roadmap.course_codes`（JSON 数组）+ `roadmap_item.course_code`：一条路径可跨科目，每条 item 必须写清所属科目。

**新增索引若依赖新列，不要写进 `schema.sql`**：老库会先执行整份 schema 再补列，`CREATE INDEX` 会因缺列直接失败。一律加到 `src/db/migrate.ts` 的 `POST_MIGRATION_INDEXES`。

## 五、测试约定

| 套件 | 数据库 | 覆盖 |
|---|---|---|
| `npm run test:schedule` | `data/test-schedule.db`（合成） | 单双周、调课、跨午夜、意愿块、偏好、容量、日程增删改、排期上限与保存 |
| `npm run test:calendar` | `data/learner.db`（真实校历） | 调休、节假日、停课、截图课表一致性 |
| `npm run test:m2` | `data/learner.db` | 章节进度、画像注入、越界判定（含真实模型） |
| `npm run test:habit` | `data/learner.db` | 习惯抽取、证据阈值、重算幂等 |
| `npm run test:persist` | `data/test-persist-<pid>.db` | 落库与恢复、事务边界 |
| `npm run test:multi` | `data/test-multi.db` | 多科目隔离、跨库合并（RRF）、roadmap 科目列 |
| `npm run test:subjects` | `data/test-subjects-<pid>.db` | 科目注册/重名/非法代码、教材库自动登记、每科进度与错题统计、错题分组、路径范围判断 |

**需要不同数据库的套件必须各用各的**，否则互相污染。新增套件请沿用此约定。

有顺序依赖的测试请写在同一个 `scripts/` 文件里，不要跨文件依赖。

## 六、已知技术债

| 项 | 影响 | 建议 |
|---|---|---|
| 跨午夜睡眠用 7 条重复行表达 | 改一次要改 7 条 | 加 `every_day` 字段 |
| 只有单日调课，无整周调休表 | 校历已覆盖，但临时调休要手工加 | 已由 `teaching_day` 覆盖 |
| 课表截图仍靠人工转写 | 真实用户第一步体验差 | 接视觉模型 |
| 教师端聚合未实现 | M3 未开始 | — |
| 无 API 契约文档 | 前后端不能并行 | 建 `web/` 前先定 OpenAPI |

## 七、并行开发切分建议

三个互不阻塞的轨道：

1. **检索轨道**：`src/rag/`（FTS5 + 向量混合检索）—— 只依赖 `textbook.db`
2. **模型轨道**：`src/llm/` 的 prompt 组装、结构化抽取 —— 只依赖 `src/llm/models.ts`
3. **前端轨道**：`web/` —— 只依赖 `/api` 契约

三者汇合点是 `src/server.ts` 的路由层。**先定路由契约，再并行。**
