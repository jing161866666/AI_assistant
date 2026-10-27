import { useCallback, useRef, useState } from "react";

interface Item {
  id: string;
  dataUrl: string;
  status: "extracting" | "done" | "error";
  text?: string;
  error?: string;
  ms?: number;
}

/** 压缩到最长边 1600px 的 JPEG，避免 base64 过大 */
async function compress(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const maxSide = 1600;
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("浏览器不支持 canvas");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}

export default function ImageInput({
  kind,
  label,
  onText,
  onImages,
}: {
  kind: "question" | "answer";
  label: string;
  onText: (text: string) => void;
  onImages: (urls: string[]) => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const sync = useCallback(
    (next: Item[]) => {
      setItems(next);
      onImages(next.filter((i) => i.status === "done").map((i) => i.dataUrl));
      const texts = next.filter((i) => i.status === "done" && i.text).map((i) => i.text as string);
      if (texts.length > 0) onText(texts.join("\n\n---\n\n"));
    },
    [onImages, onText],
  );

  const addFiles = useCallback(
    async (files: File[]) => {
      const imgs = files.filter((f) => f.type.startsWith("image/"));
      if (imgs.length === 0) return;
      setBusy(true);
      const added: Item[] = [];
      for (const f of imgs.slice(0, 4)) {
        try {
          const dataUrl = await compress(f);
          added.push({ id: `${Date.now()}-${added.length}`, dataUrl, status: "extracting" });
        } catch {
          /* 跳过无法读取的文件 */
        }
      }
      let cur = [...items, ...added];
      sync(cur);

      for (const it of added) {
        try {
          const res = await fetch("/api/extract-image", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image: it.dataUrl, kind }),
          });
          const j = (await res.json()) as {
            ok?: boolean;
            text?: string;
            error?: string;
            ms?: number;
          };
          if (!res.ok || !j.ok) throw new Error(j.error ?? "识别失败");
          cur = cur.map((x) =>
            x.id === it.id ? { ...x, status: "done", text: j.text ?? "", ms: j.ms } : x,
          );
        } catch (e) {
          cur = cur.map((x) =>
            x.id === it.id ? { ...x, status: "error", error: (e as Error).message } : x,
          );
        }
        sync(cur);
      }
      setBusy(false);
    },
    [items, kind, sync],
  );

  const remove = (id: string): void => {
    sync(items.filter((i) => i.id !== id));
  };

  return (
    <div className="imginput">
      <button
        type="button"
        className={`drop${drag ? " drag" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          void addFiles([...e.dataTransfer.files]);
        }}
        onPaste={(e) => {
          const files = [...e.clipboardData.items]
            .filter((i) => i.kind === "file")
            .map((i) => i.getAsFile())
            .filter((f): f is File => f !== null);
          if (files.length > 0) {
            e.preventDefault();
            void addFiles(files);
          }
        }}
        onClick={() => inputRef.current?.click()}
        title="点击选择图片，或把图片拖进来，或先点这里再 Ctrl+V 粘贴截图"
      >
        <span className="ico">🖼</span>
        <span>
          {label} · 点击选图 / 拖入 / <b>Ctrl+V 粘贴截图</b>
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          void addFiles([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />

      {items.length > 0 && (
        <div className="thumbs">
          {items.map((it) => (
            <figure className="thumb" key={it.id}>
              <img src={it.dataUrl} alt="已上传题目" />
              <button type="button" className="x" onClick={() => remove(it.id)} title="移除">
                ×
              </button>
              <figcaption className={`st ${it.status}`}>
                {it.status === "extracting" && "识别中…"}
                {it.status === "done" && `已识别 ${it.text?.length ?? 0} 字`}
                {it.status === "error" && (it.error ?? "失败")}
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      {busy && <p className="imgnote">正在调用视觉模型读图（公式转 LaTeX、图形转文字描述）…</p>}
    </div>
  );
}
