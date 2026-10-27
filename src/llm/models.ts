/**
 * 四个模型角色必须分开用。
 * 一个模型全包会导致：抽取慢且贵、视觉不可用、嵌入缺失。
 * 这里把角色与具体模型名解耦，换供应商只改 .env。
 */

export type ModelRole = "reason" | "extract" | "vision" | "embed";

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
  const shared = {
    baseUrl: require("LLM_BASE_URL"),
    apiKey: require("LLM_API_KEY"),
  };
  switch (role) {
    case "reason":
      return {
        ...shared,
        model: env("MODEL_REASON", "qwen-max"),
        maxTokens: 4096,
        temperature: 0.3, // 解答题目要稳，不要发挥
      };
    case "extract":
      return {
        ...shared,
        model: env("MODEL_EXTRACT", "qwen-turbo"),
        maxTokens: 1024,
        temperature: 0, // 结构化抽取必须确定性
      };
    case "vision":
      return {
        ...shared,
        model: env("MODEL_VISION", "qwen-vl-max"),
        maxTokens: 2048,
        temperature: 0.1,
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
  if (!env("AGGREGATOR_URL")) {
    warns.push("AGGREGATOR_URL 未设置 —— 纯本地模式，不会向教师端发送任何数据");
  }
  return { ok: missing.length === 0, missing, warns };
}
