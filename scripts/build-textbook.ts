import "dotenv/config";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { embeddingClient } from "../src/llm/client.js";
import { getEmbedConfig } from "../src/llm/models.js";

/**
 * 构建只读教材库 textbook.db。
 *
 * 语料：课件 PDF（按页切片）+ 题库 docx（按题切片）。
 * 产物：一个可直接分发的 .db 文件，学生端只读挂在旁边。
 */

const COURSE_CODE = process.env.COURSE_CODE ?? "PHY2";
const COURSE_NAME = process.env.COURSE_NAME ?? "大学物理(B)II";
const OUT_FILE =
  process.env.TEXTBOOK_OUT ?? `./data/textbook/course-${COURSE_CODE.toLowerCase()}.db`;

const SLIDE_DIR = process.env.SLIDE_DIR ?? "C:/Users/jing1/Downloads/王雷";
const BANK_DIR = process.env.BANK_DIR ?? "大学物理下/参考书/清华大学大学物理题库全集";

const SCHEMA = resolve("db/schema/textbook.sql");

const pad = (n: number): string => String(n).padStart(2, "0");
const now = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

interface RawChunk {
  textbook: string;
  chapter: string;
  seq: number;
  page: number | null;
  text: string;
}

// ───────────────────────── 抽取 ─────────────────────────

async function extractSlides(dir: string): Promise<RawChunk[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (!existsSync(dir)) throw new Error(`课件目录不存在: ${dir}`);
  const files = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".pdf"))
    .sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));

  const out: RawChunk[] = [];
  for (const f of files) {
    const chapterNo = Number(f.split("-")[0]);
    const chapter = Number.isFinite(chapterNo) ? `第${chapterNo}章` : basename(f, ".pdf");
    const data = new Uint8Array(readFileSync(join(dir, f)));
    const doc = await pdfjs.getDocument({ data }).promise;
    let seq = 0;
    let kept = 0;
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const text = content.items
        .map((it) => ("str" in it ? it.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text.length < 40) continue; // 封面/纯图页
      out.push({ textbook: "王雷课件", chapter, seq: seq++, page: p, text });
      kept++;
    }
    console.log(`  ${f.padEnd(10)} ${String(doc.numPages).padStart(3)} 页 → 保留 ${kept} 片`);
  }
  return out;
}

async function extractBank(dir: string): Promise<RawChunk[]> {
  const mammoth = await import("mammoth");
  if (!existsSync(dir)) {
    console.log(`  （题库目录不存在，跳过）${dir}`);
    return [];
  }
  const files = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".docx"))
    .sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));

  const out: RawChunk[] = [];
  for (const f of files) {
    const { value } = await mammoth.extractRawText({ buffer: readFileSync(join(dir, f)) });
    const lines = value
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    // 按「1．」这类题号切题
    const blocks: string[] = [];
    let cur: string[] = [];
    for (const line of lines) {
      if (/^\d+\s*[．.、]/.test(line) && cur.length > 0) {
        blocks.push(cur.join("\n"));
        cur = [];
      }
      cur.push(line);
    }
    if (cur.length) blocks.push(cur.join("\n"));

    let seq = 0;
    let kept = 0;
    for (const b of blocks) {
      const text = b.replace(/\n+/g, " ").trim();
      if (text.length < 30) continue;
      out.push({
        textbook: "清华题库",
        chapter: basename(f, ".docx").slice(-12),
        seq: seq++,
        page: null,
        text,
      });
      kept++;
    }
    console.log(
      `  ${basename(f).slice(0, 40).padEnd(42)} ${String(value.length).padStart(6)} 字 → ${kept} 题`,
    );
  }
  return out;
}

// ───────────────────────── 向量化 ─────────────────────────

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
        const got = r.data
          .slice()
          .sort((a, b) => a.index - b.index)
          .map((d) => d.embedding as number[]);
        out.push(...got);
        break;
      } catch (e) {
        attempt++;
        if (attempt >= 4) throw e;
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    const done = Math.min(i + cfg.batchSize, texts.length);
    if (done % 50 < cfg.batchSize || done === texts.length) {
      console.log(`    向量化 ${done}/${texts.length}`);
    }
  }
  if (out.length !== texts.length) {
    throw new Error(`向量数量不匹配: ${out.length} vs ${texts.length}`);
  }
  return out;
}

