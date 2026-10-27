import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 探测 PDF 是否可抽取文字。
 * 扫描件（图片型 PDF）抽不出文字，RAG 就没法做，必须先知道。
 */
async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error("用法: tsx scripts/probe-pdf.ts <pdf路径> [页数]");
  const maxPages = Number(process.argv[3] ?? 3);

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(readFileSync(resolve(file)));

  const doc = await pdfjs.getDocument({
    data,
    useSystemFonts: false,
  }).promise;

  console.log(`文件: ${file}`);
  console.log(`页数: ${doc.numPages}`);
  const meta = await doc.getMetadata();
  const info = meta.info as Record<string, unknown>;
  console.log(`标题: ${info.Title ?? "(无)"}`);
  console.log(`作者: ${info.Author ?? "(无)"}`);

  let totalChars = 0;
  const n = Math.min(maxPages, doc.numPages);
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((it) => ("str" in it ? it.str : ""))
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    totalChars += text.length;
    console.log(`\n--- 第 ${i} 页（${text.length} 字）---`);
    console.log(text.slice(0, 300) || "（空）");
  }

  const avg = totalChars / n;
  console.log(`\n平均每页 ${avg.toFixed(0)} 字`);
  console.log(avg > 200 ? "✓ 可抽取文字，适合做 RAG" : "✗ 疑似扫描件，需要 OCR");
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
