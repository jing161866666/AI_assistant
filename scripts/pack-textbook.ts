import "dotenv/config";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { paths } from "../src/db/index.js";

/**
 * 把「内容已就绪」的教材库打包成可直接分发的目录 + manifest.json。
 *
 * 为什么需要它：`data/textbook/*.db` 被 gitignore（体积 + 版权），
 * 于是同事 clone 完代码、跑得起界面，但一问教材就是空的。
 * 教材库是**构建产物**，分发的是文件本身，不是源码。
 *
 * 打包时用 `VACUUM INTO` 导出一份干净副本，而不是直接 copy：
 * 原库是 WAL 模式，如果 -wal 里还有未 checkpoint 的页，裸拷贝会丢数据。
 * VACUUM INTO 只会输出已提交的完整状态，并顺带压掉空洞。
 *
 * 用法：
 *   npm run pack:textbook                 # 默认输出 dist/textbook-pack
 *   npm run pack:textbook -- --only PHY,DS
 *   npm run pack:textbook -- --all        # 连空库一起（正常别用）
 */

const MANIFEST_SCHEMA = 1;

export interface PackEntry {
  /** 文件名，如 course-phy.db —— 科目代码由它推导，不能改名 */
  file: string;
  course_code: string;
  course_name: string;
  chapters: number;
  chunks: number;
  embed_model: string;
  embed_dim: number;
  /** 教材库构建时间（meta.version），用来判断同事手里的是不是旧的 */
  textbook_version: string;
  bytes: number;
  sha256: string;
}

export interface PackManifest {
  schema: number;
  generated_at: string;
  /** 打包时的模型信息，fetch 端据此判断向量是否可比 */
  files: PackEntry[];
}

interface Args {
  out: string;
  only: string[];
  all: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { out: "dist/textbook-pack", only: [], all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--out" && next) {
      out.out = next;
      i++;
    } else if (a === "--only" && next) {
      out.only = next
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
      i++;
    } else if (a === "--all") {
      out.all = true;
    }
  }
  return out;
}

interface DbFacts {
  code: string;
  name: string;
  chapters: number;
  chunks: number;
  meta: Map<string, string>;
}

/** 读一个教材库的自述信息；库损坏时抛错（打包时宁可停下，也别发个坏包） */
function readFacts(file: string): DbFacts {
  const db = new DatabaseSync(file, { readOnly: true });
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
      // 老库可能没有 meta 表；后面按"缺 embed_model"处理
    }
    const course = db.prepare("SELECT code, name FROM course LIMIT 1").get() as
      | { code: string; name: string }
      | undefined;
    const chapters = Number(
      (
        db.prepare("SELECT COUNT(*) AS c FROM chapter WHERE chapter_no IS NOT NULL").get() as {
          c: number;
        }
      ).c,
    );
    const chunks = Number((db.prepare("SELECT COUNT(*) AS c FROM chunk").get() as { c: number }).c);
    const fallbackCode = file
      .replace(/^course-/, "")
      .replace(/\.db$/, "")
      .toUpperCase();
    return {
      code: (course?.code ?? fallbackCode).toUpperCase(),
      name: course?.name ?? fallbackCode,
      chapters,
      chunks,
      meta,
    };
  } finally {
    db.close();
  }
}

function sha256Of(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** 导出一份无 WAL 残留的干净副本 */
function exportClean(src: string, target: string): void {
  rmSync(target, { force: true });
  try {
    const db = new DatabaseSync(src);
    try {
      db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }
  } catch (e) {
    // 极少数情况（磁盘只读、库被独占）退化为裸拷贝：至少 -wal 为 0 字节时是安全的
    console.warn(`[pack] VACUUM INTO 失败，退回普通拷贝：${(e as Error).message}`);
    copyFileSync(src, target);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(args.out);

  if (!existsSync(paths.textbook)) {
    console.error(`教材库目录不存在：${paths.textbook}`);
    process.exit(1);
  }

  const files = readdirSync(paths.textbook)
    .filter((f) => f.endsWith(".db"))
    .sort();

  if (files.length === 0) {
    console.error(`教材库目录里没有 .db：${paths.textbook}`);
    console.error("先用 npm run build:course -- --course <简称> --code <CODE> 建库");
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });
  const entries: PackEntry[] = [];
  const skipped: string[] = [];

  console.log(`\n打包目录：${outDir}\n`);

  for (const file of files) {
    const src = join(paths.textbook, file);
    const facts = readFacts(src);

    if (args.only.length > 0 && !args.only.includes(facts.code)) {
      skipped.push(`${file}（不在 --only 列表）`);
      continue;
    }
    if (facts.chunks === 0 && !args.all) {
      // 空库是「登记了科目但还没建库」的占位，发出去只会在别人库里多出假科目
      skipped.push(`${file}（0 个 chunk，占位空库）`);
      continue;
    }

    const target = join(outDir, file);
    exportClean(src, target);

    entries.push({
      file,
      course_code: facts.code,
      course_name: facts.name,
      chapters: facts.chapters,
      chunks: facts.chunks,
      embed_model: facts.meta.get("embed_model") ?? "",
      embed_dim: Number(facts.meta.get("embed_dim") ?? 0),
      textbook_version: facts.meta.get("version") ?? "",
      bytes: statSync(target).size,
      sha256: sha256Of(target),
    });
  }

  if (entries.length === 0) {
    console.error("没有可打包的教材库（全是空库？加 --all 可强制打包）");
    process.exit(1);
  }

  const manifest: PackManifest = {
    schema: MANIFEST_SCHEMA,
    generated_at: new Date().toISOString(),
    files: entries,
  };
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const totalMb = entries.reduce((s, e) => s + e.bytes, 0) / 1024 / 1024;
  const models = new Set(entries.map((e) => `${e.embed_model || "?"}@${e.embed_dim || "?"}`));

  console.log("  科目   库文件                  chunk   章   构建时间");
  for (const e of entries) {
    console.log(
      `  ${e.course_code.padEnd(6)} ${e.file.padEnd(22)} ${String(e.chunks).padStart(5)} ${String(
        e.chapters,
      ).padStart(4)}   ${e.textbook_version}`,
    );
  }
  for (const s of skipped) console.log(`  跳过：${s}`);

  console.log(
    `\n共 ${entries.length} 个库，${totalMb.toFixed(1)} MB，向量模型：${[...models].join(" / ")}`,
  );
  if (models.size > 1) {
    console.warn("⚠ 这批库的 embedding 模型/维度不一致，同事那边只能命中其中一部分");
  }
  console.log(
    [
      "\n下一步：把这个目录整个发给同事（网盘 / 内网共享 / 优盘都行），",
      "让他执行：",
      `  npm run fetch:textbook -- --from <这个目录>`,
      `  npm run fetch:textbook -- --url <目录的基地址>     # 若挂在 HTTP 上`,
      "\nmanifest.json 里有 sha256，传输方式不用可信，校验会挡住损坏/改过的文件。",
    ].join("\n"),
  );
}

main();