// ───────────────────────── 主流程 ─────────────────────────

async function main(): Promise<void> {
  console.log("抽取语料…");
  const slides = await extractSlides(SLIDE_DIR);
  const bank = await extractBank(BANK_DIR);
  const chunks = [...slides, ...bank];
  console.log(`\n合计 ${chunks.length} 个切片（课件 ${slides.length} + 题库 ${bank.length}）`);

  console.log("\n向量化…");
  const vectors = await embedAll(chunks.map((c) => c.text));
  const dim = getEmbedConfig().dim;

  console.log("\n写库…");
  mkdirSync(resolve(OUT_FILE, ".."), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(OUT_FILE + suffix, { force: true });
  }

  const db = new DatabaseSync(OUT_FILE);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = OFF");
  db.exec(readFileSync(SCHEMA, "utf8"));

  db.prepare("INSERT INTO course (code, name, school, term, description) VALUES (?,?,?,?,?)").run(
    COURSE_CODE,
    COURSE_NAME,
    "东南大学",
    "2026-2027-1",
    "课件与题库合成教材库",
  );

  const textbooks = new Map<string, number>();
  for (const name of new Set(chunks.map((c) => c.textbook))) {
    const r = db
      .prepare("INSERT INTO textbook (course_code, title, source_file) VALUES (?,?,?)")
      .run(COURSE_CODE, name, name === "王雷课件" ? SLIDE_DIR : BANK_DIR);
    textbooks.set(name, Number(r.lastInsertRowid));
  }

  const chapters = new Map<string, number>();
  for (const c of chunks) {
    const key = `${c.textbook}|${c.chapter}`;
    if (chapters.has(key)) continue;
    const r = db
      .prepare("INSERT INTO chapter (textbook_id, level, seq, title) VALUES (?,?,?,?)")
      .run(textbooks.get(c.textbook)!, 1, chapters.size, c.chapter);
    chapters.set(key, Number(r.lastInsertRowid));
  }

  const insChunk = db.prepare(
    "INSERT INTO chunk (textbook_id, chapter_id, seq, page_from, page_to, text, n_chars) VALUES (?,?,?,?,?,?,?)",
  );
  const insFts = db.prepare("INSERT INTO chunk_fts (rowid, text) VALUES (?,?)");
  const insVec = db.prepare("INSERT INTO chunk_vec (chunk_id, dim, vec) VALUES (?,?,?)");

  db.exec("BEGIN");
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    const r = insChunk.run(
      textbooks.get(c.textbook)!,
      chapters.get(`${c.textbook}|${c.chapter}`)!,
      c.seq,
      c.page,
      c.page,
      c.text,
      c.text.length,
    );
    const id = Number(r.lastInsertRowid);
    insFts.run(id, c.text);
    const f = Float32Array.from(vectors[i]!);
    insVec.run(id, dim, Buffer.from(f.buffer, f.byteOffset, f.byteLength));
  }
  db.exec("COMMIT");

  const meta = db.prepare("INSERT INTO meta (key, value) VALUES (?,?)");
  meta.run("version", now());
  meta.run("course_code", COURSE_CODE);
  meta.run("embed_model", getEmbedConfig().model);
  meta.run("embed_dim", String(dim));
  meta.run("chunk_count", String(chunks.length));
  meta.run("builder", "scripts/build-textbook.ts");

  const count = (sql: string): number => Number((db.prepare(sql).get() as { c: number }).c);
  console.log(`\n✓ ${OUT_FILE}`);
  console.log(
    `  课程 ${COURSE_CODE} / 教材 ${count("SELECT COUNT(*) c FROM textbook")} 部 / 章节 ${count("SELECT COUNT(*) c FROM chapter")} / 切片 ${count("SELECT COUNT(*) c FROM chunk")}`,
  );
  console.log(`  向量 ${count("SELECT COUNT(*) c FROM chunk_vec")} 条，维度 ${dim}`);
  db.close();
}

void main().catch((e) => {
  console.error("\n构建失败:", e);
  process.exit(1);
});
