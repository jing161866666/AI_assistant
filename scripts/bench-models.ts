import "dotenv/config";
import { DatabaseSync } from "node:sqlite";

/**
 * 模型 × 任务 速度对比。
 *
 * 目的：别凭感觉选模型。每种任务用同一个 prompt 各跑一遍，量出真实耗时与产出，
 * 然后把结论写死到 src/llm/models.ts 的 TASK_MODEL 表里。
 *
 * 用法：npx tsx scripts/bench-models.ts
 */

const OPENAI_KEYS = {
  qwen: {
    baseUrl: process.env.LLM_BASE_URL ?? "",
    apiKey: process.env.LLM_API_KEY ?? "",
  },
  deepseek: {
    baseUrl: process.env.FAST_BASE_URL ?? "https://api.deepseek.com/v1",
    apiKey: process.env.FAST_API_KEY ?? "",
  },
} as const;

type Provider = keyof typeof OPENAI_KEYS;

const CANDIDATES: Array<{ provider: Provider; model: string; note: string }> = [
  { provider: "qwen", model: process.env.MODEL_REASON ?? "qwen3.8-max", note: "现用 reason" },
  { provider: "qwen", model: process.env.MODEL_EXTRACT ?? "qwen-flash", note: "现用 extract" },
  { provider: "deepseek", model: "deepseek-chat", note: "DeepSeek 通用" },
  { provider: "deepseek", model: "deepseek-reasoner", note: "DeepSeek 推理" },
];

interface TaskSpec {
  name: string;
  /** 用于统计的提示长度 */
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
  json?: boolean;
}

const TASKS: TaskSpec[] = [
  {
    name: "解题（中等物理题）",
    system:
      "你是大学物理老师。分步骤求解：已知 → 求 → 原理 → 代入 → 结果（带单位）。公式用 $...$。末尾给【扩充解析】：考点/易错点/同类题思路。",
    user: "一质量为 m 的物体从倾角 30° 的光滑斜面顶端由静止下滑，斜面高 h，求到底端的速度大小，并说明与质量是否有关。",
    maxTokens: 800,
    temperature: 0.2,
  },
  {
    name: "排一周日程（JSON）",
    system:
      '你在给大学生排本周学习日程，只输出 JSON：{"plan":[{"date":"YYYY-MM-DD","start":"HH:MM","end":"HH:MM","course_code":"DS","kind":"review|practice|netcourse","task":"具体学什么","reason":"为什么"}]}。单块 25-60 分钟，每天不超 120 分钟，只排空档。',
    user: "区间 2026-10-26~2026-11-01。周一有数据结构课(08:00-09:30)，周四有大学物理课(08:00-09:35)。DS 投入 0.6、PHY2 投入 0.4。偏好时段 20:00-22:00。空档：每天 19:00-23:00。",
    maxTokens: 1200,
    temperature: 0.2,
    json: true,
  },
  {
    name: "批改判对错（JSON）",
    system:
      '你是批改助教。判断学生输入是什么（answer/process/question），再判对错。只输出 JSON：{"verdict":"correct|partially|wrong|unsolved","input_kind":"...","error_type":"none|concept|unit|careless|logic|unknown","cause":"50字内","correction":"标准解答"}。数量级、单位必须逐项比对。',
    user: "题目：质量 2kg 物块受水平力 F=10N 作用 3s，摩擦系数 0.2，求末速度。学生作答：v = 12 m/s。",
    maxTokens: 500,
    temperature: 0,
    json: true,
  },
  {
    name: "习惯抽取（JSON）",
    system:
      '你在观察学生学习痕迹，抽取稳定习惯。只输出 JSON：{"habits":[{"dimension":"learn_method|study_time|planning|attention|error_pattern","key":"","value":"","snippet":""}],"enough_evidence":true}',
    user: "学生连续三天都是晚上 21:00-23:00 写代码，中途每 40 分钟休息一次；他说「先看英文 CS 网课再动手写」。",
    maxTokens: 400,
    temperature: 0,
    json: true,
  },
];

async function call(
  provider: Provider,
  model: string,
  task: TaskSpec,
): Promise<{ ms: number; chars: number; err?: string }> {
  const { baseUrl, apiKey } = OPENAI_KEYS[provider];
  const t0 = Date.now();
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: task.system },
          { role: "user", content: task.user },
        ],
        max_tokens: task.maxTokens,
        temperature: task.temperature,
        ...(task.json ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const text = await res.text();
    const ms = Date.now() - t0;
    if (!res.ok) return { ms, chars: 0, err: `${res.status} ${text.slice(0, 80)}` };
    const j = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { completion_tokens?: number };
    };
    const content = j.choices?.[0]?.message?.content ?? "";
    return { ms, chars: content.length };
  } catch (e) {
    return { ms: Date.now() - t0, chars: 0, err: (e as Error).name };
  }
}

async function main(): Promise<void> {
  console.log("模型 × 任务 速度对比（每个组合跑 1 次，看数量级即可）\n");
  const rows: Array<{
    task: string;
    model: string;
    provider: string;
    ms: number;
    chars: number;
    err?: string;
  }> = [];

  for (const task of TASKS) {
    console.log(`\n=== ${task.name} ===`);
    for (const c of CANDIDATES) {
      const r = await call(c.provider, c.model, task);
      const sec = (r.ms / 1000).toFixed(1);
      console.log(
        `  ${`${c.provider}/${c.model}`.padEnd(34)} ${sec.padStart(6)}s  ${String(r.chars).padStart(5)} 字  ${r.err ? `❌ ${r.err}` : ""}`,
      );
      rows.push({ task: task.name, model: c.model, provider: c.provider, ...r });
    }
  }

  console.log("\n===== 汇总（秒）=====");
  const header = ["任务", ...CANDIDATES.map((c) => c.model)];
  console.log(header.join("\t"));
  for (const task of TASKS) {
    const cells = CANDIDATES.map((c) => {
      const hit = rows.find((r) => r.task === task.name && r.model === c.model);
      return hit?.err ? `ERR` : `${(hit?.ms ?? 0) / 1000}`;
    });
    console.log([task.name, ...cells].join("\t"));
  }

  const db = new DatabaseSync("data/learner.db", { readOnly: true });
  const count = (db.prepare("SELECT COUNT(*) AS c FROM event").get() as { c: number }).c;
  console.log(`\n（对比完成；当前库有 ${count} 条事件）`);
  db.close();
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
