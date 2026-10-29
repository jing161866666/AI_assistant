import "dotenv/config";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { paths } from "../src/db/index.js";

/**
 * 教材库自检：确认「同事拿到的库」真的能用，而不是只存在一个文件。
 *
 * 逐个断言：meta 齐全 → chunk 数与 meta 一致 → 每条 chunk 都有同维度向量 →
 * FTS 索引与 chunk 数一致 → 抽查一次 MATCH 能命中。
 *
 * 这些恰好是「检索返回空 / 结果莫名其妙」的全部常见原因，
 * 所以它比 `ls data/textbook` 有用得多。
 *
 * 用法：npm run check:textbook
 */

interface Facts {
  file: string;
  code: string;
  chunks: number;
  chapters: number;
  embedModel: string;
  embedDim: number;
  storedChunkCount: string;
  version: string;
}

interface Problem {
  file: string;
  detail: string;
}

function countOf(db: DatabaseSync, sql: string): number {
  return Number((db.prepare(sql).get() as { c: number }).c);
}

function inspect(file: string): { facts: Facts; problems: string[] } {
  const problems: string[] = [];
  const db = new DatabaseSync(join(paths.textbook, file), { readOnly: true });
  try {
    const meta = new Map<string, string>();
    try {
      for (const r of db.prepare("SELECT key, value FROM meta").all() as Array<{
        key: string;
        value: string;
      }>) {
        meta.set(r.key, r.value);
      }
    } catch {
      problems.push("没有 meta 表 —— 不是 build:course 产出的库");
    }

    const course = db.prepare("SELECT code FROM course LIMIT 1").get() as
      | { code: string }
      | undefined;
    const code = (course?.code ?? file.replace(/^course-/, "").replace(/\.db$/, "")).toUpperCase();
    const chunks = countOf(db, "SELECT COUNT(*) AS c FROM chunk");
    const chapters = countOf(db, "SELECT COUNT(*) AS c FROM chapter WHERE chapter_no IS NOT NULL");
    const embedModel = meta.get("embed_model") ?? "";
    const embedDim = Number(meta.get("embed_dim") ?? 0);
    const storedChunkCount = meta.get("chunk_count") ?? "";
    const version = meta.get("version") ?? "";

    if (!embedModel || !embedDim) {
      problems.push("meta 缺 embed_model / embed_dim —— 无法判断向量空间，检索质量不可保证");
    }
    if (chunks > 0 && !storedChunkCount) {
      problems.push("meta 缺 chunk_count —— 无法确认构建是否完整");
    }
    if (storedChunkCount && Number(storedChunkCount) !== chunks) {
      problems.push(`meta.chunk_count=${storedChunkCount}，实际 chunk=${chunks}（构建被中断过？）`);
    }

    if (chunks > 0) {
      const vecRows = countOf(db, "SELECT COUNT(*) AS c FROM chunk_vec");
      if (vecRows !== chunks) {
        problems.push(`向量条数 ${vecRows} ≠ chunk 数 ${chunks} —— 有段落永远检索不到`);
      }
      const dims = db
        .prepare("SELECT dim, COUNT(*) AS c FROM chunk_vec GROUP BY dim")
        .all() as Array<{
        dim: number;
        c: number;
      }>;
      if (dims.length > 1) {
        problems.push(`库内混了多种向量维度：${dims.map((d) => d.dim).join("/")}`);
      }
      for (const d of dims) {
        if (embedDim && d.dim !== embedDim) {
          problems.push(`向量维度 ${d.dim} ≠ meta.embed_dim ${embedDim}`);
        }
      }
      const sizes = db
        .prepare("SELECT MIN(length(vec)) AS mn, MAX(length(vec)) AS mx FROM chunk_vec")
        .get() as {
        mn: number | null;
        mx: number | null;
      };
      if (sizes.mn != null && embedDim && sizes.mn !== embedDim * 4) {
        problems.push(
          `向量字节数 ${sizes.mn} 应为 dim*4=${embedDim * 4} —— 存的是 float32 吗？（换过存储格式？）`,
        );
      }
      if (chapters === 0) {
        problems.push("一章都没解析出来 —— 进度门控会失效（问题不大，但按章过滤用不了）");
      }

      const ftsRows = countOf(db, "SELECT COUNT(*) AS c FROM chunk_fts");
      if (ftsRows !== chunks) {
        problems.push(`FTS 索引 ${ftsRows} 条 ≠ chunk ${chunks} 条 —— 关键词检索会漏`);
      }
      // 抽查：能解析出拉丁词就用它验一次 MATCH，证明索引真的可查询（而不只是有行）
      const sample = db.prepare("SELECT text FROM chunk LIMIT 1").get() as
        | { text: string }
        | undefined;
      const word = sample?.text.match(/[A-Za-z]{4,}/)?.[0];
      if (word) {
        try {
          const hit = countOf(
            db,
            `SELECT COUNT(*) AS c FROM chunk_fts WHERE chunk_fts MATCH '${word}'`,
          );
          if (hit === 0) problems.push(`FTS 抽查失败：MATCH '${word}' 命中 0 条`);
        } catch (e) {
          problems.push(`FTS 查询报错：${(e as Error).message}`);
        }
      }
    }

    return {
      facts: { file, code, chunks, chapters, embedModel, embedDim, storedChunkCount, version },
      problems,
    };
  } finally {
    db.close();
  }
}

function main(): void {
  if (!existsSync(paths.textbook)) {
    console.error(`教材库目录不存在：${paths.textbook}`);
    console.error("运行 npm run fetch:textbook -- --from <打包目录>");
    process.exit(1);
  }

  const files = readdirSync(paths.textbook)
    .filter((f) => f.endsWith(".db"))
    .sort();
  if (files.length === 0) {
    console.error(`没有教材库：${paths.textbook} 是空的`);
    console.error(
      "问同事要一份 npm run pack:textbook 的输出，再 npm run fetch:textbook -- --from <目录>",
    );
    process.exit(1);
  }

  console.log(`\n教材库目录：${paths.textbook}\n`);
  const problems: Problem[] = [];
  let usable = 0;
  let placeholder = 0;

  for (const file of files) {
    const { facts, problems: p } = inspect(file);
    if (facts.chunks === 0) {
      placeholder++;
      console.log(
        `  ○ ${file.padEnd(22)} ${facts.code.padEnd(6)} 占位空库（登记了科目但没建库，不参与检索）`,
      );
      continue;
    }
    if (p.length === 0) usable++;
    else problems.push(...p.map((detail) => ({ file, detail })));
    const flag = p.length === 0 ? "✓" : "✗";
    console.log(
      `  ${flag} ${file.padEnd(22)} ${facts.code.padEnd(6)} ${String(facts.chunks).padStart(5)} chunk ${String(
        facts.chapters,
      ).padStart(3)} 章  ${facts.embedModel || "?"}@${facts.embedDim || "?"}  ${facts.version}`,
    );
  }

  console.log(`\n可用 ${usable} 个，占位 ${placeholder} 个，异常 ${problems.length} 处`);

  if (problems.length > 0) {
    console.log("");
    for (const p of problems) console.log(`  ✗ ${p.file}：${p.detail}`);
    console.log("\n库有问题就别让人在上面测 —— 先让出包的人重新 pack。");
    process.exit(1);
  }

  if (usable === 0) {
    console.log("\n只有占位空库，教材功能仍然不可用。");
    process.exit(1);
  }
  console.log("\n教材库已就绪。记得 .env 里的 EMBED_MODEL / EMBED_DIM 与上面一致。");
}

main();
