import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";

async function samplePdf(file: string): Promise<void> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(readFileSync(resolve(file)));
  const doc = await pdfjs.getDocument({ data }).promise;
  const n = doc.numPages;
  const pages = [1, 5, 20, 50, 100, Math.floor(n * 0.3), Math.floor(n * 0.6), n - 2]
    .filter((p) => p >= 1 && p <= n)
    .filter((p, i, a) => a.indexOf(p) === i)
    .sort((a, b) => a - b);

  let hit = 0;
  console.log(`  ${n} 页，抽样 ${pages.length} 页`);
  for (const p of pages) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const text = content.items
      .map((it) => ("str" in it ? it.str : ""))
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length > 50) hit++;
    console.log(
      `    p${String(p).padStart(3)}: ${String(text.length).padStart(5)} 字  ${text.slice(0, 60)}`,
    );
  }
  console.log(hit === 0 ? "  → 整本无文字，是扫描件" : `  → ${hit}/${pages.length} 页有文字`);
}

async function sampleDocx(file: string): Promise<void> {
  const mammoth = await import("mammoth");
  const { value } = await mammoth.extractRawText({ buffer: readFileSync(resolve(file)) });
  const text = value.replace(/[ \t]+/g, " ").trim();
  console.log(`  ${text.length} 字`);
  console.log(`  开头: ${text.slice(0, 200).replace(/\n+/g, " / ")}`);
}

async function main(): Promise<void> {
  const files = process.argv.slice(2);
  for (const f of files) {
    console.log(`\n=== ${f} ===`);
    const ext = extname(f).toLowerCase();
    try {
      if (ext === ".pdf") await samplePdf(f);
      else if (ext === ".docx") await sampleDocx(f);
      else console.log("  跳过（不支持）");
    } catch (e) {
      console.log(`  失败: ${(e as Error).message}`);
    }
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
