/**
 * 五个模型角色必须分开用。
 * 一个模型全包会导致：抽取慢且贵、视觉不可用、嵌入缺失。
 *
 * 下表是**实测**得出的任务→模型分工（2026-10，见 scripts/bench-models.ts 与 bench-grade.ts）：
 *
 * | 任务 | 模型 | 实测耗时 | 备注 |
 * |---|---|---|---|
 * | 解题（smart） | deepseek-reasoner | 4.8s | 质量与速度兼顾 |
 * | 解题（fast）   | deepseek-chat     | 2.3s | 用户主动选"快答" |
 * | 判对错         | deepseek-reasoner | 2.3s | **不能用 deepseek-chat**：实测把数量级错 1000 倍判成 correct |
 * | 排日程（JSON） | deepseek-chat     | 4.9s | 硬约束由代码校验，无需强推理 |
 * | 习惯抽取       | deepseek-chat     | 1.2s | 结构化抽取 |
 * | 看图/转录      | qwen3-vl-plus     | —    | 只有它需要多模态 |
 * | 向量化         | qwen3.7-text-embedding | — | 维度必须与 EMBED_DIM 一致 |
 */

export type ModelRole = "reason" | "extract" | "vision" | "fast" | "embed";

/** 每条链路用哪个角色：改这里等于改"哪种任务用哪个模型" */
export const TASK_ROLE = {
  solve_smart: "reason",
  solve_fast: "fast",
  grade: "reason",
  plan: "extract",
  habit_extract: "extract",
  vision: "vision",
  embed: "embed",
} as const;

export type LlmTask = keyof typeof TASK_ROLE;

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;
}

/** 判断是否为占位符而非真实值 */
function isPlaceholder(v: string): boolean {
  return /请替换|your[_-]?key|^(sk-)?x+$|^changeme$/i.test(v);
}

/** 取值：占位符等同于未配置 */
function env(k: string, fallback = ""): string {
  const v = process.env[k]?.trim() ?? "";
  if (!v || isPlaceholder(v)) return fallback;
  return v;
}

function require(k: string): string {
  const v = env(k);
  if (!v) throw new Error(`缺少环境变量 ${k}，请复制 .env.example 为 .env 并填写`);
  return v;
}

export function getLlmConfig(role: Exclude<ModelRole, "embed">): LlmConfig {
  const qwen = {
    baseUrl: require("LLM_BASE_URL"),
    apiKey: require("LLM_API_KEY"),
  };
  // 解题/排期/抽取走 DeepSeek（实测比 qwen3.8-max 快 5-30 倍）；没配就回退 qwen
  const deepseek = {
    baseUrl: env("FAST_BASE_URL") || qwen.baseUrl,
    apiKey: env("FAST_API_KEY") || qwen.apiKey,
  };

  switch (role) {
    case "reason":
      // 解题 + 判对错。判对错绝不能换成 deepseek-chat（实测把数量级错 1000 倍判成 correct）
      return {
        ...deepseek,
        model: env("MODEL_REASON", "deepseek-reasoner"),
        maxTokens: 4096,
        temperature: 0.3,
      };
    case "extract":
      // 结构化 JSON：排日程、习惯抽取、举一反三
      return {
        ...deepseek,
        model: env("MODEL_EXTRACT", "deepseek-chat"),
        maxTokens: 1200,
        temperature: 0,
      };
    case "vision":
      // 看图只能 qwen（DeepSeek 没有多模态）
      return {
        ...qwen,
        model: env("MODEL_VISION", "qwen3-vl-plus"),
        maxTokens: 2048,
        temperature: 0.1,
      };
    case "fast":
      // 用户主动选"快答"时的解题模型
      return {
        ...deepseek,
        model: env("MODEL_FAST", "deepseek-chat"),
        maxTokens: 2500,
        temperature: 0.2,
      };
  }
}

export interface EmbedConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  dim: number;
  batchSize: number;
}

export function getEmbedConfig(): EmbedConfig {
  return {
    baseUrl: env("EMBED_BASE_URL") || require("LLM_BASE_URL"),
    apiKey: env("EMBED_API_KEY") || require("LLM_API_KEY"),
    model: env("EMBED_MODEL", "text-embedding-v3"),
    dim: Number(env("EMBED_DIM", "1024")),
    batchSize: 10, // 百炼限制单批 10 条，稳妥起见小批
  };
}

/** 自检用：不抛错，返回缺失项列表 */
export function checkEnv(): { ok: boolean; missing: string[]; warns: string[] } {
  const missing: string[] = [];
  const warns: string[] = [];
  for (const k of ["LLM_BASE_URL", "LLM_API_KEY"]) {
    if (!env(k)) missing.push(k);
  }
  if (!env("EMBED_API_KEY") && !env("LLM_API_KEY")) missing.push("EMBED_API_KEY");
  // FAST_* 缺失时 reason/extract/fast 会回退到 qwen 的地址与 Key，但模型名仍是 deepseek-*，
  // 对端会 400。与其等用户提问才炸，不如启动就提示。
  const usesDeepseek =
    /^deepseek/i.test(env("MODEL_REASON", "deepseek-reasoner")) ||
    /^deepseek/i.test(env("MODEL_EXTRACT", "deepseek-chat")) ||
    /^deepseek/i.test(env("MODEL_FAST", "deepseek-chat"));
  if (usesDeepseek && !env("FAST_API_KEY")) {
    warns.push(
      "MODEL_* 指向 deepseek-*，但 FAST_API_KEY / FAST_BASE_URL 未设置 —— 请求会回退到 qwen 并 400（见 模型应用.md）",
    );
  }
  if (!env("AGGREGATOR_URL")) {
    warns.push("AGGREGATOR_URL 未设置 —— 纯本地模式，不会向教师端发送任何数据");
  }
  return { ok: missing.length === 0, missing, warns };
}
