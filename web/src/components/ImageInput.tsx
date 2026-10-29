import { useCallback, useEffect, useRef, useState } from "react";

interface Item {
  id: string;
  dataUrl: string;
  status: "extracting" | "done" | "error";
  text?: string;
  error?: string;
  ms?: number;
}

/**
 * 已上传图片的会话级缓存。
 *
 * 图片是 base64（压缩后仍有几百 KB），不能进 localStorage——
 * 几张就把 5 MB 配额吃掉，反而连文本草稿都存不进去。
 * 放模块级 Map 里：切页签不丢，刷新浏览器才重新上传。
 */
const memoItems = new Map<string, Item[]>();

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
  active = true,
  onActivate,
  storageKey,
}: {
  kind: "question" | "answer";
  label: string;
  onText: (text: string) => void;
  onImages: (urls: string[]) => void;
  /** 是否为当前「粘贴目标」。同页面有题目图和作答图两个输入框，只能有一个接管 Ctrl+V */
  active?: boolean;
  onActivate?: () => void;
  /** 给了就在切页签后恢复已上传的图（仅内存，刷新即失） */
  storageKey?: string;
}) {
  const [items, setItemsState] = useState<Item[]>(() =>
    storageKey ? (memoItems.get(storageKey) ?? []) : [],
  );
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  /** 所有对 items 的改动都走这里，顺手写进会话缓存 */
  const setItems = useCallback(
    (next: Item[]) => {
      setItemsState(next);
      if (storageKey) memoItems.set(storageKey, next);
    },
    [storageKey],
  );

  const sync = useCallback(
    (next: Item[]) => {
      setItems(next);
      onImages(next.filter((i) => i.status === "done").map((i) => i.dataUrl));
      const texts = next.filter((i) => i.status === "done" && i.text).map((i) => i.text as string);
      if (texts.length > 0) onText(texts.join("\n\n---\n\n"));
    },
    [setItems, onImages, onText],
  );

  // 挂载时把上次的图片补回父组件；文字不回填——父组件的题目文本已单独持久化，再回填会重复
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在挂载时补一次
  useEffect(() => {
    if (!storageKey) return;
    const saved = memoItems.get(storageKey);
    const urls = (saved ?? []).filter((i) => i.status === "done").map((i) => i.dataUrl);
    if (urls.length > 0) onImages(urls);
  }, []);

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

  /**
   * 截图粘贴：监听整页的 paste，而不是只在按钮上监听。
   * 之前绑在按钮上，用户必须先把焦点点进按钮才生效，实际体验就是「粘贴不了」。
   */
  useEffect(() => {
    if (!active) return;
    const onPaste = (e: ClipboardEvent): void => {
      const dt = e.clipboardData;
      if (!dt) return;
      const files = [...dt.items]
        .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
        .map((i) => i.getAsFile())
        .filter((f): f is File => f !== null);
      if (files.length === 0) return;
      // 在文本框里粘文字、且剪贴板确实带文字时，尊重文本输入，不抢这一下
      const el = e.target as HTMLElement | null;
      const typing = el?.tagName === "TEXTAREA" || el?.tagName === "INPUT";
      if (typing && dt.getData("text/plain").trim().length > 0) return;
      e.preventDefault();
      void addFiles(files);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [active, addFiles]);

  return (
    <div className="imginput">
      <button
        type="button"
        className={`drop${drag ? " drag" : ""}${active ? " active" : ""}`}
        onFocus={() => onActivate?.()}
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
        onClick={() => {
          onActivate?.();
          inputRef.current?.click();
        }}
        title="点击选择图片，或把图片拖进来，或直接 Ctrl+V 粘贴截图"
      >
        <span className="ico">🖼</span>
        <span>
          {label} · 点击选图 / 拖入 / <b>直接 Ctrl+V 粘贴截图</b>
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
