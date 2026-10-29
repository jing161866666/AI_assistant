import "dotenv/config";
import assert from "node:assert/strict";

/**
 * 多科目框架自测（不起服务、不调模型）。
 *
 * 覆盖：
 *   1) 科目注册表（加科目 / 重名 / 非法代码 / 停用 / 重新启用）
 *   2) 教材库自动登记成科目（老用户升级后不用手工加 PHY2）
 *   3) 每个科目的进度、错题、习惯互不串味
 *   4) 错题按科目归类（含未归类），分组总数与总数一致
 *   5) 学习路径的科目范围判断：单科目 vs 多科目，以及知识库未就绪的科目
 */

// 每次运行一个独立库（沿用 test-persist 的约定），避免上一次运行的残留影响断言
process.env.DB_PATH = `./data/test-subjects-${process.pid}.db`;

const { getLearnerDb } = await import("../src/db/index.js");
const { advanceTo, clearChapterProgress, listChapterProgress } = await import(
  "../src/memory/chapter-progress.js"
);
const { mistakeGroups, listMistakes, mistakeStats, saveMistake } = await import(
  "../src/memory/mistakes.js"
);
const {
  addSubject,
  aiCandidates,
  aiSubjectCodes,
  archiveSubject,
  getSubject,
  isAiSubject,
  listSubjects,
  normalizeCourseCode,
  setAiSubjects,
  syncSubjectsFromTextbooks,
  timetableCourses,
  updateSubject,
} = await import("../src/memory/subjects.js");
const { planCourseScope, scopeSources } = await import("../src/rag/course-scope.js");
const { applyChapterNames } = await import("../src/rag/chapter-outline.js");
const { clearChapterName, listChapterNames, normalizeChapterTitle, setChapterName } = await import(
  "../src/memory/chapter-name.js"
);
const { buildRoutingContext, matchSubjectGuess, resolveRoute } = await import(
  "../src/rag/subject-router.js"
);

