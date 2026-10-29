import "dotenv/config";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { COURSE_ROOT, listCourseFolders, type MaterialKind } from "../src/course/corpus.js";

/**
 * 从「我之前给的网站」下载课程资料到 课程/<简称>/<子目录>/。
 *
 * 不抓网页、不猜链接：每个课程文件夹放一个 `下载.json`，写明要下哪些文件：
 *
 *   {
 *     "items": [
 *       { "url": "https://.../概率论教材.pdf", "kind": "textbook" },
 *       { "url": "https://.../ch01.pdf", "kind": "reference", "filename": "ch01.pdf" }
 *     ]
 *   }
 *
 * 需要登录的网站：先在浏览器里下载好放到对应目录（本脚本不处理 cookie/验证码）。
 * 已存在的文件默认跳过，加 --force 才覆盖。
 */

const DIR_OF: Record<MaterialKind, string> = {
  textbook: "教材",
  reference: "参考书",
  slides: "课件",
  bank: "题库",
};

interface DownloadItem {
  url?: string;
  kind?: MaterialKind;
  filename?: string;
}

interface DownloadSpec {
  items?: DownloadItem[];
}

const FORCE = process.argv.includes("--force");
const ONLY = (() => {
  const i = process.argv.indexOf("--course");
  return i >= 0 ? process.argv[i + 1] : undefined;
})();

function safeName(url: string, given?: string): string {
  if (given?.trim()) return given.trim();
  const fromUrl = decodeURIComponent(basename(new URL(url).pathname));
  return fromUrl || `download-${Date.now()}`;
}

async function download(item: DownloadItem, folder: string): Promise<string> {
  if (!item.url) throw new Error("缺 url");
  const kind = item.kind ?? "reference";
  const dir = DIR_OF[kind];
  if (!dir) throw new Error(`未知 kind：${String(item.kind)}`);
  const name = safeName(item.url, item.filename);
  const out = resolve(COURSE_ROOT, folder, dir, name);
  if (existsSync(out) && !FORCE) return `跳过（已存在）：${dir}/${name}`;
  mkdirSync(dirname(out), { recursive: true });

  const res = await fetch(item.url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`下载失败 ${res.status} ${res.statusText}`);
  const size = Number(res.headers.get("content-length") ?? 0);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(out));
  const mb = (size / 1024 / 1024).toFixed(1);
  return `✓ ${dir}/${name}${size ? `（${mb} MB）` : ""}`;
}

async function main(): Promise<void> {
  const folders = (ONLY ? [ONLY] : listCourseFolders()).filter((f) => {
    if (!existsSync(resolve(COURSE_ROOT, f, "下载.json"))) {
      if (ONLY) console.log(`⚠ 课程/${f}/下载.json 不存在，跳过`);
      return false;
    }
    return true;
  });
  if (folders.length === 0) {
    console.log("没有找到 下载.json。在 课程/<课程简称>/下载.json 里写明要下载的 URL。");
    return;
  }

  for (const folder of folders) {
    const spec = JSON.parse(
      readFileSync(resolve(COURSE_ROOT, folder, "下载.json"), "utf8"),
    ) as DownloadSpec;
    const items = spec.items ?? [];
    console.log(`\n${folder}：${items.length} 个文件`);
    for (const item of items) {
      try {
        console.log(`  ${await download(item, folder)}`);
      } catch (e) {
        console.log(`  ✗ ${item.url ?? "(无 url)"} → ${(e as Error).message}`);
      }
    }
  }
  console.log("\n下载完成。接着建库：npm run build:course -- --course <课程简称> --code <CODE>");
}

void main().catch((e) => {
  console.error("下载失败:", e);
  process.exit(1);
});
