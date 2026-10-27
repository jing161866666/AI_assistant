import "dotenv/config";
import { retrieve, textbookInfo } from "../src/rag/search.js";

const FILE = process.env.TEXTBOOK_FILE ?? "course-phy2.db";

const QUERIES = [
  "杨氏双缝干涉的条纹间距公式",
  "安培环路定理",
  "简谐振动的能量",
  "光电效应 截止频率",
];

async function main(): Promise<void> {
  const info = textbookInfo(FILE);
  console.log(
    `教材库 ${FILE}: ${info.ok ? `可用，${info.chunks} 片，版本 ${info.version}` : "不可用"}`,
  );
  if (!info.ok) process.exit(1);

  for (const q of QUERIES) {
    console.log(`\n${"═".repeat(70)}\n问题: ${q}\n${"═".repeat(70)}`);
    const hits = await retrieve(FILE, q, 4);
    if (hits.length === 0) {
      console.log("  没有命中");
      continue;
    }
    for (const [i, h] of hits.entries()) {
      const loc = h.page != null ? `${h.chapter} p${h.page}` : h.chapter;
      console.log(`  [${i + 1}] ${h.score}  ${h.textbook}/${loc}  (${h.via.join("+")})`);
      console.log(`      ${h.text.slice(0, 110).replace(/\s+/g, " ")}`);
    }
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
