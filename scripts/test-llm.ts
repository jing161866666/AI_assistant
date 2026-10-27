import "dotenv/config";
import { embeddingClient, llm } from "../src/llm/client.js";
import { getEmbedConfig, getLlmConfig } from "../src/llm/models.js";

interface Result {
  role: string;
  model: string;
  ok: boolean;
  ms: number;
  detail: string;
}

const results: Result[] = [];

async function probe(role: string, model: string, fn: () => Promise<string>): Promise<void> {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ role, model, ok: true, ms: Date.now() - t0, detail });
  } catch (e) {
    const err = e as Error & { status?: number; error?: unknown };
    const msg = err.message?.slice(0, 300) ?? String(e);
    results.push({
      role,
      model,
      ok: false,
      ms: Date.now() - t0,
      detail: `[${err.status ?? "?"}] ${msg}`,
    });
  }
}

async function main(): Promise<void> {
  // 1) 讲解模型：最小对话
  await probe("reason", getLlmConfig("reason").model, async () => {
    const r = await llm("reason").chat.completions.create({
      model: getLlmConfig("reason").model,
      messages: [{ role: "user", content: "只回复两个字：收到" }],
      max_tokens: 16,
    });
    const txt = r.choices[0]?.message?.content?.trim() ?? "";
    return `"${txt}" tokens=${r.usage?.total_tokens ?? "?"}`;
  });

  // 2) 抽取模型：要求返回 JSON，验证结构化输出能力
  await probe("extract", getLlmConfig("extract").model, async () => {
    const r = await llm("extract").chat.completions.create({
      model: getLlmConfig("extract").model,
      messages: [
        {
          role: "system",
          content: '只输出 JSON，不要解释。格式：{"error_type":"<concept|boundary|syntax>"}',
        },
        { role: "user", content: "题目：数组越界。学生代码没判 i < n。" },
      ],
      max_tokens: 64,
      response_format: { type: "json_object" },
    });
    const txt = r.choices[0]?.message?.content?.trim() ?? "";
    JSON.parse(txt); // 校验真的是合法 JSON
    return txt.slice(0, 80);
  });

  // 3) 视觉模型：不传图，仅验证模型是否存在可调用
  await probe("vision", getLlmConfig("vision").model, async () => {
    const r = await llm("vision").chat.completions.create({
      model: getLlmConfig("vision").model,
      messages: [{ role: "user", content: "只回复两个字：收到" }],
      max_tokens: 16,
    });
    return `"${r.choices[0]?.message?.content?.trim() ?? ""}"`;
  });

  // 4) 嵌入模型：真实向量化，核对维度
  const ec = getEmbedConfig();
  await probe("embed", ec.model, async () => {
    const r = await embeddingClient().embeddings.create({
      model: ec.model,
      input: ["库仑定律：真空中两个静止点电荷之间的作用力与电荷量乘积成正比"],
    });
    const v = r.data[0]?.embedding ?? [];
    if (v.length !== ec.dim) {
      return `维度不匹配：实际 ${v.length}，配置 EMBED_DIM=${ec.dim}`;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return `dim=${v.length} |v|=${norm.toFixed(4)} 前3=${v
      .slice(0, 3)
      .map((n) => n.toFixed(3))
      .join(",")}`;
  });

  console.log("\n模型接口实测\n" + "─".repeat(74));
  for (const r of results) {
    const flag = r.ok ? "✓" : "✗";
    console.log(
      `${flag} ${r.role.padEnd(8)} ${r.model.padEnd(18)} ${String(r.ms).padStart(6)}ms  ${r.detail}`,
    );
  }
  console.log("─".repeat(74));

  const bad = results.filter((r) => !r.ok);
  if (bad.length === 0) {
    console.log("四个角色全部可用。");
  } else {
    console.log(`${bad.length} 个角色不可用，需检查模型名或 Key 权限。`);
  }
  process.exit(bad.length === 0 ? 0 : 1);
}

void main();
