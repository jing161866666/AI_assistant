import OpenAI from "openai";
import { getEmbedConfig, getLlmConfig, type ModelRole } from "./models.js";

const cache = new Map<string, OpenAI>();

function client(baseUrl: string, apiKey: string): OpenAI {
  const key = `${baseUrl}|${apiKey}`;
  let c = cache.get(key);
  if (!c) {
    // maxRetries 覆盖 429 限流：百炼对部分模型 RPM 较低，SDK 内建退避重试
    c = new OpenAI({ baseURL: baseUrl, apiKey, timeout: 120_000, maxRetries: 4 });
    cache.set(key, c);
  }
  return c;
}

export function llm(role: Exclude<ModelRole, "embed">): OpenAI {
  const cfg = getLlmConfig(role);
  return client(cfg.baseUrl, cfg.apiKey);
}

export function embeddingClient(): OpenAI {
  const cfg = getEmbedConfig();
  return client(cfg.baseUrl, cfg.apiKey);
}

/** Float32Array ↔ Buffer，向量入库出库的统一格式 */
export function vecToBlob(v: number[]): Buffer {
  const f = Float32Array.from(v);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

export function blobToVec(b: Uint8Array, dim: number): Float32Array {
  const copy = new Uint8Array(b); // 保证字节对齐
  return new Float32Array(copy.buffer, 0, dim);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
