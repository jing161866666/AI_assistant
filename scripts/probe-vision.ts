import "dotenv/config";
import { readFileSync } from "node:fs";
import { llm } from "../src/llm/client.js";
import { getLlmConfig } from "../src/llm/models.js";

const IMG = process.argv[2] ?? "data/corpus/test-question.png";
const dataUrl = `data:image/png;base64,${readFileSync(IMG).toString("base64")}`;

const SOLVE_PROMPT = `这是一道物理题。请：
1. 先逐字转录题目和图中标注的量。
2. 再把图里的几何关系写成文字（有哪些对象、角度、参考方向）。
3. 然后分步骤解题，公式用 $...$。

直接输出，不要客套。`;

async function tryModel(label: string, model: string, withImage: boolean): Promise<void> {
  const t0 = Date.now();
  try {
    const content = withImage
      ? [
          { type: "text" as const, text: SOLVE_PROMPT },
          { type: "image_url" as const, image_url: { url: dataUrl } },
        ]
      : [{ type: "text" as const, text: SOLVE_PROMPT }];
    const r = await llm("reason" as never).chat.completions.create({
      model,
      // biome-ignore lint/suspicious/noExplicitAny: 探测多模态能力，故意放宽类型
      messages: [{ role: "user", content: content as any }],
      max_tokens: 1500,
      temperature: 0,
    });
    const txt = r.choices[0]?.message?.content ?? "";
    console.log(`\n${"=".repeat(72)}`);
    console.log(`✓ ${label}  (${model})  ${Date.now() - t0}ms  返回 ${txt.length} 字`);
    console.log("=".repeat(72));
    console.log(txt.slice(0, 1400));
  } catch (e) {
    const err = e as Error & { status?: number };
    console.log(`\n${"=".repeat(72)}`);
    console.log(`✗ ${label}  (${model})  ${Date.now() - t0}ms`);
    console.log(`  [${err.status ?? "?"}] ${(err.message ?? "").slice(0, 200)}`);
  }
}

async function main(): Promise<void> {
  const cfgReason = getLlmConfig("reason");
  const cfgVision = getLlmConfig("vision");
  console.log(`图片: ${IMG}  (${(readFileSync(IMG).length / 1024).toFixed(0)} KB)`);
  console.log(`reason 模型: ${cfgReason.model}`);
  console.log(`vision 模型: ${cfgVision.model}`);

  await tryModel("A. 推理模型直接看图", cfgReason.model, true);
  await tryModel("B. 视觉模型直接解题", cfgVision.model, true);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
