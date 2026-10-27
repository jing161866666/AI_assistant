import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { paths } from "../db/index.js";
import { llm } from "../llm/client.js";
import { getLlmConfig } from "../llm/models.js";

/**
 * 题目 / 答案的图片识别。
 *
 * 为什么不用传统 OCR：
 *  - 公式会被拆成零散字符或直接变成图片，OCR 后无法还原
 *  - 物理题的示意图（光路、受力、电路、波形）在 OCR 里完全丢失
 * 因此直接用多模态模型读图，并强制它把图形写成可计算的文字描述。
 */

const EXTRACT_PROMPT = `你是把题目图片转成"可计算文本"的转录员。只转录，绝对不要解题。

输出要求：
1. 按原顺序完整抄录图片中的文字，不要概括、不要省略。
2. 所有数学/物理公式必须用 LaTeX 写出，行内用 $...$，独立成行用 $$...$$。
   上下标、矢量、积分号、矩阵都要还原，不要保留图片形式。
3. 图（光路图、受力分析图、电路图、波形图、几何示意图、坐标轴）用如下格式标注：
   【图：详细描述】
   描述必须包含四件事：
   (a) 图中有哪些对象（几次透/反射、哪几个点、哪几个元件）
   (b) 几何关系与角度、长度标注的值与单位
   (c) 坐标轴、正方向、参考面、入射/出射方向
   (d) 哪些量是已知的、哪些量待求
4. 如果图片是表格，转成 Markdown 表格。
5. 若图片模糊导致某处无法辨认，用 【不确定：xxx】 标出，不要猜。
6. 不要输出任何解题思路、答案或评价。

现在开始转录。`;

export interface ExtractResult {
  text: string;
  model: string;
  ms: number;
  artifactId: number | null;
}

const DATA_URL_RE = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/;

export function parseDataUrl(dataUrl: string): { mime: string; buffer: Buffer } {
  const m = DATA_URL_RE.exec(dataUrl.trim());
  if (!m) throw new Error("图片格式不支持，请用 png / jpg / webp");
  const mime = `image/${m[1] === "jpg" ? "jpeg" : m[1]}`;
  const buffer = Buffer.from(m[2]!, "base64");
  if (buffer.length === 0) throw new Error("图片为空");
  if (buffer.length > 8 * 1024 * 1024) throw new Error("图片超过 8MB，请压缩后重试");
  return { mime, buffer };
}

/** 落盘 + 记 artifact，满足"原始文件永不删" */
function persist(db: DatabaseSync, buffer: Buffer, mime: string, kind: string): number {
  mkdirSync(paths.uploads, { recursive: true });
  const sha = createHash("sha256").update(buffer).digest("hex");
  const ext = mime === "image/jpeg" ? "jpg" : mime.split("/")[1];
  const name = `${kind}-${sha.slice(0, 12)}.${ext}`;
  const full = join(paths.uploads, name);
  try {
    writeFileSync(full, buffer, { flag: "wx" });
  } catch {
    /* 已存在则复用 */
  }
  const exist = db.prepare("SELECT id FROM artifact WHERE sha256 = ? LIMIT 1").get(sha) as
    | { id: number }
    | undefined;
  if (exist) return exist.id;
  const r = db
    .prepare(
      "INSERT INTO artifact (kind, filename, path, sha256, bytes, parsed) VALUES (?,?,?,?,?,1)",
    )
    .run("image", name, full, sha, buffer.length);
  return Number(r.lastInsertRowid);
}

export async function extractImage(
  db: DatabaseSync,
  dataUrl: string,
  kind: "question" | "answer" = "question",
): Promise<ExtractResult> {
  const t0 = Date.now();
  const { mime, buffer } = parseDataUrl(dataUrl);
  const artifactId = persist(db, buffer, mime, kind);
  const cfg = getLlmConfig("vision");

  const r = await llm("vision").chat.completions.create({
    model: cfg.model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: EXTRACT_PROMPT },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    max_tokens: 3000,
    temperature: 0,
  });

  const text = (r.choices[0]?.message?.content ?? "").trim();
  if (!text) throw new Error("识别结果为空，换一张更清晰的图试试");

  db.prepare("INSERT INTO event (type, ref_type, ref_id, payload) VALUES (?,?,?,?)").run(
    "image_extract",
    "artifact",
    artifactId,
    JSON.stringify({ kind, chars: text.length, ms: Date.now() - t0 }),
  );

  return { text, model: cfg.model, ms: Date.now() - t0, artifactId };
}
