import "dotenv/config";
import { review } from "../src/rag/answer.js";

async function main(): Promise<void> {
  const q = process.argv[2] ?? "杨氏双缝干涉实验中，d=0.2mm，D=1m，λ=600nm，求相邻明纹间距。";
  const a = process.argv[3] ?? "Δx = λD/d = 3mm";
  console.log(`题目: ${q}\n学生答案: ${a}\n`);
  const r = await review("course-phy2.db", q, a);
  console.log("verdict  :", r.verdict);
  console.log("error    :", r.error_type, "/", r.cause);
  console.log("correction:", r.correction);
  console.log("hints    :", r.hints);
  console.log("kps      :", r.related_kps);
  console.log("refs     :", r.references.length);
}

void main().catch((e) => {
  console.error("异常:", e);
  process.exit(1);
});
