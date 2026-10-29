import "dotenv/config";

/**
 * 判对错质量探针：只挑"最容易判错"的两种输入
 *  A. 正确答案 → 必须 correct
 *  B. 数量级错 1000 倍 → 必须 wrong（历史上 flash 级模型把它判成 correct）
 *  C. 学生给的是过程 → input_kind 必须是 process
 */

const SYS =
  '你是批改助教。判断学生输入是什么（answer/process/question），再判对错。只输出 JSON：{"verdict":"correct|partially|wrong|unsolved","input_kind":"answer|process|question","error_type":"none|concept|unit|careless|logic|unknown","cause":"50字内","correction":"标准解答"}。';

const CASES = [
  {
    name: "A 正确答案",
    q: "平行板电容器 C=2.0μF，充电到 U=100V，求储能。",
    a: "W = ½CU² = 0.5×2e-6×1e4 = 1.0×10⁻² J",
    expect: "correct",
  },
  {
    name: "B 数量级错 1000 倍",
    q: "平行板电容器 C=2.0μF，充电到 U=100V，求储能。",
    a: "W = 1.0×10⁻⁵ J",
    expect: "wrong",
  },
  {
    name: "C 学生给的是过程",
    q: "一维无限深势阱宽度 a，求基态能量。",
    a: "我先写出 E = h²/(8ma²)，h 这里应该是普朗克常量吧？然后代入 n=1",
    expect: "process",
  },
];

const PROVIDERS = {
  qwen: { baseUrl: process.env.LLM_BASE_URL ?? "", apiKey: process.env.LLM_API_KEY ?? "" },
  deepseek: {
    baseUrl: process.env.FAST_BASE_URL ?? "https://api.deepseek.com/v1",
    apiKey: process.env.FAST_API_KEY ?? "",
  },
} as const;

const MODELS: Array<{ p: keyof typeof PROVIDERS; m: string }> = [
  { p: "qwen", m: process.env.MODEL_REASON ?? "qwen3.8-max" },
  { p: "qwen", m: process.env.MODEL_EXTRACT ?? "qwen-flash" },
  { p: "deepseek", m: "deepseek-chat" },
  { p: "deepseek", m: "deepseek-reasoner" },
];

async function grade(p: keyof typeof PROVIDERS, model: string, c: (typeof CASES)[number]) {
  const { baseUrl, apiKey } = PROVIDERS[p];
  const t0 = Date.now();
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYS },
        { role: "user", content: `题目：${c.q}\n学生输入：${c.a}` },
      ],
      max_tokens: 600,
      temperature: 0,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  const ms = Date.now() - t0;
  try {
    const j = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = j.choices?.[0]?.message?.content ?? "{}";
    const obj = JSON.parse(raw) as { verdict?: string; input_kind?: string };
    return { ms, verdict: obj.verdict ?? "?", kind: obj.input_kind ?? "?" };
  } catch {
    return { ms, verdict: "ERR", kind: "ERR" };
  }
}

async function main(): Promise<void> {
  for (const m of MODELS) {
    const cells: string[] = [];
    for (const c of CASES) {
      const r = await grade(m.p, m.m, c);
      const got = c.name.startsWith("C") ? r.kind : r.verdict;
      const ok = got === c.expect ? "✓" : "✗";
      cells.push(`${c.name.slice(0, 1)}${ok}(${got},${(r.ms / 1000).toFixed(1)}s)`);
    }
    console.log(`${`${m.p}/${m.m}`.padEnd(34)} ${cells.join("  ")}`);
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
