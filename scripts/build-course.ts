import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chunkText, splitChapters } from "../src/course/chapter-split.js";
import {
  type CourseMaterials,
  KIND_LABEL,
  listCourseFolders,
  readMaterialText,
  scanCourseMaterials,
} from "../src/course/corpus.js";
import { embeddingClient } from "../src/llm/client.js";
import { getEmbedConfig } from "../src/llm/models.js";

/**
 * 按「课程/<简称>/」文件夹建一个只读教材库。
 *
 * 与 build:textbook 的区别：
 *   - build:textbook 是物理课的历史脚本（课件按文件名取章号 + docx 题库），保留不动；
 *   - 本脚本是通用版：章号从正文小节号 §N.M 恢复，章名取目录行。
 *
 * 用法：
 *   npx tsx scripts/build-course.ts --course 概率论 --code PROB
 *   npx tsx scripts/build-course.ts --course 概率论 --code PROB --dry-run
 *   npx tsx scripts/build-course.ts --course 概率论 --code PROB --empty
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

const FOLDER = arg("course") ?? arg("folder");
const CODE = (arg("code") ?? "").toUpperCase();
const NAME = arg("name");
const EMPTY = hasFlag("empty");

interface Chunk {
  textbook: string;
  chapterNo: number | null;
  chapterTitle: string;
  seq: number;
  text: string;
}

async function embedAll(texts: string[]): Promise<number[][]> {
  const cfg = getEmbedConfig();
  const client = embeddingClient();
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += cfg.batchSize) {
    const batch = texts.slice(i, i + cfg.batchSize);
    let attempt = 0;
    for (;;) {
      try {
        const r = await client.embeddings.create({ model: cfg.model, input: batch });
        out.push(
          ...r.data
            .slice()
            .sort((a, b) => a.index - b.index)
            .map((d) => d.embedding as number[]),
        );
        break;
      } catch (e) {
        attempt++;
        if (attempt >= 4) throw e;
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    if (i === 0 || out.length % 100 < cfg.batchSize) {
      console.log(`    向量化 ${Math.min(i + cfg.batchSize, texts.length)}/${texts.length}`);
    }
  }
  return out;
}

/** 教材正文优先；参考书/课件能抽字就当"无章号切片"（不参与进度门控） */
async function collectChunks(m: CourseMaterials): Promise<{ chunks: Chunk[]; skipped: string[] }> {
  const chunks: Chunk[] = [];
  const skipped: string[] = [];

  /**
   * 课件往往没有章标题，只有章号；但正文第一句几乎总是这节课的题目。
   * 这里只从**已有文字**里截取，不生成、不改写——查不到就退回占位名。
   */
  const guessChapterName = (text: string): string => {
    const NOISE = /(Email|@|大学|学院|教授|讲师|作业|考试|复习|目录|课程简介)/i;
    const clean = text
      .split(/\n+/)
      .map((s) => s.replace(/\s+/g, " ").trim())
      .map((s) => s.replace(/^第\s*\d+\s*章[\s:：、.-]*/, ""))
      .filter(
        (s) => s.length >= 3 && s.length <= 40 && !NOISE.test(s) && !/^[\d\s.、()-]+$/.test(s),
      );
    const line = clean[0];
    return (line ?? "（课件）").slice(0, 24);
  };

  // 按路径排序 = 按册顺序（大物上 在 大物下 之前），章号连续编号：
  // 下一册从"上一册最后一章 + 1"接着排，进度/门控才能在两个学期里连成一条线。
  // 没有教材的课（如人智导论）用课件当章节来源，否则整门课没有章节、无法做进度门控
  let textbookFiles = m.files
    .filter((f) => f.kind === "textbook")
    .sort((a, b) => a.path.localeCompare(b.path));
  if (textbookFiles.length === 0) {
    textbookFiles = m.files
      .filter((f) => f.kind === "slides")
      .sort((a, b) => a.path.localeCompare(b.path));
    if (textbookFiles.length > 0) console.log("  没有教材：改用课件作为章节来源");
  }
  if (textbookFiles.length === 0) skipped.push("教材/ 里没有可抽字的文件（docx/pdf/md/txt）");
  let prevMaxChapter = 0;

  const seenRealChapters = new Set<number>();
  for (const f of textbookFiles) {
    let text: string;
    try {
      text = await readMaterialText(f);
    } catch (e) {
      skipped.push(`${f.name} 读取失败：${(e as Error).message}`);
      console.log(`  ⚠ ${f.name}: 读取失败，已跳过（${(e as Error).message}）`);
      continue;
    }
    const chapters = splitChapters(text);
    if (chapters.length > 0) {
      /** 用书本身的章号，不偏移：上册 1-8、下册 9-16 本来就连续 */
      const mapNo = (no: number): number => no;
      let seq = 0;
      for (const ch of chapters) {
        const placeholder = /^第\\s*\\d+\\s*章$/.test(ch.title.trim());
        if (placeholder && seenRealChapters.has(ch.no)) {
          console.log(`    ${f.name}: 第${ch.no}章 是重复占位章，跳过`);
          continue;
        }
        if (!placeholder) seenRealChapters.add(ch.no);
        for (const piece of chunkText(ch.text)) {
          chunks.push({
            textbook: basename(f.name, f.ext),
            chapterNo: mapNo(ch.no),
            chapterTitle: ch.title,
            seq: seq++,
            text: piece,
          });
        }
      }
      prevMaxChapter = Math.max(prevMaxChapter, ...chapters.map((c) => c.no));
      console.log(`  ${f.name}: 识别 ${chapters.length} 章 → ${seq} 片`);
      console.log(`    ${chapters.map((c) => `第${c.no}章 ${c.title}`).join(" | ")}`);
    } else {
      // 课件常把章号写在文件名里（人工智能-第04章-启发式搜索-...），正文没有标题
      const fromName = /第\s*(\d{1,2})\s*章[\s\-—_]*(.*)$/.exec(basename(f.name, f.ext));
      const chapterNo = fromName ? Number(fromName[1]) : null;
      const chapterTitle = fromName
        ? `第${fromName[1]}章 ${(fromName[2] ?? "").replace(/[._-]+$/, "").trim() || guessChapterName(text)}`
        : "未分章";
      let seq = 0;
      for (const piece of chunkText(text)) {
        chunks.push({
          textbook: basename(f.name, f.ext),
          chapterNo,
          chapterTitle,
          seq: seq++,
          text: piece,
        });
      }
      console.log(
        `  ${f.name}: ${chapterNo ? `按文件名取第${chapterNo}章` : "未识别到章标题"} → ${seq} 片${chapterNo ? "" : "（不参与进度门控）"}`,
      );
    }
  }

  const usedAsTextbook = new Set(textbookFiles.map((f) => f.path));

  /**
   * 教材解析出 0 章（例：计组的 `计算机原理.md` 没有「第N章」标题）→ 改用课件当章节来源。
   * 章号优先从文件名取（人工智能-第04章-…），正文抽不到标题也不影响进度门控。
   */
  const hasChapter = chunks.some((c) => c.chapterNo != null);
  if (!hasChapter) {
    const slideFiles = m.files
      .filter((f) => f.kind === "slides" && !usedAsTextbook.has(f.path))
      .sort((a, b) => a.path.localeCompare(b.path));
    if (slideFiles.length > 0) console.log("  教材未识别到章节：改用课件作为章节来源");
    for (const f of slideFiles) {
      usedAsTextbook.add(f.path);
      let text: string;
      try {
        text = await readMaterialText(f);
      } catch (e) {
        skipped.push(`${f.name} 读取失败：${(e as Error).message}`);
        continue;
      }
      const fromName = /第\s*(\d{1,2})\s*章[\s\-—_]*(.*)$/.exec(basename(f.name, f.ext));
      const chapterNo = fromName ? Number(fromName[1]) : null;
      const chapterTitle = fromName
        ? `第${fromName[1]}章 ${(fromName[2] ?? "").replace(/[._-]+$/, "").trim() || guessChapterName(text)}`
        : "未分章";
      let seq = 0;
      for (const piece of chunkText(text)) {
        chunks.push({
          textbook: basename(f.name, f.ext),
          chapterNo,
          chapterTitle,
          seq: seq++,
          text: piece,
        });
      }
      console.log(
        `  课件/${f.name}: ${chapterNo ? `按文件名取第${chapterNo}章` : "无章号"} → ${seq} 片`,
      );
    }
  }
  const extras = m.files.filter(
    (f) => (f.kind === "reference" || f.kind === "slides") && !usedAsTextbook.has(f.path),
  );
  for (const f of extras) {
    let text: string;
    try {
      text = await readMaterialText(f);
    } catch (e) {
      // 坏文件（空的 docx / 损坏的 pptx）不能让整次建库失败
      skipped.push(`${f.name} 读取失败：${(e as Error).message}`);
      console.log(`  ⚠ ${f.name}: 读取失败，已跳过`);
      continue;
    }
    // 参考书常见命名 ch01.docx / ch2.pdf：能对上章号就跟着该章走，
    // 这样"学过第 3 章才看得到第 3 章解答"，不会把后面章的答案提前塞进上下文。
    const ch = /^ch\s*0*(\d{1,2})\b/i.exec(basename(f.name, f.ext));
    const chapterNo = f.kind === "reference" && ch ? Number(ch[1]) : null;
    let seq = 0;
    for (const piece of chunkText(text)) {
      chunks.push({
        textbook: `${KIND_LABEL[f.kind]}·${basename(f.name, f.ext)}`,
        chapterNo,
        chapterTitle: chapterNo ? `第${chapterNo}章 参考书` : KIND_LABEL[f.kind],
        seq: seq++,
        text: piece,
      });
    }
    console.log(
      `  ${KIND_LABEL[f.kind]}/${f.name}: ${seq} 片（${chapterNo ? `第${chapterNo}章，参与门控` : "不参与门控"}）`,
    );
  }

  return { chunks, skipped };
}

