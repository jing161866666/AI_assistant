import "dotenv/config";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { paths } from "../src/db/index.js";
import type { PackEntry, PackManifest } from "./pack-textbook.js";

/**
 * 把同事那边打包好的教材库装进本机 `data/textbook/`。
 *
 * 为什么要 sha256：传输通道（优盘、网盘、微信、HTTP）都不可信，
 * 但只要 manifest 里的哈希对得上，文件就是完整的。所以不必开服务器、不必建下载站，
 * 一个网盘共享目录就够了。
 *
 * 为什么校验 embedding 维度：教材库里的向量是**预构建**的（qwen3.7-text-embedding / 1024 维）。
 * 若本地 EMBED_DIM 与之不一致，检索不会报错，只会静默排出一堆无关段落 —— 比崩溃更难发现。
 *
 * 用法：
 *   npm run fetch:textbook -- --from D:\共享\textbook-pack
 *   npm run fetch:textbook -- --url https://example.com/textbook-pack
 *   npm run fetch:textbook -- --from ... --force     # 维度不一致也装（仅在你知道后果时）
 */

const MANIFEST_SCHEMA = 1;

interface Args {
  from: string | null;
  url: string | null;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { from: null, url: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--from" && next) {
      out.from = next;
      i++;
    } else if (a === "--url" && next) {
      out.url = next.replace(/\/+$/, "");
      i++;
    } else if (a === "--force") {
      out.force = true;
    }
  }
  return out;
}

/** 本地配置的向量维度：与 src/llm/models.ts 的默认值保持一致 */
function localEmbed(): { model: string; dim: number } {
  const model = (process.env.EMBED_MODEL ?? "").trim() || "text-embedding-v3";
  const raw = (process.env.EMBED_DIM ?? "").trim() || "1024";
  const dim = Number(raw);
  return { model, dim: Number.isFinite(dim) ? dim : 1024 };
}

function sha256Of(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function parseManifest(text: string): PackManifest {
  let m: PackManifest;
  try {
    m = JSON.parse(text) as PackManifest;
  } catch {
    throw new Error("manifest.json 不是合法 JSON");
  }
  if (m.schema !== MANIFEST_SCHEMA) {
    throw new Error(`manifest 版本不支持：${m.schema}（本机只认 ${MANIFEST_SCHEMA}）`);
  }
  if (!Array.isArray(m.files) || m.files.length === 0) {
    throw new Error("manifest.json 里没有文件条目");
  }
  return m;
}

async function readManifest(args: Args): Promise<PackManifest> {
  if (args.from) {
    const p = join(resolve(args.from), "manifest.json");
    if (!existsSync(p))
      throw new Error(`找不到 ${p}（--from 要指向 pack:textbook 输出的那个目录）`);
    return parseManifest(readFileSync(p, "utf8"));
  }
  const res = await fetch(`${args.url}/manifest.json`);
  if (!res.ok) throw new Error(`下载 manifest.json 失败：HTTP ${res.status}`);
  return parseManifest(await res.text());
}

async function readFileBytes(args: Args, entry: PackEntry): Promise<Buffer> {
  if (args.from) {
    const p = join(resolve(args.from), entry.file);
    if (!existsSync(p)) throw new Error(`打包目录里缺文件：${p}`);
    return readFileSync(p);
  }
  const res = await fetch(`${args.url}/${encodeURIComponent(entry.file)}`);
  if (!res.ok) throw new Error(`下载 ${entry.file} 失败：HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.from && !args.url) {
    console.error("用法：npm run fetch:textbook -- --from <目录>   或   --url <基地址>");
    process.exit(1);
  }

  const manifest = await readManifest(args);
  const local = localEmbed();
  console.log(`\n源：${args.from ?? args.url}`);
  console.log(`打包时间：${manifest.generated_at}，共 ${manifest.files.length} 个库`);
  console.log(`本地向量配置：${local.model} @ ${local.dim}\n`);

  const dims = new Set(manifest.files.map((f) => f.embed_dim).filter((d) => d > 0));
  if (dims.size === 0) {
    console.error("manifest 里没有 embed_dim —— 这批库来路不明，拒绝安装");
    process.exit(1);
  }
  if (!dims.has(local.dim)) {
    const msg = `向量维度不一致：教材库是 ${[...dims].join("/")} 维，本机 EMBED_DIM=${local.dim}。\n检索不会报错，但结果会静默变差。改 .env 里的 EMBED_DIM，或加 --force 强行安装。`;
    if (!args.force) {
      console.error(`✗ ${msg}`);
      process.exit(1);
    }
    console.warn(`⚠ ${msg}`);
  }
  const models = new Set(manifest.files.map((f) => f.embed_model).filter(Boolean));
  for (const m of models) {
    if (m !== local.model) {
      console.warn(
        `⚠ 教材库用 ${m} 建的，本机 EMBED_MODEL=${local.model}。\n  名称不同不代表向量空间不同（可能是别名），但若检索结果明显变差，先查这里。`,
      );
    }
  }

  mkdirSync(paths.textbook, { recursive: true });
  const installed: string[] = [];

  for (const entry of manifest.files) {
    const buf = await readFileBytes(args, entry);
    const got = sha256Of(buf);
    if (got !== entry.sha256) {
      console.error(`\n✗ ${entry.file} 校验失败`);
      console.error(`  期望 ${entry.sha256}`);
      console.error(`  实际 ${got}`);
      console.error("  文件在传输中被改过或损坏了，重新传一次。");
      process.exit(1);
    }

    const target = join(paths.textbook, entry.file);
    writeFileSync(target, buf);
    // 旧的 WAL/SHM 会和新的主库对不上，必须清掉
    for (const s of ["-wal", "-shm"]) rmSync(`${target}${s}`, { force: true });

    installed.push(entry.course_code);
    console.log(
      `✓ ${entry.file.padEnd(22)} ${entry.course_code.padEnd(6)} ${String(entry.chunks).padStart(5)} chunk  ${(statSync(target).size / 1024 / 1024).toFixed(1)} MB`,
    );
  }

  console.log(`\n已安装 ${installed.length} 个教材库：${installed.join(", ")}`);
  console.log(
    [
      "\n接下来：",
      "  1. 重启服务（npm start）—— 启动时才会把新库自动登记成科目",
      "  2. npm run check:textbook   # 确认库完好、向量维度对得上",
      "  3. 检索/解题还需要一个百炼 Key（query 要算 embedding），见 README「配置模型 Key」",
    ].join("\n"),
  );
}

main().catch((e: unknown) => {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exit(1);
});
