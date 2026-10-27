import "dotenv/config";
import { embeddingClient, llm } from "../src/llm/client.js";

const BASE = process.env.LLM_BASE_URL!;
const KEY = (process.env.LLM_API_KEY ?? "").trim();

async function listModels(): Promise<string[]> {
  const r = await fetch(`${BASE}/models`, {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  if (!r.ok) throw new Error(`/models ${r.status}`);
  const j = (await r.json()) as { data?: Array<{ id: string }> };
  return (j.data ?? []).map((d) => d.id);
}

async function tryChat(model: string): Promise<string> {
  const c = llm("reason"); // 只借用 client，模型名手动传
  const r = await c.chat.completions.create({
    model,
    messages: [{ role: "user", content: "回复：OK" }],
    max_tokens: 8,
  });
  return r.choices[0]?.message?.content?.trim() ?? "";
}

async function tryJson(model: string): Promise<string> {
  const c = llm("reason");
  const r = await c.chat.completions.create({
    model,
    messages: [
      { role: "system", content: '只输出 JSON：{"error_type":"boundary"}' },
      { role: "user", content: "数组越界" },
    ],
    max_tokens: 32,
    response_format: { type: "json_object" },
  });
  const t = r.choices[0]?.message?.content?.trim() ?? "";
  JSON.parse(t);
  return t;
}

async function tryEmbed(model: string): Promise<string> {
  const r = await embeddingClient().embeddings.create({
    model,
    input: ["测试文本"],
  });
  const v = r.data[0]?.embedding ?? [];
  return `dim=${v.length}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const all = await listModels();
  console.log(`清单共 ${all.length} 个模型\n`);

  const textish = all
    .filter((m) => /^(qwen|deepseek|kimi|glm|moonshot)/i.test(m))
    .filter((m) => !/asr|tts|realtime|omni|image|video|mt-|translate|character|live/i.test(m))
    .filter((m) => !/embedding|vl-ocr/i.test(m));
  console.log("--- 候选文本模型 ---");
  console.log(textish.join("\n"));
  console.log("");

  const candidates: Array<[string, string, () => Promise<string>]> = [
    ["vision", "qwen3-vl-plus", () => tryChat("qwen3-vl-plus")],
    ["vision", "qwen-vl-ocr", () => tryChat("qwen-vl-ocr")],
    ["extract", "qwen-flash", () => tryJson("qwen-flash")],
    ["extract", "qwen3.8-flash", () => tryJson("qwen3.8-flash")],
    ["extract", "qwen3.7-flash", () => tryJson("qwen3.7-flash")],
    ["extract", "qwen-plus", () => tryJson("qwen-plus")],
    ["reason", "qwen-max", () => tryChat("qwen-max")],
    ["embed", "qwen3.7-text-embedding", () => tryEmbed("qwen3.7-text-embedding")],
    ["embed", "qwen3.7-text-embedding-flash", () => tryEmbed("qwen3.7-text-embedding-flash")],
    ["embed", "text-embedding-v3", () => tryEmbed("text-embedding-v3")],
  ];

  console.log("--- 逐个实测 ---");
  for (const [role, model, fn] of candidates) {
    const t0 = Date.now();
    try {
      const out = await fn();
      console.log(
        `✓ ${role.padEnd(8)} ${model.padEnd(28)} ${String(Date.now() - t0).padStart(5)}ms  ${out}`,
      );
    } catch (e) {
      const err = e as Error & { status?: number };
      console.log(
        `✗ ${role.padEnd(8)} ${model.padEnd(28)} ${String(Date.now() - t0).padStart(5)}ms  [${err.status ?? "?"}] ${(err.message ?? "").slice(0, 90)}`,
      );
    }
    await sleep(1200); // 避免触发限流
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