function buildEmpty(file: string): DatabaseSync {
  mkdirSync(resolve(file, ".."), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(readFileSync(resolve("db/schema/textbook.sql"), "utf8"));
  return db;
}

/**
 * 先写临时文件、成功后再替换正式库。
 * 否则建库中途失败（没网、PDF 坏了）会把旧库删掉——学生端直接没教材可用。
 */
function publish(work: string, out: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(out + suffix, { force: true });
  renameSync(work, out);
  for (const suffix of ["-wal", "-shm"]) rmSync(work + suffix, { force: true });
}

function now(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 课程文件夹 → 课表里的科目代码（以课表真实代码为准）。
 * 只有这里列出的文件夹才会被 `--all` 建库——
 * 课表里没有的文件夹（例如空的 工数/）不该建出一门"不存在的课"。
 */
const CODE_BY_FOLDER: Record<string, string> = {
  大学物理: "PHY", // 用户确认：简称用 PHY
  计组: "CO", // 课表：计算机组成原理
  数据结构: "DS",
  概率论: "PROB", // 课表：概率统计与随机过程
  人智导论: "AI", // 课表：人工智能导论
};

/** 课表里有、当前还没有资料文件夹的课程：用 --empty 建空库占位 */
const EMPTY_COURSES: Array<{ folder: string; code: string; name: string }> = [
  { folder: "Python编程", code: "PY", name: "Python编程" },
  { folder: "Python语言与数据科学", code: "PYDS", name: "Python语言与数据科学" },
  { folder: "大学物理实验", code: "PHYLAB2", name: "大学物理实验(理工)II" },
  { folder: "体育III", code: "PE3", name: "体育III" },
  { folder: "社会主义发展史", code: "SOC", name: "社会主义发展史" },
  { folder: "马克思主义基本原理", code: "MARX", name: "马克思主义基本原理" },
];

async function main(): Promise<void> {
  if (hasFlag("all")) {
    const existing = new Set(listCourseFolders());
    const failed: string[] = [];

    // 1) 只建「课表里有、且已放了资料」的课程：课表里没有的文件夹一律不建
    for (const [folder, code] of Object.entries(CODE_BY_FOLDER)) {
      if (!existing.has(folder)) {
        console.log(`- ${folder}(${code})：还没有资料文件夹，跳过`);
        continue;
      }
      try {
        // 每门课独立建库：一门失败不影响其它课程
        await buildOne(folder, code, undefined, { empty: false });
      } catch (e) {
        failed.push(`${folder}(${code})：${(e as Error).message}`);
        console.error(`✗ ${folder} 建库失败：${(e as Error).message}`);
      }
    }

    // 2) 课表里其余课程：用 --empty 建空库占位（没有资料也能测试匹配/排日程）
    if (hasFlag("empty")) {
      for (const c of EMPTY_COURSES) {
        if (existing.has(c.folder)) continue; // 有资料就走上面正常建库
        try {
          await buildOne(c.folder, c.code, c.name, { empty: true, allowMissingFolder: true });
        } catch (e) {
          failed.push(`${c.folder}(${c.code})：${(e as Error).message}`);
        }
      }
    } else {
      console.log(
        `\n课表里还有 ${EMPTY_COURSES.length} 门没有资料文件夹的课：加 --empty 可建空库占位`,
      );
      for (const c of EMPTY_COURSES) {
        if (!existing.has(c.folder)) console.log(`  - ${c.name}(${c.code})`);
      }
    }

    // 3) 课表无关的文件夹：明确跳过，不静默建出一门不存在的课
    for (const folder of existing) {
      if (!(folder in CODE_BY_FOLDER) && !EMPTY_COURSES.some((c) => c.folder === folder)) {
        console.log(`- ${folder}：不在课表里，跳过`);
      }
    }

    if (failed.length > 0) {
      console.log(`\n以下课程建库失败：`);
      for (const f of failed) console.log(`  - ${f}`);
      process.exitCode = 1;
    }
    return;
  }
  if (!FOLDER) {
    console.log(
      "用法: npx tsx scripts/build-course.ts --course <课程简称> --code <CODE> [--dry-run|--empty]",
    );
    console.log(
      "      npx tsx scripts/build-course.ts --all [--empty] [--dry-run]   # 只建课表里的课",
    );
    console.log(`可用课程文件夹: ${listCourseFolders().join("、") || "(空)"}`);
    process.exitCode = 1;
    return;
  }
  if (!/^[A-Z][A-Z0-9_-]{1,15}$/.test(CODE)) {
    throw new Error(`--code 不合法：${CODE || "(空)"}（2–16 位，字母开头，如 PROB）`);
  }
  await buildOne(FOLDER, CODE);
}

/** 建一个课程库（原 main 的主体，--all 也复用它） */
/** 文件夹还没建时，空库就用这份"没有资料"的壳 */
function emptyMaterials(folder: string): ReturnType<typeof scanCourseMaterials> {
  return {
    folder,
    dir: resolve("课程", folder),
    files: [],
    unsupported: [],
    has: { textbook: false, slides: false, reference: false, bank: false },
  };
}

async function buildOne(
  FOLDER: string,
  CODE: string,
  DISPLAY_NAME?: string,
  opts: { empty?: boolean; allowMissingFolder?: boolean } = {},
): Promise<void> {
  const exists = existsSync(resolve("课程", FOLDER));
  if (!exists && !opts.allowMissingFolder) throw new Error(`课程文件夹不存在：${FOLDER}`);
  const materials = exists ? scanCourseMaterials(FOLDER) : emptyMaterials(FOLDER);
  const displayName = DISPLAY_NAME ?? NAME ?? FOLDER;
  const outFile = resolve(`data/textbook/course-${CODE.toLowerCase()}.db`);
  const workFile = `${outFile}.building`;

  if (materials.unsupported.length > 0) {
    console.log("⚠ 这些文件是旧格式，未入库（先转成 .docx/.pptx，或装 LibreOffice 后转换）：");
    for (const f of materials.unsupported) {
      console.log(
        `   - ${KIND_LABEL[f.kind]}/${f.name}（${(f.bytes / 1024 / 1024).toFixed(1)} MB）`,
      );
    }
  }

  const db = buildEmpty(workFile);
  if (hasFlag("dry-run")) {
    const { chunks, skipped } = await collectChunks(materials);
    db.close();
    for (const s of skipped) console.log(`⚠ ${s}`);
    console.log(`(dry-run) 将入库 ${chunks.length} 片，未调用 embedding、未写文件。`);
    rmSync(workFile, { force: true });
    return;
  }

  db.prepare("INSERT INTO course (code, name, school, term, description) VALUES (?,?,?,?,?)").run(
    CODE,
    displayName,
    "东南大学",
    "",
    `由 课程/${FOLDER}/ 建立`,
  );
  const meta = db.prepare("INSERT INTO meta (key, value) VALUES (?,?)");
  meta.run("version", now());
  meta.run("course_code", CODE);
  meta.run("builder", "scripts/build-course.ts");
  meta.run("source_folder", FOLDER);

  if (opts.empty ?? EMPTY) {
    meta.run("chunk_count", "0");
    db.close();
    publish(workFile, outFile);
    console.log(`✓ 已建空库 ${outFile}`);
    return;
  }

  const { chunks, skipped } = await collectChunks(materials);
  for (const s of skipped) console.log(`⚠ ${s}`);
  if (chunks.length === 0) {
    meta.run("chunk_count", "0");
    db.close();
    publish(workFile, outFile);
    console.log("⚠ 没有任何可入库的正文，只建了空库。");
    return;
  }

  console.log(`\n合计 ${chunks.length} 片，开始向量化…`);
  const vectors = await embedAll(chunks.map((c) => c.text));
  const dim = getEmbedConfig().dim;

  const tbId = Number(
    db
      .prepare("INSERT INTO textbook (course_code, title, source_file) VALUES (?,?,?)")
      .run(CODE, `${displayName}（课程资料）`, `课程/${FOLDER}`).lastInsertRowid,
  );
  const chapterIds = new Map<number, number>();
  for (const c of chunks) {
    if (c.chapterNo == null || chapterIds.has(c.chapterNo)) continue;
    const r = db
      .prepare(
        "INSERT INTO chapter (textbook_id, level, seq, title, chapter_no) VALUES (?,?,?,?,?)",
      )
      .run(tbId, 1, c.chapterNo, c.chapterTitle, c.chapterNo);
    chapterIds.set(c.chapterNo, Number(r.lastInsertRowid));
  }
  const hasNoChapter = chunks.some((c) => c.chapterNo == null);
  const noChapter = hasNoChapter
    ? Number(
        db
          .prepare(
            "INSERT INTO chapter (textbook_id, level, seq, title, chapter_no) VALUES (?,?,?,?,NULL)",
          )
          .run(tbId, 1, 999, "参考书 / 课件（不参与门控）").lastInsertRowid,
      )
    : null;

  const insChunk = db.prepare(
    "INSERT INTO chunk (textbook_id, chapter_id, seq, page_from, page_to, text, n_chars) VALUES (?,?,?,?,?,?,?)",
  );
  const insFts = db.prepare("INSERT INTO chunk_fts (rowid, text) VALUES (?,?)");
  const insVec = db.prepare("INSERT INTO chunk_vec (chunk_id, dim, vec) VALUES (?,?,?)");

  db.exec("BEGIN");
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    const chapterId = c.chapterNo == null ? (noChapter ?? 0) : (chapterIds.get(c.chapterNo) ?? 0);
    const r = insChunk.run(tbId, chapterId, c.seq, null, null, c.text, c.text.length);
    const id = Number(r.lastInsertRowid);
    insFts.run(id, c.text);
    const f = Float32Array.from(vectors[i]!);
    insVec.run(id, dim, Buffer.from(f.buffer, f.byteOffset, f.byteLength));
  }
  db.exec("COMMIT");

  meta.run("embed_model", getEmbedConfig().model);
  meta.run("embed_dim", String(dim));
  meta.run("chunk_count", String(chunks.length));

  const count = (sql: string): number => Number((db.prepare(sql).get() as { c: number }).c);
  console.log(`\n✓ ${outFile}`);
  console.log(
    `  课程 ${CODE} / 章节 ${count("SELECT COUNT(*) c FROM chapter WHERE chapter_no IS NOT NULL")} / 切片 ${count("SELECT COUNT(*) c FROM chunk")}`,
  );
  console.log(`  向量 ${count("SELECT COUNT(*) c FROM chunk_vec")} 条，维度 ${dim}`);
  db.close();
  publish(workFile, outFile);

  // 已登记的科目顺手绑定新库，避免"库建好了但科目还指向空文件"
  const { getLearnerDb } = await import("../src/db/index.js");
  const ldb = getLearnerDb();
  const sub = ldb
    .prepare("SELECT course_code, course_name FROM subject WHERE course_code = ?")
    .get(CODE) as { course_code: string; course_name: string } | undefined;
  if (sub) {
    ldb
      .prepare(
        "UPDATE subject SET textbook_file = ?, textbook_ver = ?, updated_at = datetime('now') WHERE course_code = ?",
      )
      .run(`course-${CODE.toLowerCase()}.db`, now(), CODE);
    ldb
      .prepare("INSERT INTO event (type, ref_type, payload) VALUES (?,?,?)")
      .run(
        "subject_rebound",
        "subject",
        JSON.stringify({ course: CODE, file: `course-${CODE.toLowerCase()}.db` }),
      );
    ldb.close();
    console.log(`  已把科目 ${sub.course_name}（${CODE}）绑定到新库`);
  } else {
    ldb.close();
    console.log(`  ⚠ 科目 ${CODE} 还没登记：去「科目」页添加后会自动指向该库`);
  }
}

void main().catch((e) => {
  console.error("\n构建失败:", e);
  process.exit(1);
});
