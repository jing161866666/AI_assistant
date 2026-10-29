import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { ROOT } from "../db/index.js";

/**
 * 课程资料目录约定。
 *
 *   课程/<课程简称>/
 *     教材/     教科书、讲义（docx / pdf / md / txt）
 *     参考书/   习题解答、参考教材
 *     课件/     PPT / PDF 课件
 *     题库/     按题切的题库（docx）
 *
 * 约定只有一条：**文件夹名就是课程简称**。简称与课表课程名的对应由模型判断
 * （src/course/match.ts），不要在这里写死映射。
 *
 * 不支持的旧格式（.doc / .ppt）不静默跳过：列进 unsupported，建库时报警，
 * 交给用户转成 .docx/.pptx 或安装 LibreOffice。
 */

export const COURSE_ROOT = resolve(ROOT, "课程");

export type MaterialKind = "textbook" | "slides" | "reference" | "bank";

const DIR_KIND: Record<string, MaterialKind> = {
  教材: "textbook",
  参考书: "reference",
  参考资料: "reference",
  课件: "slides",
  题库: "bank",
};

export const KIND_LABEL: Record<MaterialKind, string> = {
  textbook: "教材",
  slides: "课件",
  reference: "参考书",
  bank: "题库",
};

/** 能直接抽文字的格式 */
const TEXT_EXT = new Set([".docx", ".pdf", ".md", ".txt", ".pptx"]);
/** 旧二进制格式：需要先转换，不冒充能读 */
const LEGACY_EXT = new Set([".doc", ".ppt"]);

export interface MaterialFile {
  kind: MaterialKind;
  /** 绝对路径 */
  path: string;
  /** 文件名（不含目录） */
  name: string;
  ext: string;
  bytes: number;
}

export interface CourseMaterials {
  /** 课程简称 = 文件夹名 */
  folder: string;
  dir: string;
  files: MaterialFile[];
  /** 抽不了字的文件（.doc/.ppt 或其它格式），必须报给用户 */
  unsupported: MaterialFile[];
  /** 子目录是否齐全（缺了不报错，只是建不出对应内容） */
  has: Record<MaterialKind, boolean>;
}

export function listCourseFolders(): string[] {
  if (!existsSync(COURSE_ROOT)) return [];
  return readdirSync(COURSE_ROOT)
    .filter((name) => {
      try {
        return statSync(join(COURSE_ROOT, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.localeCompare(b, "zh-CN"));
}

/** 扫描一个课程文件夹，按子目录归类 */
export function scanCourseMaterials(folder: string): CourseMaterials {
  const dir = resolve(COURSE_ROOT, folder);
  if (!existsSync(dir)) throw new Error(`课程文件夹不存在：${dir}`);

  const files: MaterialFile[] = [];
  const unsupported: MaterialFile[] = [];
  const has: Record<MaterialKind, boolean> = {
    textbook: false,
    slides: false,
    reference: false,
    bank: false,
  };

  /* recursive: the nearest dir named cailiao/cankaoshu/kejian/tiku decides the kind;
     volume dirs (dawushang/dawuxia) are just containers */
  const walk = (dirPath: string, kind: MaterialKind | null): void => {
    for (const name of readdirSync(dirPath)) {
      if (name.startsWith("~$")) continue; // Word 锁文件/临时文件
      const full = join(dirPath, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        const nextKind = DIR_KIND[name] ?? kind;
        if (DIR_KIND[name]) has[DIR_KIND[name]] = true;
        walk(full, nextKind);
        continue;
      }
      if (!st.isFile() || !kind) continue;
      const ext = extname(name).toLowerCase();
      const item: MaterialFile = { kind, path: full, name, ext, bytes: st.size };
      if (TEXT_EXT.has(ext)) files.push(item);
      else if (LEGACY_EXT.has(ext)) unsupported.push(item);
    }
  };
  walk(dir, null);
  return { folder, dir, files, unsupported, has };
}

/** 读一个资料的纯文本；不支持的格式直接抛错（不返回空串冒充成功） */
export async function readMaterialText(file: MaterialFile): Promise<string> {
  if (file.ext === ".docx") {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: readFileSync(file.path) });
    return value;
  }
  if (file.ext === ".pptx") {
    // pptx 就是 zip：按 slide 顺序抽 <a:t> 文本，公式/图片会被跳过（只做检索用）
    const jszip = await import("jszip");
    const zip = await jszip.default.loadAsync(readFileSync(file.path));
    const slides = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(a.match(/(\d+)/)?.[1] ?? 0) - Number(b.match(/(\d+)/)?.[1] ?? 0));
    const parts: string[] = [];
    for (const n of slides) {
      const xml = await zip.files[n]!.async("string");
      const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1] ?? ""));
      if (texts.length > 0) parts.push(texts.join(" "));
    }
    return parts.join("\n");
  }
  if (file.ext === ".pdf") {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const data = new Uint8Array(readFileSync(file.path));
    const doc = await pdfjs.getDocument({ data }).promise;
    const pages: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      pages.push(
        content.items
          .map((it) => ("str" in it ? it.str : ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim(),
      );
    }
    return pages.join("\n");
  }
  if (file.ext === ".md" || file.ext === ".txt") {
    return readFileSync(file.path, "utf8");
  }
  throw new Error(`不支持直接抽字的格式：${basename(file.path)}（先转成 .docx/.pdf/.pptx）`);
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)));
}