const db = getLearnerDb();
const PHY = "PHY2";
const DS = "DS";

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${(e as Error).message.split("\n")[0]}`);
  }
}
function throws(name: string, fn: () => unknown, re: RegExp): void {
  check(name, () => {
    assert.throws(fn, re);
  });
}

const cols = (table: string): string[] =>
  (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((r) => r.name);

console.log("\n【1】表结构：科目注册表的列（新库 + 老库迁移都走同一条路径）");
check("subject 有 learner_file / note / updated_at", () => {
  for (const c of ["learner_file", "note", "updated_at"]) {
    assert.ok(cols("subject").includes(c), `subject 缺列 ${c}：${cols("subject").join(",")}`);
  }
});
check("mistake 有 course_code", () => {
  assert.ok(cols("mistake").includes("course_code"));
});

console.log("\n【2】教材库自动登记成科目（老用户升级不用手工加）");
const synced = syncSubjectsFromTextbooks(db);
check("同步后 PHY2 已登记且知识库就绪", () => {
  assert.ok(synced.added.includes(PHY) || listSubjects(db).some((s) => s.code === PHY));
  const phy = getSubject(db, PHY)!;
  assert.ok(phy, "PHY2 未登记");
  assert.equal(phy.textbook_ready, true);
  assert.equal(phy.textbook_file, "course-phy2.db");
  assert.ok(phy.chapters > 0, `章节数为 ${phy.chapters}`);
});
check("重复同步不产生重复科目", () => {
  const before = listSubjects(db).length;
  syncSubjectsFromTextbooks(db);
  assert.equal(listSubjects(db).length, before);
});

console.log("\n【3】增加科目的框架");
const ds = addSubject(db, { code: "ds", name: "数据结构", note: "先验知识待补" });
check("代码统一大写、可只给名称、知识库未就绪", () => {
  assert.equal(ds.code, DS);
  assert.equal(ds.name, "数据结构");
  assert.equal(ds.textbook_ready, false);
  assert.equal(ds.textbook_file, null);
  assert.equal(ds.note, "先验知识待补");
});
check("新科目出现在科目清单且进度为 0", () => {
  const list = listSubjects(db);
  const found = list.find((s) => s.code === DS)!;
  assert.ok(found);
  assert.equal(found.progress.learnedCount, 0);
  assert.equal(found.progress.maxChapterNo, null);
  assert.equal(found.mistakes.total, 0);
  assert.equal(found.habits, 0);
});
throws("重名科目被拒绝", () => addSubject(db, { code: DS, name: "重复" }), /已存在/);
throws("非法科目代码被拒绝（数字开头 / 太短）", () => addSubject(db, { code: "1ABC" }), /科目代码/);
throws("非法科目代码被拒绝（单个字符）", () => normalizeCourseCode("A"), /科目代码/);
throws(
  "绑定不存在的教材库被拒绝",
  () => addSubject(db, { code: "MATH", textbookFile: "course-not-exist.db" }),
  /不存在/,
);
check("不传名称时用代码兜底", () => {
  const s = addSubject(db, { code: "MATH" });
  assert.equal(s.name, "MATH");
  assert.equal(s.textbook_ready, false);
  archiveSubject(db, "MATH");
});

console.log("\n【4】进度 / 错题 / 习惯按科目隔离");
advanceTo(db, PHY, 2);
advanceTo(db, DS, 1);
const phyMistake = saveMistake(db, {
  title: "物理-受力分析",
  course_code: PHY,
  error_type: "concept",
});
const dsMistake = saveMistake(db, {
  title: "数据结构-链表反转",
  course_code: DS,
  error_type: "logic",
});
const legacy = saveMistake(db, { title: "旧数据-没有科目" });
db.prepare(
  `INSERT INTO habit (dimension, key, value, course_code, confidence, evidence_count)
   VALUES ('attention','专注时长','40 分钟',?,0.8,3)`,
).run(PHY);
db.prepare(
  `INSERT INTO habit (dimension, key, value, course_code, confidence, evidence_count)
   VALUES ('attention','专注时长','20 分钟',?,0.8,3)`,
).run(DS);

check("两科进度互不串味", () => {
  const phy = getSubject(db, PHY)!;
  const data = getSubject(db, DS)!;
  assert.equal(phy.progress.maxChapterNo, 2);
  assert.equal(data.progress.maxChapterNo, 1);
  assert.equal(phy.progress.learnedCount, 2);
  assert.equal(data.progress.learnedCount, 1);
  assert.deepEqual(phy.progress.gaps, []);
});
check("两科错题数各算各的", () => {
  assert.equal(getSubject(db, PHY)!.mistakes.total, 1);
  assert.equal(getSubject(db, DS)!.mistakes.total, 1);
  // 未归类不算进任何科目
  assert.equal(getSubject(db, PHY)!.mistakes.total + getSubject(db, DS)!.mistakes.total, 2);
});
check("两科习惯各算各的", () => {
  assert.equal(getSubject(db, PHY)!.habits, 1);
  assert.equal(getSubject(db, DS)!.habits, 1);
});

console.log("\n【5】错题本按科目归类（含未归类，总数对得上）");
check("分组数与总数一致", () => {
  const names = new Map([
    [PHY, "大学物理(B)II"],
    [DS, "数据结构"],
  ]);
  const groups = mistakeGroups(db, (c) => (c == null ? "未归类" : (names.get(c) ?? c)));
  assert.equal(groups.length, 3);
  assert.equal(
    groups.reduce((n, g) => n + g.stats.total, 0),
    3,
  );
  const phy = groups.find((g) => g.course_code === PHY)!;
  assert.equal(phy.course_name, "大学物理(B)II");
  assert.equal(phy.mistakes.length, 1);
  assert.equal(phy.mistakes[0]!.id, phyMistake);
  const legacyGroup = groups.find((g) => g.course_code == null)!;
  assert.equal(legacyGroup.course_name, "未归类");
  assert.equal(legacyGroup.mistakes[0]!.id, legacy);
});
check("按错因过滤后分组仍然对得上", () => {
  const groups = mistakeGroups(db, (c) => (c == null ? "未归类" : c), { errorType: "logic" });
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.course_code, DS);
  assert.equal(groups[0]!.mistakes[0]!.id, dsMistake);
});

console.log("\n【6】学习路径的科目范围判断（要不要调用多科目知识库）");
check("问教材只调用当前科目（多传的科目被忽略并告警）", () => {
  const scope = planCourseScope(db, {
    intent: "ask",
    course: PHY,
    courseCodes: [PHY, DS],
  });
  assert.equal(scope.multiSubject, false);
  assert.deepEqual(
    scope.sources.map((s) => s.code),
    [PHY],
  );
  assert.ok(scope.warnings.some((w) => w.includes("只调用当前科目")));
});
check("改错同样只调用该科目知识库", () => {
  const scope = planCourseScope(db, { intent: "review", course: PHY, courseCodes: [DS] });
  assert.deepEqual(
    scope.sources.map((s) => s.code),
    [PHY],
  );
  assert.equal(scope.multiSubject, false);
  assert.ok(scope.warnings.some((w) => w.includes("只调用当前科目")));
});
check("学习路径跨科目：只打开就绪的库，未建库的科目给出原因", () => {
  const scope = planCourseScope(db, { intent: "roadmap", course: PHY, courseCodes: [PHY, DS] });
  assert.equal(scope.multiSubject, false, "DS 没有知识库，不应算进 sources");
  assert.deepEqual(
    scope.sources.map((s) => s.code),
    [PHY],
  );
  const dsState = scope.subjects.find((s) => s.code === DS)!;
  assert.equal(dsState.status, "no-textbook");
  assert.ok(scope.warnings.some((w) => w.includes("还没有知识库")));
  assert.match(scope.reason, /只涉及 1 门科目/);
});
check("学习路径只有一门未建库科目时被拦截", () => {
  const scope = planCourseScope(db, { intent: "roadmap", course: DS });
  assert.equal(scope.blocked, true);
  assert.equal(scope.sources.length, 0);
  assert.match(scope.reason, /无法调用教材/);
});
check("未登记科目出现在 warnings 里，而不是静默当成存在", () => {
  const scope = planCourseScope(db, { intent: "roadmap", course: PHY, courseCodes: ["ZZZ"] });
  assert.equal(scope.subjects.find((s) => s.code === "ZZZ")!.status, "unregistered");
  assert.ok(scope.warnings.some((w) => w.includes("尚未登记")));
});
check("非法科目代码只告警，不让整个请求失败", () => {
  const scope = planCourseScope(db, { intent: "exercise", course: PHY, courseCodes: ["1BAD"] });
  assert.equal(scope.sources.length, 1);
  assert.ok(scope.warnings.some((w) => w.includes("非法科目代码")));
});
check("两门就绪科目才判为跨科目，且各用各的门控", () => {
  // 复用同一个真实教材库当第二门课：验证的是"多库分支"，不是造知识
  addSubject(db, { code: "PHYX", name: "物理-第二册", textbookFile: "course-phy2.db" });
  const scope = planCourseScope(db, {
    intent: "roadmap",
    course: PHY,
    courseCodes: [PHY, "PHYX"],
  });
  assert.equal(scope.multiSubject, true);
  assert.equal(scope.sources.length, 2);
  const sources = scopeSources(db, scope);
  assert.equal(sources.length, 2);
  // PHY2 已学 2 章；PHYX 没设进度 → filter 为 null。两科门控必须各算各的
  assert.equal(sources[0]!.filter?.size, 2);
  assert.equal(sources[1]!.filter, null);
  archiveSubject(db, "PHYX");
});

check("检索入参按科目各用各的门控（物理已学 2 章 → filter=2）", () => {
  const scope = planCourseScope(db, { intent: "roadmap", course: PHY });
  const sources = scopeSources(db, scope);
  assert.equal(sources.length, 1);
  assert.equal(sources[0]!.filter?.size, 2);
  assert.ok(sources[0]!.filter?.has(1) && sources[0]!.filter?.has(2));
});
check("没设进度的科目 filter 为 null（不拦，但画像会提醒设进度）", () => {
  addSubject(db, { code: "ALG" });
  const scope = planCourseScope(db, { intent: "roadmap", course: "ALG" });
  // ALG 没有知识库 → blocked，sources 为空；这里用 scopeSources 的语义直接验证
  assert.equal(scope.blocked, true);
  const sources = scopeSources(db, scope);
  assert.deepEqual(sources, []);
});

console.log("\n【7】停用科目：软删除，记忆保留，可重新启用");
check("停用后不出现在默认清单，但 includeArchived 能看到", () => {
  archiveSubject(db, PHY);
  assert.ok(!listSubjects(db).some((s) => s.code === PHY));
  const all = listSubjects(db, { includeArchived: true });
  const phy = all.find((s) => s.code === PHY)!;
  assert.equal(phy.active, false);
  // 记忆没被删
  assert.equal(phy.progress.maxChapterNo, 2);
  assert.equal(phy.mistakes.total, 1);
});
check("重新添加 = 重新启用，进度/错题原样回来", () => {
  const again = addSubject(db, { code: PHY, name: "大学物理(B)II" });
  assert.equal(again.active, true);
  assert.equal(again.progress.maxChapterNo, 2);
  assert.equal(again.mistakes.total, 1);
});
check("改科目名不影响 course_code 与记忆", () => {
  const renamed = updateSubject(db, DS, { name: "数据结构（C++ 描述）" });
  assert.equal(renamed.code, DS);
  assert.equal(renamed.name, "数据结构（C++ 描述）");
  assert.equal(renamed.progress.maxChapterNo, 1);
});

console.log("\n【8】AI 辅助科目：候选来自课程表，qwen 只在勾选集合里选");
// 课程表：导入课表是候选科目的来源。NODB = 还没有教材库的新课。
const NODB = "NODB";
const insSchedule = db.prepare(
  `INSERT INTO schedule (title, type, category, course_code, weekday, start_time, end_time, recurring)
   VALUES (?, 'course', 'academic', ?, ?, '08:00', '09:40', 1)`,
);
insSchedule.run("大学物理(B)II", PHY, 1);
insSchedule.run("大学物理(B)II", PHY, 4);
insSchedule.run("概率统计与随机过程", "PROB", 2);
insSchedule.run("新课没有教材库", NODB, 3);
insSchedule.run("没有课程代码的课", null, 4);

check("课程表里的课成为候选，按课程代码合并、记录周课时", () => {
  const rows = timetableCourses(db);
  const phy = rows.find((r) => r.code === PHY)!;
  assert.ok(phy, "PHY2 没出现在候选里");
  assert.equal(phy.periods, 2);
  assert.equal(phy.registered, true);
  const nodb = rows.find((r) => r.code === NODB)!;
  assert.ok(nodb, "NODB 没出现在候选里");
  assert.equal(nodb.registered, false);
  assert.equal(nodb.textbook_ready, false);
  // 没有课程代码的课不能当记忆锚点，不参与候选
  assert.equal(rows.length, 3);
});

check("勾选会自动登记课程表里的科目（不建库）", () => {
  const rows = setAiSubjects(db, [PHY, "PROB", NODB]);
  const nodb = rows.find((r) => r.code === NODB)!;
  assert.equal(nodb.registered, true);
  assert.equal(nodb.ai_enabled, true);
  assert.equal(nodb.textbook_ready, false, "新课不该凭空有知识库");
  const sub = getSubject(db, NODB)!;
  assert.equal(sub.name, "新课没有教材库", "名称应取自课程表");
});

check("候选集合只含勾选的科目", () => {
  const codes = aiCandidates(db)
    .map((c) => c.code)
    .sort();
  assert.deepEqual(codes, [PHY, "PROB", NODB].sort());
  // 没勾的 DS 不能进候选
  assert.ok(!codes.includes(DS));
});

throws("课程表里没有的科目不能勾选", () => setAiSubjects(db, ["NOTINCLASS"]), /不在课程表里/);

check("路由提示词只列勾选科目，并明确禁止默认当前科目", () => {
  const routing = buildRoutingContext(db, { code: PHY, name: "大学物理(B)II" });
  assert.match(routing.text, /当前科目：PHY2 大学物理\(B\)II/);
  assert.match(routing.text, /PROB/);
  assert.match(routing.text, new RegExp(NODB));
  assert.doesNotMatch(routing.text, /DS 数据结构/);
  assert.match(routing.text, /不要因为「当前科目」是它/);
  assert.equal(routing.candidates.length, 3);
});

check("subject_guess 白名单校验：代码/名称/带代码的文本都认", () => {
  const candidates = aiCandidates(db);
  const probName = candidates.find((c) => c.code === "PROB")!.name;
  const phyName = candidates.find((c) => c.code === PHY)!.name;
  assert.equal(matchSubjectGuess("PROB", candidates)?.code, "PROB");
  assert.equal(matchSubjectGuess("prob", candidates)?.code, "PROB");
  assert.equal(matchSubjectGuess(probName, candidates)?.code, "PROB");
  // 句子里包含完整课名（课名要够长，太短的缩写不做包含匹配）
  assert.equal(matchSubjectGuess(`这题是${phyName}的题`, candidates)?.code, PHY);
  assert.equal(matchSubjectGuess("物理 PHY2", candidates)?.code, PHY);
});

check("unsure / 未勾选科目 / 自造代码一律不认", () => {
  const candidates = aiCandidates(db);
  for (const bad of ["", "unsure", "unknown", "DS", "不存在的课"]) {
    assert.equal(matchSubjectGuess(bad, candidates), null, `不该认 ${bad}`);
  }
});

check("分流结论：判成别的科目时 mismatch=true，保存默认归到那科", () => {
  const candidates = aiCandidates(db);
  const route = resolveRoute(candidates, { code: PHY, name: "大学物理(B)II" }, "PROB");
  assert.equal(route.code, "PROB");
  assert.equal(route.name, candidates.find((c) => c.code === "PROB")!.name);
  assert.equal(route.mismatch, true);
  assert.match(route.reason, /不是当前科目/);
});

check("判成当前科目时 mismatch=false", () => {
  const route = resolveRoute(aiCandidates(db), { code: PHY, name: "大学物理(B)II" }, "PHY2");
  assert.equal(route.mismatch, false);
  assert.equal(route.code, PHY);
});

check("模型说 unsure 时落未归类，不硬塞当前科目", () => {
  const route = resolveRoute(aiCandidates(db), { code: PHY, name: "大学物理(B)II" }, "unsure");
  assert.equal(route.code, null);
  assert.equal(route.mismatch, false);
  assert.match(route.reason, /未归类/);
});

check("全部取消勾选后候选为空，路由不再猜", () => {
  setAiSubjects(db, []);
  assert.deepEqual(aiCandidates(db), []);
  const routing = buildRoutingContext(db, { code: PHY, name: "大学物理(B)II" });
  assert.match(routing.text, /还没有勾选任何允许 AI 辅助的科目/);
});

console.log("\n【9】进度与错题本只对勾选 AI 辅助的科目开放");
setAiSubjects(db, [PHY, "PROB"]);

check("isAiSubject 只认启用且勾选 AI 的科目", () => {
  assert.equal(isAiSubject(db, PHY), true);
  assert.equal(isAiSubject(db, "PROB"), true);
  // DS 登记过、有错题，但没勾选 → 不许读写
  assert.equal(isAiSubject(db, DS), false);
  // 未登记科目一律 false，不靠默认值
  assert.equal(isAiSubject(db, "NOPE"), false);
});

check("aiSubjectCodes 与勾选集合一致，按代码排序", () => {
  assert.deepEqual(aiSubjectCodes(db), [PHY, "PROB"].sort());
});

check("错题列表只返回勾选科目；未归类可选保留", () => {
  const onlyAi = listMistakes(db, { courseCodes: aiSubjectCodes(db) });
  assert.equal(onlyAi.length, 1, "DS 的错题不该出现在勾选科目的列表里");
  assert.equal(onlyAi[0]!.course_code, PHY);

  const withLegacy = listMistakes(db, {
    courseCodes: aiSubjectCodes(db),
    includeUnassigned: true,
  });
  assert.equal(withLegacy.length, 2, "未归类的旧错题应随 includeUnassigned 保留");
  assert.ok(withLegacy.some((m) => m.course_code == null));
});

check("错题统计与列表同口径（只算勾选科目）", () => {
  const stats = mistakeStats(db, undefined, {
    courseCodes: aiSubjectCodes(db),
    includeUnassigned: true,
  });
  assert.equal(stats.total, 2);
  assert.equal(stats.unresolved, 2);
});

check("全部科目分组也不含未勾选的科目，未归类仍在", () => {
  const groups = mistakeGroups(db, (c) => (c == null ? "未归类" : c), {
    courseCodes: aiSubjectCodes(db),
  });
  assert.deepEqual(groups.map((g) => g.course_code).sort(), [null, PHY].sort());
  assert.ok(!groups.some((g) => g.course_code === DS));
});

check("重新取消勾选后，集合立即收缩（实时生效）", () => {
  setAiSubjects(db, [PHY]);
  assert.deepEqual(aiSubjectCodes(db), [PHY]);
  assert.equal(isAiSubject(db, "PROB"), false);
  assert.equal(listMistakes(db, { courseCodes: aiSubjectCodes(db) }).length, 1);
});

console.log("\n【10】章节改名：写 learner 库、按科目隔离、可恢复原名");
check("去掉「第N章」前缀，只存章名", () => {
  assert.equal(normalizeChapterTitle("第9章 静电场与电势"), "静电场与电势");
  assert.equal(normalizeChapterTitle("  第九章：恒定磁场  "), "恒定磁场");
  assert.equal(normalizeChapterTitle("静电场"), "静电场");
  assert.equal(normalizeChapterTitle("   "), "");
});

check("改名落库并按科目隔离", () => {
  setChapterName(db, PHY, 9, "第9章 静电场与电势");
  assert.equal(listChapterNames(db, PHY).get(9), "静电场与电势");
  assert.equal(listChapterNames(db, DS).size, 0, "别的科目不该看到这次改名");
});

check("改名进 event，能追到改之前叫什么", () => {
  const row = db
    .prepare("SELECT payload FROM event WHERE type='chapter_renamed' ORDER BY id DESC LIMIT 1")
    .get() as { payload: string } | undefined;
  assert.ok(row);
  const p = JSON.parse(row!.payload) as { course: string; chapterNo: number; title: string };
  assert.equal(p.course, PHY);
  assert.equal(p.chapterNo, 9);
  assert.equal(p.title, "静电场与电势");
});

check("恢复原名会删掉覆盖，原教材名不受影响", () => {
  assert.equal(clearChapterName(db, PHY, 9), true);
  assert.equal(listChapterNames(db, PHY).has(9), false);
  // 再删一次是幂等的
  assert.equal(clearChapterName(db, PHY, 9), false);
});

throws("章名超过 60 字被拒", () => setChapterName(db, PHY, 9, "啊".repeat(61)), /60/);
throws("章号越界被拒", () => setChapterName(db, PHY, 41, "不存在的章"), /1-40/);

check("合并时只替换匹配章号，原名与章号不变", () => {
  const items = [
    { chapterNo: 9, title: "静电场", libraryTitle: "静电场", edited: false, sample: "" },
    { chapterNo: 10, title: "恒定磁场", libraryTitle: "恒定磁场", edited: false, sample: "" },
  ];
  const merged = applyChapterNames(items, new Map([[9, "电场与电势"]]));
  assert.equal(merged[0]!.title, "电场与电势");
  assert.equal(merged[0]!.libraryTitle, "静电场");
  assert.equal(merged[0]!.edited, true);
  assert.equal(merged[1]!.title, "恒定磁场");
  assert.equal(merged[1]!.edited, false);
});

console.log("\n【11】清空进度：整行删除，不凭空留下空章节");
check("清空后 chapter_progress 为空，且只记一条 event", () => {
  advanceTo(db, PHY, 3);
  assert.equal(listChapterProgress(db, PHY).length, 3);
  const removed = clearChapterProgress(db, PHY);
  assert.equal(removed, 3);
  assert.equal(listChapterProgress(db, PHY).length, 0, "清空后不该留下任何章节行");
  const n = Number(
    (
      db.prepare("SELECT COUNT(*) AS c FROM event WHERE type='progress_cleared'").get() as {
        c: number;
      }
    ).c,
  );
  assert.equal(n, 1);
});

db.close();
console.log(`\n${"─".repeat(56)}\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
