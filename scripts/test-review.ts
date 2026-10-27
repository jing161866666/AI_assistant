import "dotenv/config";
import { llm } from "../src/llm/client.js";
import { getLlmConfig } from "../src/llm/models.js";
import { retrieve } from "../src/rag/search.js";

const FILE = "course-phy2.db";

async function main(): Promise<void> {
  const question =
    process.argv[2] ?? "杨氏双缝干涉实验中，d=0.2mm，D=1m，λ=600nm，求相邻明纹间距。";
  const myAnswer = process.argv[3] ?? "Δx = λD/d = 3mm";

  const hits = await retrieve(FILE, `${question} ${myAnswer}`, 4);
  const cfg = getLlmConfig("extract");
  const material = hits.map((h, i) => `[${i + 1}] ${h.text}`).join("\n\n");

  const r = await llm("extract").chat.completions.create({
    model: cfg.model,
    messages: [
      {
        role: "system",
        content: `你是大学物理课的批改助教。只输出 JSON，不要任何解释文字。字段：
- verdict: "correct" | "partially" | "wrong"
- error_type: "concept" | "misread" | "boundary" | "formula" | "unit" | "logic" | "careless" | "unknown"
- cause: 一句话说清错在哪一步
- correction: 正确答案与关键推导
- hints: 字符串数组，1-3 条
- related_kps: 字符串数组，2-4 个知识点名称`,
      },
      {
        role: "user",
        content: `题目：${question}\n学生作答：${myAnswer}\n资料：\n${material}`,
      },
    ],
    max_tokens: 900,
    temperature: 0,
    response_format: { type: "json_object" },
  });

  const raw = r.choices[0]?.message?.content ?? "";
  console.log(`模型: ${cfg.model}`);
  console.log(`finish_reason: ${r.choices[0]?.finish_reason}`);
  console.log(`原始返回长度: ${raw.length}`);
  console.log("──────── 原始内容 ────────");
  console.log(raw);
  console.log("──────── 尝试解析 ────────");
  try {
    console.log(JSON.stringify(JSON.parse(raw), null, 2));
  } catch (e) {
    console.log(`JSON.parse 失败: ${(e as Error).message}`);
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
